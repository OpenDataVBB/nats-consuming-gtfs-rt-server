# nats-consuming-gtfs-rt-server

**Reads a continuous stream of [GTFS Realtime (GTFS-RT)](https://developers.google.com/transit/gtfs-realtime/) data with [`DIFFERENTIAL` incrementality](https://gtfs.org/documentation/realtime/reference/#enum-incrementality) from [NATS](https://nats.io), converts it into a single [`FULL_DATASET`](https://gtfs.org/documentation/realtime/reference/#enum-incrementality) GTFS-RT feed, and serves it via HTTP.**

Note from [`gtfs-rt-differential-to-full-dataset`](https://github.com/derhuerst/gtfs-rt-differential-to-full-dataset), which is used for the conversion:

> Right now, this package *does not* obey the [draft `DIFFERENTIAL` spec](https://github.com/google/transit/issues/84) exactly. See below and [#1](https://github.com/derhuerst/gtfs-rt-differential-to-full-dataset/issues/1) for details.

![ISC-licensed](https://img.shields.io/github/license/OpenDataVBB/nats-consuming-gtfs-rt-server.svg)


## Installation

```shell
npm install -g OpenDataVBB/nats-consuming-gtfs-rt-server
```


## Getting Started

```shell
# todo
```


## Usage

```
Usage:
    serve-gtfs-rt-from-nats [options]
Options:
	--nats-servers                NATS server(s) to connect to.
	                              Default: $NATS_SERVERS
	--nats-user                   User to use when authenticating with NATS server.
	                              Default: $NATS_USER
	--nats-client-name            Name identifying the NATS client among others.
Examples:
    serve-gtfs-rt-from-nats --nats-user foo
```


## Related

- [`gtfs-rt-differential-to-full-dataset`](https://github.com/derhuerst/gtfs-rt-differential-to-full-dataset) – Transform a differential GTFS Realtime feed into a full dataset/dump.
- [`gtfs-rt-bindings`](https://github.com/derhuerst/gtfs-rt-bindings) – Parse and serialize GTFS Realtime data encoded as protocol buffers. (third-party)
- [`gtfs-realtime-bindings`](https://npmjs.com/package/gtfs-realtime-bindings) – Javascript classes generated from the GTFS-realtime protocol buffer specification. (official)


## Contributing

If you have a question or need support using `nats-consuming-gtfs-rt-server`, please double-check your code and setup first. If you think you have found a bug or want to propose a feature, use [the issues page](https://github.com/OpenDataVBB/nats-consuming-gtfs-rt-server/issues).
