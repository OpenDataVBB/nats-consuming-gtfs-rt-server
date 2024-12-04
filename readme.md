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
	--port                    -p  Port to serve the GTFS Realtime feed on.
	                              Default: $PORT, otherwise 3000
	--nats-servers                NATS server(s) to connect to.
	                              Default: $NATS_SERVERS
	--nats-user                   User to use when authenticating with NATS server.
	                              Default: $NATS_USER
	--nats-client-name            Name identifying the NATS client among others.
	                              Default: vdv453-1-${randomHex(4)}
	--nats-consumer-name          Name of the NATS JetStream consumer on the
	                              GTFS_RT_2 stream.
	                              Default: $GTFS_RT_CONSUMER_NAME, otherwise `nats-
	                              consuming-gtfs-rt-server`
	--diff-entities-ttl           Time to keep DIFFERENTIAL-mode GTFS-RT FeedEntities
	                              in the combined FULL_DATASET-mode feed for, in seconds.
	                              Default: 10 minutes
	--t0                          UNIX timestamp to use as now, for debugging purposes.
	                              Default: current UNIX timestamp
Examples:
    serve-gtfs-rt-from-nats --port 1234 --nats-user foo
```

### create NATS stream & consumer

Before running `nats-consuming-gtfs-rt-server`, you must create a [NATS JetStream](https://docs.nats.io/nats-concepts/jetstream) [stream](https://docs.nats.io/nats-concepts/jetstream/streams) called `GTFS_RT_2` holding the `FeedEntity` GTFS-RT messages. This can be done using the [NATS CLI](https://github.com/nats-io/natscli):


```shell
nats stream add \
	# omit this if you want to configure more details
	--defaults \
	# collect all messages published to these subjects
	--subjects='gtfsrt.>' \
	# acknowledge publishes
	--ack \
	# with limited storage, discard the oldest limits first
	--retention=limits --discard=old \
	--description='GTFS-Realtime FeedEntity messages' \
	# name of the stream
	GTFS_RT_2
```

On the `GTFS_RT_2` stream, you must also create a durable [consumer](https://docs.nats.io/nats-concepts/jetstream/consumers):

```shell
nats consumer add \
	# omit this if you want to configure more details
	--defaults \
	# create a pull-based consumer (refer to the NATS JetStream docs)
	--pull \
	# let gtfs-rt-feed explicitly acknowledge all received messages
	--ack=explicit \
	# let the newly created consumer start with the latest messages in GTFS_RT_2 (not all)
	--deliver=new \
	# send gtfs-rt-feed at most 200 messages at once
	--max-pending=500 \
	# when & how often to re-deliver a message that hasn't been acknowledged (usually because it couldn't be processed)
	--max-deliver=3 \
	--backoff=linear \
	--backoff-steps=2 \
	--backoff-min=15s \
	--backoff-max=1m \
	--description 'OpenDataVBB/nats-consuming-gtfs-rt-server' \
	# name of the stream
	GTFS_RT_2 \
	# name of the consumer
	nats-consuming-gtfs-rt-server
```


## Related

- [`gtfs-rt-differential-to-full-dataset`](https://github.com/derhuerst/gtfs-rt-differential-to-full-dataset) – Transform a differential GTFS Realtime feed into a full dataset/dump.
- [`gtfs-rt-bindings`](https://github.com/derhuerst/gtfs-rt-bindings) – Parse and serialize GTFS Realtime data encoded as protocol buffers. (third-party)
- [`gtfs-realtime-bindings`](https://npmjs.com/package/gtfs-realtime-bindings) – Javascript classes generated from the GTFS-realtime protocol buffer specification. (official)


## Contributing

If you have a question or need support using `nats-consuming-gtfs-rt-server`, please double-check your code and setup first. If you think you have found a bug or want to propose a feature, use [the issues page](https://github.com/OpenDataVBB/nats-consuming-gtfs-rt-server/issues).
