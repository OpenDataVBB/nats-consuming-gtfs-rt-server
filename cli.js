#!/usr/bin/env node

import {parseArgs} from 'node:util'
import {PREFIX as NATS_CLIENT_NAME_PREFIX} from './lib/nats.js'

// todo: use import assertions once they're supported by Node.js & ESLint
// https://github.com/tc39/proposal-import-assertions
import {createRequire} from 'node:module'
const require = createRequire(import.meta.url)
const pkg = require('./package.json')

const {
	values: flags,
} = parseArgs({
	options: {
		'help': {
			type: 'boolean',
			short: 'h',
		},
		'version': {
			type: 'boolean',
			short: 'v',
		},
		'nats-servers': {
			type: 'string',
		},
		'nats-user': {
			type: 'string',
		},
		'nats-client-name': {
			type: 'string',
		},
	},
	allowPositionals: true,
})

if (flags.help) {
	process.stdout.write(`
Usage:
    serve-gtfs-rt-from-nats [options]
Options:
	--nats-servers                NATS server(s) to connect to.
	                              Default: $NATS_SERVERS
	--nats-user                   User to use when authenticating with NATS server.
	                              Default: $NATS_USER
	--nats-client-name            Name identifying the NATS client among others.
	                              Default: ${NATS_CLIENT_NAME_PREFIX}\${randomHex(4)}
Examples:
    serve-gtfs-rt-from-nats --nats-user foo
\n`)
	process.exit(0)
}

if (flags.version) {
	process.stdout.write(`${pkg.name} v${pkg.version}\n`)
	process.exit(0)
}

import {serveGtfsRtDataFromNats} from './index.js'
import {withSoftExit} from './lib/soft-exit.js'

const cfg = {}
const opt = {
	natsOpts: {},
}

if ('nats-servers' in flags) {
	opt.natsOpts.servers = flags['nats-servers'].split(',')
}
if ('nats-user' in flags) {
	opt.natsOpts.user = flags['nats-user']
}
if ('nats-client-name' in flags) {
	opt.natsOpts.name = flags['nats-client-name']
}

const {
	stop,
} = await serveGtfsRtDataFromNats(cfg, opt)

withSoftExit(stop)
