import {ok} from 'node:assert'
import {createServer} from 'node:http'
import {Counter, Summary, Gauge} from 'prom-client'
import differentialToFullDataset from 'gtfs-rt-differential-to-full-dataset'
import {performance} from 'node:perf_hooks'
import throttle from 'lodash/throttle.js'
import computeEtag from 'etag'
import pick from 'lodash/pick.js'
import serveBuffer from 'serve-buffer'
import {
	asyncConsume,
	execPipe,
	asyncMap,
} from 'iter-tools'
import {MAJOR_VERSION} from './lib/major-version.js'
import {createLogger} from './lib/logger.js'
import {createMetricsServer, register as metricsRegister} from './lib/metrics.js'
import {
	connectToNats,
	AckPolicy as NatsAckPolicy,
	DeliverPolicy as NatsDeliverPolicy,
} from './lib/nats.js'

// todo: DRY with OpenDataVBB/gtfs-rt-feed
const NATS_JETSTREAM_GTFSRT_STREAM_NAME = `GTFS_RT_${MAJOR_VERSION}`

// todo: DRY with OpenDataVBB/gtfs-rt-feed
// https://github.com/OpenDataVBB/gtfs-rt-feed/blob/9bcc8e46945107e1a96d65f612df72c1404d2818/lib/gtfs-rt-mqtt-topics.js#L11
const GTFS_RT_TOPIC_PREFIX = 'gtfsrt.'

const respondToHealthcheck = (req, res, isHealthy) => {
	res.setHeader('cache-control', 'no-store')
	res.setHeader('expires', '0')
	res.setHeader('content-type', 'text/plain')
	// todo: respond with metrics used for health checking?
	if (isHealthy === true) {
		res.statusCode = 200
		res.end('healthy!')
	} else {
		res.statusCode = 503
		res.end('not healthy :(')
	}
}

const serveGtfsRtDataFromNats = async (cfg, opt = {}) => {
	const {
		port,
	} = cfg
	ok(Number.isInteger(port), 'cfg.port must be an integer')

	const {
		natsOpts,
		natsConsumerDurableName,
		natsConsumerTtl,
		// shiftTimesToEnsureGaps: shouldShiftTimesToEnsureGaps,
	} = {
		natsOpts: {},
		natsConsumerDurableName: process.env.MATCHING_CONSUMER_DURABLE_NAME
			? process.env.MATCHING_CONSUMER_DURABLE_NAME
			: NATS_JETSTREAM_GTFSRT_STREAM_NAME + '_' + Math.random().toString(16).slice(2, 6),
		natsConsumerTtl: 10 * 60 * 1000, // 10 minutes
		// shiftTimesToEnsureGaps: false,
		...opt,
	}
	ok(Number.isInteger(natsConsumerTtl), 'opt.natsConsumerTtl must be an integer')

	// todo: DRY with lib/serve.js in derhuerst/hafas-gtfs-rt-feed

	const logger = createLogger('nats-consuming-gtfs-rt-server')
	const abortWithError = (err) => {
		logger.error(err)
		process.exit(1)
	}

	const receivedFromNatsTotal = new Counter({
		name: 'received_from_nats_total',
		help: 'no. of TripUpdates received from NATS',
		registers: [metricsRegister],
	})
	const digestTime = new Summary({
		name: 'digest_time_seconds',
		help: 'time needed to add a TripUpdate into the GTFS-RT feed',
		registers: [metricsRegister],
	})
	const feedSize = new Gauge({
		name: 'feed_size_raw_bytes',
		help: 'size of the final GTFS-RT feed',
		registers: [metricsRegister],
		labelNames: ['compression'],
	})
	const feedRequestsTotal = new Gauge({
		name: 'feed_requests_total',
		help: 'how often the GTFS-RT feed has been HTTP-requested',
		registers: [metricsRegister],
		// todo: by compression method?
	})

	// todo: pass in feed metadata, see https://github.com/google/transit/pull/434
	const differentialToFull = differentialToFullDataset({
		ttl: 5 * 60 * 1000, // 5m
	})

	const t0 = Date.now()
	const processTripUpdate = (tripUpdate) => {
		const feedEntity = {
			id: String(t0 + performance.now()),
			trip_update: tripUpdate,
		}
		differentialToFull.write(feedEntity)
		updateFeed()
	}

	let feed = Buffer.alloc(0)
	let timeModified = new Date(0)
	let etag = computeEtag(feed)
	const updateFeed = throttle(() => {
		feed = differentialToFull.asFeedMessage()
		timeModified = new Date()
		feedSize.set({compression: 'none'}, feed.length)
		etag = computeEtag(feed) // todo: add computation time as metric
	}, 100)
	differentialToFull.on('change', updateFeed)
	setImmediate(updateFeed)

	const onFeedCompressed = (compression, compressedFeed, _) => {
		feedSize.set({compression}, compressedFeed.length)
	}
	const respondWithFeed = (req, res) => {
		feedRequestsTotal.inc()
		serveBuffer(req, res, feed, {
			timeModified,
			etag,
			gzipMaxSize: 10 * 1024 * 1024, // 10mb
			brotliCompressMaxSize: 2 * 1024 * 1024, // 2mb
			zstdCompress: true,
			zstdCompressMaxSize: 50 * 1024 * 1024, // 50mb
			unmutatedBuffers: true,
			onCompressed: onFeedCompressed,
		})
	}

	const onRequest = (req, res) => {
		const logCtx = {
			req: pick(req, [
				'httpVersion',
				'method',
				'url',
				'headers',
			]),
			timeModified,
			etag,
		}

		const path = new URL(req.url, 'http://localhost').pathname
		if (path === '/') {
			logger.trace(logCtx, 'serving feed')
			respondWithFeed(req, res)
		} else if (path === '/health') {
			// todo: make this logic customisable
			const isHealthy = (
				(Date.now() - timeModified <= 5 * 60 * 1000) // 5m
				&& (differentialToFull.nrOfEntities() > 0)
			)
			logger.debug({
				...logCtx,
				isHealthy,
			}, 'responding to health check')
			respondToHealthcheck(req, res, isHealthy)
		} else {
			res.statusCode = 404
			res.end('nope')
		}
	}

	const metricsServer = createMetricsServer()
	await metricsServer.start()
	logger.info(`serving Prometheus metrics on port ${metricsServer.address().port}`)

	const {
		natsClient,
	} = await connectToNats({
		logger,
	}, natsOpts)
	// todo: warn-log publish failures?

	const onNatsMsg = (msg) => {
		// todo: trace-log msg
		receivedFromNatsTotal.inc()
		const t0 = performance.now()

		const tripUpdate = msg.json(msg.data)
		processTripUpdate(tripUpdate)

		const processingTime = performance.now() - t0
		msg.ack()
		digestTime.observe(processingTime / 1000)
	}

	{
		const natsJetstreamManager = await natsClient.jetstreamManager()
		const natsJetstreamClient = await natsClient.jetstream()

		{
			// create/update NATS JetStream stream for GTFS-RT data
			const streamInfo = await natsJetstreamManager.streams.add({
				name: NATS_JETSTREAM_GTFSRT_STREAM_NAME,
				subjects: [
					GTFS_RT_TOPIC_PREFIX + '>',
				],
				// todo: limits?
			})
			logger.debug({
				streamInfo,
			}, 'created/re-used NATS JetStream stream')
		}

		// create durable NATS JetStream consumer for GTFS-RT stream
		const consumerInfo = await natsJetstreamManager.consumers.add(NATS_JETSTREAM_GTFSRT_STREAM_NAME, {
			ack_policy: NatsAckPolicy.Explicit,
			durable_name: natsConsumerDurableName,
			deliver_policy: NatsDeliverPolicy.New,
			inactive_threshold: natsConsumerTtl,
		})
		logger.debug({
			consumerInfo,
		}, 'created/re-used NATS JetStream consumer')

		const tripUpdatesConsumer = await natsJetstreamClient.consumers.get(NATS_JETSTREAM_GTFSRT_STREAM_NAME, consumerInfo.name)
		const tripUpdatesSub = await tripUpdatesConsumer.consume()
		execPipe(
			tripUpdatesSub,
			asyncMap(onNatsMsg),
			asyncConsume,
		).catch(abortWithError)
	}

	const httpServer = createServer(onRequest)
	await new Promise((resolve, reject) => {
		httpServer.listen(port, (err) => {
			if (err) reject(err)
			else resolve()
		})
	})
	logger.info(`serving GTFS-RT feed on port ${port}`)

	const stop = async () => {
		metricsServer.close()
		await natsClient.close()
		httpServer.close()
	}

	return {
		stop,
	}
}

export {
	serveGtfsRtDataFromNats,
}
