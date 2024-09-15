import differentialToFullDataset from 'gtfs-rt-differential-to-full-dataset'
import {performance} from 'node:perf_hooks'
import throttle from 'lodash/throttle.js'
import {createLogger} from './lib/logger.js'
import {
	connectToNats,
} from './lib/nats.js'

const serveGtfsRtDataFromNats = async (cfg, opt = {}) => {
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
	const updateFeed = throttle(() => {
		feed = differentialToFull.asFeedMessage()
	}, 100)
	differentialToFull.on('change', updateFeed)
	setImmediate(updateFeed)

	const {
		natsClient,
	} = await connectToNats({
		logger,
	}, natsOpts)
	// todo: warn-log publish failures?

	const stop = async () => {
		await natsClient.close()
	}

	return {
		stop,
	}
}

export {
	serveGtfsRtDataFromNats,
}
