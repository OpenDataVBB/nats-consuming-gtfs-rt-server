import {ok, strictEqual} from 'node:assert'
import {createServer} from 'node:http'
import {Counter, Summary, Gauge} from 'prom-client'
import _bs58 from 'bs58'
const {encode: encodeBase58} = _bs58
import {
	gtfsRtDifferentialToFullDataset,
} from 'gtfs-rt-differential-to-full-dataset'
import {performance} from 'node:perf_hooks'
import throttle from 'lodash/throttle.js'
import computeEtag from 'etag'
import pick from 'lodash/pick.js'
import serveBuffer from 'serve-buffer'
import maxBy from 'lodash/maxBy.js'
import {
	asyncConsume,
	execPipe,
	asyncMap,
} from 'iter-tools'
import {MAJOR_VERSION} from './lib/major-version.js'
import {createLogger} from './lib/logger.js'
import {createMetricsServer, register as metricsRegister} from './lib/metrics.js'
import {
	formatFeedContentType,
	negotiateFeedAggregator,
} from './lib/content-negotiation.js'
import {parseNatsMsgSubject} from './lib/gtfs-rt-mqtt-topics.js'
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
		scheduleFeedVersion: defaultScheduleFeedVersion,
		scheduleFeedSha256: defaultScheduleFeedSha256,
		natsOpts,
		natsConsumerName,
		natsConsumerMaxPullBatch,
		// shiftTimesToEnsureGaps: shouldShiftTimesToEnsureGaps,
		differentialEntitiesTtl,
		t0,
	} = {
		// todo [breaking]: rename to e.g. `defaultScheduleFeedVersion` or remove this option entirely
		scheduleFeedVersion: process.env.GTFS_FEED_VERSION || null,
		// todo [breaking]: rename to e.g. `defaultScheduleFeedSha256` or remove this option entirely
		scheduleFeedSha256: process.env.GTFS_FEED_SHA256 || null,
		natsOpts: {},
		natsConsumerName: process.env.GTFS_RT_CONSUMER_NAME
			? process.env.GTFS_RT_CONSUMER_NAME
			: 'nats-consuming-gtfs-rt-server',
		natsConsumerMaxPullBatch: process.env.GTFS_RT_CONSUMER_MAX_PULL_BATCH
			? parseInt(process.env.GTFS_RT_CONSUMER_MAX_PULL_BATCH)
			: null,
		// shiftTimesToEnsureGaps: false,
		differentialEntitiesTtl: process.env.GTFS_RT_DIFFERENTIAL_ENTITIES_TTL
			? process.env.GTFS_RT_DIFFERENTIAL_ENTITIES_TTL
			: 10 * 60 * 1000, // 10m
		t0: Date.now() / 1000 | 0,
		...opt,
	}
	if (defaultScheduleFeedVersion !== null) {
		strictEqual(typeof defaultScheduleFeedVersion, 'string', 'opt.scheduleFeedVersion must be a string')
		ok(defaultScheduleFeedVersion, 'opt.scheduleFeedVersion must not be empty')
	}
	if (defaultScheduleFeedSha256 !== null) {
		strictEqual(typeof defaultScheduleFeedSha256, 'string', 'opt.scheduleFeedSha256 must be a string')
		ok(defaultScheduleFeedSha256, 'opt.scheduleFeedSha256 must not be empty')
		ok(/^[0-9a-f]+$/.test(defaultScheduleFeedSha256), 'opt.scheduleFeedSha256 must be hex only')
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
			'feed_digest', // first byte of the SHA256 digest
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
			'feed_digest', // first byte of the SHA256 digest
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
		labelNames: [
			'feed_digest', // first byte of the SHA256 digest
		],
	})
	// todo [breaking]: remove in favor of `nats_nr_of_msgs_received_total`
	const receivedFromNatsTotal = new Counter({
		name: 'received_from_nats_total',
		help: 'no. of TripUpdates received from NATS',
		registers: [metricsRegister],
		labelNames: [
			'feed_digest', // first byte of the SHA256 digest
		],
	})

	const digestTime = new Summary({
		name: 'digest_time_seconds',
		help: 'time needed to add a TripUpdate into the GTFS-RT feed',
		registers: [metricsRegister],
		labelNames: [
			'feed_digest', // first byte of the SHA256 digest
		],
	})
	const feedSize = new Gauge({
		name: 'feed_size_raw_bytes',
		help: 'size of the final GTFS-RT feed',
		registers: [metricsRegister],
		labelNames: [
			'feed_digest', // first byte of the SHA256 digest
			'compression',
		],
	})
	const feedEntitiesTotal = new Gauge({
		name: 'feed_entities_total',
		help: 'number of entities in the feed',
		registers: [metricsRegister],
		labelNames: [
			'feed_digest', // first byte of the SHA256 digest
			// todo: by hash(route_name)?
		],
	})
	const feedRequestsTotal = new Gauge({
		name: 'feed_requests_total',
		help: 'how often the GTFS-RT feed has been HTTP-requested',
		registers: [metricsRegister],
		labelNames: [
			'feed_digest', // first byte of the SHA256 digest
			// todo: by compression method?
		],
	})

	const timeStarted = Date.now()
	const _getTimestamp = () => {
		const timePassed = (Date.now() - timeStarted) / 1000 | 0
		return t0 + timePassed
	}

	const _createScheduleFeedAggregator = (cfg) => {
		const {
			scheduleFeedSha256,
			scheduleFeedVersion,
		} = cfg

		let scheduleFeedVersionBase58 = null
		if (scheduleFeedVersion !== null) {
			scheduleFeedVersionBase58 = encodeBase58(Buffer.from(scheduleFeedVersion, 'utf8'))
		}

		const metricsLabels = {}
		if (scheduleFeedSha256 !== null) {
			// Note: Prometheus stores time series per combination of label values, so having labels with a high or even unbound cardinality is a problem. We still want to be able to tell the schedule databases' metrics apart in the monitoring system, so we add the first hex digit (with a cardinality of 16) of the GTFS Schedule feed's hash as a label.
			// see also https://www.robustperception.io/cardinality-is-key/
			metricsLabels.feed_digest = scheduleFeedSha256[0]
		}

		const contentType = formatFeedContentType(scheduleFeedSha256, scheduleFeedVersion, scheduleFeedVersionBase58)

		const differentialToFull = gtfsRtDifferentialToFullDataset({
			ttl: differentialEntitiesTtl,
			// todo: debug-log when entities have already expired while being added
			timestamp: _getTimestamp,
		})
		if (scheduleFeedVersion !== null) {
			differentialToFull.setFeedVersion(scheduleFeedVersion)
		}

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
		let nrOfEntities = 0
		const updateFeed = throttle(() => {
			feed = differentialToFull.asFeedMessage()
			timeModified = new Date()
			nrOfEntities = differentialToFull.nrOfEntities()

			// update metrics
			feedSize.set({
				...metricsLabels,
				compression: 'none',
			}, feed.length)
			feedEntitiesTotal.set({
				...metricsLabels,
			}, nrOfEntities)
			etag = computeEtag(feed) // todo: add computation time as metric
		}, 100)
		differentialToFull.on('change', updateFeed)
		setImmediate(updateFeed)

		const onFeedCompressed = (compression, compressedFeed, _) => {
			feedSize.set({
				...metricsLabels,
				compression,
			}, compressedFeed.length)
		}
		const respondWithFeed = (req, res) => {
			feedRequestsTotal.inc({
				...metricsLabels,
			})
			// todo: set Link header with license?

			// https://protobuf.dev/reference/protobuf/mime-types/
			// > When binary protos are transacted over HTTP, Protobuf strongly recommends […] setting `X-Content-Type-Options: nosniff` to prevent XSS, as it is possible for a Protobuf to parse as active content.
			res.setHeader('X-Content-Type-Options', 'nosniff')

			serveBuffer(req, res, feed, {
				contentType,
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

		return {
			scheduleFeedSha256,
			scheduleFeedVersion,
			scheduleFeedVersionBase58,
			metricsLabels,
			getTimeModified: () => timeModified,
			getEtag: () => etag,
			getNrOfEntities: () => nrOfEntities,
			processTripUpdate,
			respondWithFeed,
		}
	}

	const _defaultFeedAggregator = _createScheduleFeedAggregator({
		scheduleFeedSha256: defaultScheduleFeedSha256,
		scheduleFeedVersion: defaultScheduleFeedVersion,
	})
	// note: The two maps might contain overlapping instances.
	// note: We assume that for each feed digest, there's only ever exactly one feed version, and vice versa.
	// todo: this is ugly, especially because there's only ever `feed version -n--1-> feed digest`
	const _feedAggregatorsByScheduleFeedSha256 = new Map([ // scheduleFeedSha256 -> feedAggregator
		[defaultScheduleFeedSha256, _defaultFeedAggregator],
	])
	const _feedAggregatorsByScheduleFeedVersion = new Map([ // scheduleFeedVersion -> feedAggregator
		[defaultScheduleFeedVersion, _defaultFeedAggregator],
	])
	let latestFeedAggregator = _defaultFeedAggregator
	let _latestFeedAggregatorTimeModified = _defaultFeedAggregator.getTimeModified()

	const addFeedAggregator = (scheduleFeedSha256, scheduleFeedVersion) => {
		logger.info({
			scheduleFeedSha256,
			scheduleFeedVersion,
		}, 'creating new feed aggregator')
		const feedAggregator = _createScheduleFeedAggregator({
			scheduleFeedSha256,
			scheduleFeedVersion,
		})
		if (scheduleFeedSha256 !== null) {
			_feedAggregatorsByScheduleFeedSha256.set(scheduleFeedSha256, feedAggregator)
		}
		if (scheduleFeedVersion !== null) {
			_feedAggregatorsByScheduleFeedVersion.set(scheduleFeedVersion, feedAggregator)
		}
		return feedAggregator
	}

	const feedAggregatorsTtl = differentialEntitiesTtl // todo: pick a different one?
	const _feedAggregatorsGCInterval = Math.min(10_000, Math.round(feedAggregatorsTtl / 10))
	const garbageCollectFeedAggregators = () => {
		logger.debug('garbage-collecting feed aggregators')
		const feedAggregators = new Set([
			..._feedAggregatorsByScheduleFeedSha256.values(),
			..._feedAggregatorsByScheduleFeedVersion.values(),
		])
		const now = Date.now() // todo: use _getTimestamp()
		for (const feedAggregator of feedAggregators) {
			if ((now - feedAggregator.getTimeModified()) <= feedAggregatorsTtl) {
				continue
			}
			if (feedAggregator.scheduleFeedSha256 === null && feedAggregator.scheduleFeedVersion === null) {
				continue
			}

			logger.info({
				scheduleFeedSha256: feedAggregator.scheduleFeedSha256,
				scheduleFeedVersion: feedAggregator.scheduleFeedVersion,
			}, 'garbage-collecting feed aggregator')
			if (feedAggregator.scheduleFeedSha256 !== null) {
				_feedAggregatorsByScheduleFeedSha256.delete(feedAggregator.scheduleFeedSha256)
			}
			if (feedAggregator.scheduleFeedVersion !== null) {
				_feedAggregatorsByScheduleFeedVersion.delete(feedAggregator.scheduleFeedVersion)
			}
			latestFeedAggregator = maxBy(
				Array.from(new Set([
					..._feedAggregatorsByScheduleFeedSha256,
					..._feedAggregatorsByScheduleFeedVersion,
				])),
				feedAggregator => feedAggregator.getTimeModified(),
			)
		}
	}
	const _feedAggregatorsGCTimer = setInterval(garbageCollectFeedAggregators, _feedAggregatorsGCInterval).unref()

	const getMatchingFeedAggregator = (scheduleFeedSha256, scheduleFeedVersion) => {
		let feedAggregator = null
		if (_feedAggregatorsByScheduleFeedSha256.has(scheduleFeedSha256)) {
			feedAggregator = _feedAggregatorsByScheduleFeedSha256.get(scheduleFeedSha256)
		} else if (_feedAggregatorsByScheduleFeedVersion.has(scheduleFeedVersion)) {
			feedAggregator = _feedAggregatorsByScheduleFeedVersion.get(scheduleFeedVersion)
		} else {
			return null
		}
		if (scheduleFeedSha256 !== null && scheduleFeedSha256 !== feedAggregator.scheduleFeedSha256) {
			return null
		}
		if (scheduleFeedVersion !== null && scheduleFeedVersion !== feedAggregator.scheduleFeedVersion) {
			return null
		}
		return feedAggregator
	}

	const onFeedRequest = (req, res, logCtx) => {
		logCtx = {
			...logCtx,
			timeModified: null, // set later
			etag: null, // set later
			scheduleFeedSha256: null, // set later
			scheduleFeedVersion: null, // set later
		}

		// content negotiation using scheduleFeedSha256 & scheduleFeedVersion
		res.setHeader('Vary', 'Content-Type') // todo: is this enough?
		const feedAggregator = negotiateFeedAggregator({
			requestHeaders: req.headers,
			defaultFeedAggregator: latestFeedAggregator,
			getMatchingFeedAggregator,
		})
		if (feedAggregator === null) { // no match!
			logger.trace(logCtx, 'content-type not acceptable, responding with list of feed aggregators')
			// todo: add metric?
			res.statusCode = 406 // Not Acceptable
			res.contentType = 'application/json'
			const feedAggregators = Array.from(new Set([
				..._feedAggregatorsByScheduleFeedSha256.values(),
				..._feedAggregatorsByScheduleFeedVersion.values(),
			]))
				.map((feedAggregator) => ({
					schedule_sha256: feedAggregator.scheduleFeedSha256,
					schedule_version: feedAggregator.scheduleFeedVersion,
					schedule_version_bs58: feedAggregator.scheduleFeedVersionBase58,
				}))
			res.end(JSON.stringify(feedAggregators))
			return;
		}

		logCtx.timeModified = feedAggregator.getTimeModified()
		logCtx.etag = feedAggregator.getEtag()
		logCtx.scheduleFeedSha256 = feedAggregator.scheduleFeedSha256
		logCtx.scheduleFeedVersion = feedAggregator.scheduleFeedVersion

		logger.trace(logCtx, 'serving feed')
		feedAggregator.respondWithFeed(req, res)
	}

	const onHttpRequest = (req, res) => {
		const logCtx = {
			req: pick(req, [
				'httpVersion',
				'method',
				'url',
				'headers',
			]),
		}

		const path = new URL(req.url, 'http://localhost').pathname
		if (path === '/') {
			onFeedRequest(req, res)
		} else if (path === '/health') {
			// todo: make this logic customisable
			// todo: adapt to *set of* feed versions
			const feedAggregator = _defaultFeedAggregator
			const timeModified = feedAggregator.getTimeModified()
			const nrOfEntities = feedAggregator.getNrOfEntities()
			const isHealthy = (
				(Date.now() - timeModified <= 5 * 60 * 1000) // 5m
				&& (nrOfEntities > 0) // todo: does this make sense?
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
		const {
			subject: subject,
			seq, // stream sequence, not consumer sequence
		} = msg
		const {
			stream,
			consumer,
		} = msg.info
		// todo: trace-log msg

		const _subject = parseNatsMsgSubject(subject)
		const {
			root: subjectRoot,
		} = _subject
		const scheduleFeedSha256 = _subject.scheduleFeedSha256 ?? defaultScheduleFeedSha256
		const scheduleFeedVersion = _subject.scheduleFeedVersion ?? defaultScheduleFeedVersion

		// todo: DRY with getMatchingFeedAggregator()
		let feedAggregator = null
		if (scheduleFeedSha256 === null && scheduleFeedVersion === null) {
			feedAggregator = _defaultFeedAggregator
		} else if (scheduleFeedSha256 !== null && _feedAggregatorsByScheduleFeedSha256.has(scheduleFeedSha256)) {
			feedAggregator = _feedAggregatorsByScheduleFeedSha256.get(scheduleFeedSha256)
			if (scheduleFeedVersion !== null && scheduleFeedVersion !== feedAggregator.scheduleFeedVersion) {
				return null
			}
		} else if (scheduleFeedVersion !== null && _feedAggregatorsByScheduleFeedVersion.has(scheduleFeedVersion)) {
			feedAggregator = _feedAggregatorsByScheduleFeedVersion.get(scheduleFeedVersion)
			if (scheduleFeedSha256 !== null && scheduleFeedSha256 !== feedAggregator.scheduleFeedSha256) {
				return null
			}
		} else {
			feedAggregator = addFeedAggregator(scheduleFeedSha256, scheduleFeedVersion)
		}

		// update NATS metrics
		const {
			metricsLabels,
		} = feedAggregator
		{
			// todo [breaking]: switch to "subject_root" to align with NATS terminology
			// We slice() to keep the cardinality low in case of a bug.
			const topic_root = subjectRoot.slice(0, 7)
			const redelivered = msg.info.redelivered ? '1' : '0'
			natsNrOfMessagesReceivedTotal.inc({
				...metricsLabels,
				stream, // name of the JetStream stream
				consumer, // name of the JetStream consumer
				topic_root,
				redelivered,
			})
			natsLatestMessageReceivedTimestampSeconds.set({
				...metricsLabels,
				stream, // name of the JetStream stream
				consumer, // name of the JetStream consumer
				topic_root,
				redelivered,
			}, tReceived / 1000)
			natsMsgSeq.set({
				...metricsLabels,
			}, seq)
			receivedFromNatsTotal.inc({
				...metricsLabels,
			})
		}

		const t0 = performance.now()

		const tripUpdate = msg.json(msg.data)
		feedAggregator.processTripUpdate(tripUpdate)

		// keep track of latest feed aggregator
		{
			const _tM = feedAggregator.getTimeModified()
			if (_tM > _latestFeedAggregatorTimeModified) {
				_latestFeedAggregatorTimeModified = _tM
				latestFeedAggregator = feedAggregator
			}
		}

		const processingTime = performance.now() - t0
		msg.ack()
		digestTime.observe({
			...metricsLabels,
		}, processingTime / 1000)
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

		// query details of the (externally created) NATS JetStream consumer
		const consumerInfo = await gtfsRtConsumer.info()
		{
			logger.debug({
				consumerInfo,
			}, 'using NATS JetStream consumer')
		}

		const gtfsRtSub = await gtfsRtConsumer.consume({
			max_messages: (natsConsumerMaxPullBatch !== null
				? natsConsumerMaxPullBatch
				: consumerInfo.config.max_batch ?? 100
			),
		})
		execPipe(
			gtfsRtSub,
			asyncMap(onNatsMsg),
			asyncConsume,
		).catch(abortWithError)
	}

	const httpServer = createServer(onHttpRequest)
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
		clearInterval(_feedAggregatorsGCTimer)
	}

	return {
		stop,
	}
}

export {
	serveGtfsRtDataFromNats,
}
