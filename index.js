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

	const logger = createLogger('nats-consuming-gtfs-rt-server')

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
