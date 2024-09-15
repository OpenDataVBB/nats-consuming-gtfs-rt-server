import {ok} from 'node:assert'
import {createServer} from 'node:http'
import differentialToFullDataset from 'gtfs-rt-differential-to-full-dataset'
import {performance} from 'node:perf_hooks'
import throttle from 'lodash/throttle.js'
import computeEtag from 'etag'
import pick from 'lodash/pick.js'
import serveBuffer from 'serve-buffer'
import {createLogger} from './lib/logger.js'
import {
	connectToNats,
} from './lib/nats.js'

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
	} = {
		natsOpts: {},
		...opt,
	}

	// todo: DRY with lib/serve.js in derhuerst/hafas-gtfs-rt-feed

	const logger = createLogger('nats-consuming-gtfs-rt-server')

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
		etag = computeEtag(feed) // todo: add computation time as metric
	}, 100)
	differentialToFull.on('change', updateFeed)
	setImmediate(updateFeed)

	const respondWithFeed = (req, res) => {
		serveBuffer(req, res, feed, {
			timeModified,
			etag,
			zstdCompress: true,
			unmutatedBuffers: true,
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

	const {
		natsClient,
	} = await connectToNats({
		logger,
	}, natsOpts)
	// todo: warn-log publish failures?

	const httpServer = createServer(onRequest)
	await new Promise((resolve, reject) => {
		httpServer.listen(port, (err) => {
			if (err) reject(err)
			else resolve()
		})
	})
	logger.info(`serving GTFS-RT feed on port ${port}`)

	const stop = async () => {
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
