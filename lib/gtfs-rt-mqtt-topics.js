// todo: DRY with OpenDataVBB/gtfs-rt-feed
// MQTT: "topic"
// NATS: "subject"

import {ok, strictEqual, deepStrictEqual} from 'node:assert/strict'
import _base58 from 'bs58'

const SUBJECT_ROOT_SEGMENT = 'gtfsrt'

const SUBJECT_VEHICLEPOSITIONS_SEGMENT = 'vp'
const SUBJECT_TRIPUPDATES_SEGMENT = 'tu'
const feedEntityKindsBySegment = new Map([
	// todo: use Symbols?
	[SUBJECT_VEHICLEPOSITIONS_SEGMENT, 'VehiclePosition'],
	[SUBJECT_TRIPUPDATES_SEGMENT, 'TripUpdate'],
])

const _textEncoder = new TextEncoder()
const encodeBase58 = (str) => {
	return _base58.encode(_textEncoder.encode(str))
}
strictEqual(encodeBase58('2025-10-06'), '3pYN3ktvQWAYGV')

const _textDecoder = new TextDecoder()
const decodeBase58 = (base58Encoded) => {
	return _textDecoder.decode(_base58.decode(base58Encoded))
}
strictEqual(decodeBase58('3pYN3ktvQWAYGV'), '2025-10-06')

const parseNatsMsgSubject = (subject) => {
	// e.g. `gtfsrt.tu.cd36ea.3pYN3ktvQWAYGV` or `gtfs.vp..`
	const [
		root,
		feedEntitySegment,
		..._
	] = subject.split('.')

	strictEqual(root, SUBJECT_ROOT_SEGMENT, `subject's 1st segment must be "${SUBJECT_ROOT_SEGMENT}"`)
	ok(
		feedEntityKindsBySegment.has(feedEntitySegment),
		`subject's 2nd segment must be one of ${Array.from(feedEntityKindsBySegment.keys()).map(kind => `"${kind}"`).join(', ')}`,
	)

	const res = {
		root,
		feedEntityKind: feedEntityKindsBySegment.get(feedEntitySegment),
		scheduleFeedSha256: null,
		scheduleFeedVersion: null,
	}
	if (_.length !== 2) {
		if (_.length > 0) {
			// todo: info-log?
		}
		return res
	}

	res.scheduleFeedSha256 = _[0] || null
	res.scheduleFeedVersion = _[1] ? decodeBase58(_[1]) : null

	return res
}
deepStrictEqual(
	parseNatsMsgSubject(`gtfsrt.vp`),
	{
		root: 'gtfsrt',
		feedEntityKind: 'VehiclePosition',
		scheduleFeedSha256: null,
		scheduleFeedVersion: null,
	},
)
deepStrictEqual(
	parseNatsMsgSubject(`gtfsrt.tu..`),
	{
		root: 'gtfsrt',
		feedEntityKind: 'TripUpdate',
		scheduleFeedSha256: null,
		scheduleFeedVersion: null,
	},
)
deepStrictEqual(
	parseNatsMsgSubject(`gtfsrt.tu.cd36ea`),
	{
		root: 'gtfsrt',
		feedEntityKind: 'TripUpdate',
		scheduleFeedSha256: null,
		scheduleFeedVersion: null,
	},
)
deepStrictEqual(
	parseNatsMsgSubject(`gtfsrt.tu.cd36ea.`),
	{
		root: 'gtfsrt',
		feedEntityKind: 'TripUpdate',
		scheduleFeedSha256: 'cd36ea',
		scheduleFeedVersion: null,
	},
)
deepStrictEqual(
	parseNatsMsgSubject(`gtfsrt.tu.cd36ea.3pYN3ktvQWAYGV`),
	{
		root: 'gtfsrt',
		feedEntityKind: 'TripUpdate',
		scheduleFeedSha256: 'cd36ea',
		scheduleFeedVersion: '2025-10-06',
	},
)

export {
	SUBJECT_ROOT_SEGMENT,
	SUBJECT_VEHICLEPOSITIONS_SEGMENT,
	SUBJECT_TRIPUPDATES_SEGMENT,
	parseNatsMsgSubject,
}
