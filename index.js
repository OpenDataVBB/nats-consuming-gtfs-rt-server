import {ok} from 'node:assert'
import {createServer} from 'node:http'
import {Counter, Summary, Gauge} from 'prom-client'
import {
	gtfsRtDifferentialToFullDataset,
} from 'gtfs-rt-differential-to-full-dataset'
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
import {connectToNats} from './lib/nats.js'

// todo: DRY with OpenDataVBB/gtfs-rt-feed
const NATS_JETSTREAM_GTFSRT_STREAM_NAME = `GTFS_RT_${MAJOR_VERSION}`

// > enum Incrementality {
// > 	FULL_DATASET = 0;
// > 	DIFFERENTIAL = 1;
// > }
// https://gtfs.org/documentation/realtime/proto/
const INCREMENTALITY_DIFFERENTIAL = 1

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
		natsConsumerName,
		// shiftTimesToEnsureGaps: shouldShiftTimesToEnsureGaps,
		differentialEntitiesTtl,
		t0,
	} = {
		natsOpts: {},
		natsConsumerName: process.env.GTFS_RT_CONSUMER_NAME
			? process.env.GTFS_RT_CONSUMER_NAME
			: 'nats-consuming-gtfs-rt-server',
		// shiftTimesToEnsureGaps: false,
		differentialEntitiesTtl: process.env.GTFS_RT_DIFFERENTIAL_ENTITIES_TTL
			? process.env.GTFS_RT_DIFFERENTIAL_ENTITIES_TTL
			: 10 * 60 * 1000, // 10m
		t0: Date.now() / 1000 | 0,
		...opt,
	}
	ok(Number.isInteger(differentialEntitiesTtl), 'opt.differentialEntitiesTtl must be an integer')
	ok(Number.isInteger(t0), 'opt.t0 must be an integer')

	// todo: DRY with lib/serve.js in derhuerst/hafas-gtfs-rt-feed

	const logger = createLogger('nats-consuming-gtfs-rt-server')
	const abortWithError = (err) => {
		logger.error(err)
		process.exit(1)
	}

	// NATS-related metrics
	// Note: We mirror OpenDataVBB/gtfs-rt-feed's & vdv-453-nats-adapter's metrics here.
	const natsNrOfMessagesReceivedTotal = new Counter({
		name: 'nats_nr_of_msgs_received_total',
		help: 'number of messages received from NATS',
		registers: [metricsRegister],
		labelNames: [
			'stream', // name of the JetStream stream
			'consumer', // name of the JetStream consumer
			'topic_root', // first "segment" of the topic, e.g. `AUS` with `aus.istfahrt.foo.bar`
			'redelivered', // 1/0
		],
	})
	const natsLatestMessageReceivedTimestampSeconds = new Gauge({
		name: 'nats_latest_msg_received_timestamp_seconds',
		help: 'when the latest message has been received from NATS',
		registers: [metricsRegister],
		labelNames: [
			'stream', // name of the JetStream stream
			'consumer', // name of the JetStream consumer
			'topic_root', // first "segment" of the topic, e.g. `AUS` with `aus.istfahrt.foo.bar`
			'redelivered', // 1/0
		],
	})
	// NATS gives separate sequence numbers to both a) messages in a stream and b) messages as (re-)received by a consumer.
	// We currently use `msg.seq`, which is the stream sequence (not the consumer sequence) of the message.
	const natsMsgSeq = new Gauge({
		// todo [breaking]: rename to e.g. nats_latest_msg_received_seq for consistency
		name: 'nats_msg_seq',
		help: 'sequence number of the latest NATS message being processed',
		registers: [metricsRegister],
	})
	// todo [breaking]: remove in favor of `nats_nr_of_msgs_received_total`
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
	const feedEntitiesTotal = new Gauge({
		name: 'feed_entities_total',
		help: 'number of entities in the feed',
		registers: [metricsRegister],
	})
	const feedRequestsTotal = new Gauge({
		name: 'feed_requests_total',
		help: 'how often the GTFS-RT feed has been HTTP-requested',
		registers: [metricsRegister],
		// todo: by compression method?
	})

	const timeStarted = Date.now()
	// todo: pass in feed metadata, see https://github.com/google/transit/pull/434
	const differentialToFull = gtfsRtDifferentialToFullDataset({
		ttl: differentialEntitiesTtl,
		// todo: debug-log when entities have already expired while being added
		timestamp: () => {
			const timePassed = (Date.now() - timeStarted) / 1000 | 0
			return t0 + timePassed
		},
	})

	const processTripUpdate = (tripUpdate) => {
		const feedEntity = {
			id: String(t0 + performance.now()),
			trip_update: tripUpdate,
		}
		const feedMessage = {
			header: {
				gtfs_realtime_version: '2.0',
				incrementality: INCREMENTALITY_DIFFERENTIAL,
			},
			entity: [feedEntity],
		}
		differentialToFull.write(feedMessage)
		updateFeed()
	}

	let feed = Buffer.alloc(0)
	let timeModified = new Date(0)
	let etag = computeEtag(feed)
	const updateFeed = throttle(() => {
		feed = differentialToFull.asFeedMessage()
		timeModified = new Date()
		feedSize.set({compression: 'none'}, feed.length)
		feedEntitiesTotal.set(differentialToFull.nrOfEntities())
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
			gzipMaxSize: 20 * 1024 * 1024, // 20mb
			brotliCompressMaxSize: 3 * 1024 * 1024, // 3mb
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
		const tReceived = Date.now()
		// todo: trace-log msg

		// update NATS metrics
		{
			const {
				// todo: "subject" or "topic"? what is the canonical terminology?
				subject: topic,
				seq, // stream sequence, not consumer sequence
			} = msg
			const {
				stream,
				consumer,
			} = msg.info
			// We slice() to keep the cardinality low in case of a bug.
			const topic_root = (topic.split('.')[0] || '').slice(0, 7)
			const redelivered = msg.info.redelivered ? '1' : '0'
			natsNrOfMessagesReceivedTotal.inc({
				stream, // name of the JetStream stream
				consumer, // name of the JetStream consumer
				topic_root,
				redelivered,
			})
			natsLatestMessageReceivedTimestampSeconds.set({
				stream, // name of the JetStream stream
				consumer, // name of the JetStream consumer
				topic_root,
				redelivered,
			}, tReceived / 1000)
			natsMsgSeq.set(seq)
			receivedFromNatsTotal.inc()
		}

		const t0 = performance.now()

		const tripUpdate = msg.json(msg.data)
		processTripUpdate(tripUpdate)

		const processingTime = performance.now() - t0
		msg.ack()
		digestTime.observe(processingTime / 1000)
	}

	{
		const natsJetstreamClient = await natsClient.jetstream()

		{
			// query details of the (externally created) NATS JetStream stream for AUS IstFahrts
			const stream = await natsJetstreamClient.streams.get(NATS_JETSTREAM_GTFSRT_STREAM_NAME)
			const streamInfo = await stream.info()
			logger.debug({
				streamInfo,
			}, 'using NATS JetStream stream for GTFS-RT feedEntities')
		}

		const gtfsRtConsumer = await natsJetstreamClient.consumers.get(
			NATS_JETSTREAM_GTFSRT_STREAM_NAME,
			natsConsumerName,
		)

		{
			// query details of the (externally created) NATS JetStream consumer
			const consumerInfo = await gtfsRtConsumer.info()
			logger.debug({
				consumerInfo,
			}, 'using NATS JetStream consumer')
		}

		const gtfsRtSub = await gtfsRtConsumer.consume()
		execPipe(
			gtfsRtSub,
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
