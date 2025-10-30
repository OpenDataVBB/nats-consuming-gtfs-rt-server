import {deepStrictEqual} from 'node:assert/strict'
import _contentType from 'content-type'
const {parse: parseContentType} = _contentType

// Unfortunately, the `accepts` npm package ignores parameters (other than `q`) completely.
// This is why we copy the splitting logic [1][2] here and do the content negotiation ourselves.
// todo: move this into a separate package.
// Note: It seems that parameter-based (other than `q`) content negotiation is barely supported. [3]
// [1] https://github.com/jshttp/negotiator/blob/e377492f84df1f74f0fd1fd92e2c15c27ae4b98f/lib/mediaType.js#L253-L268
// [2] https://github.com/jshttp/negotiator/blob/e377492f84df1f74f0fd1fd92e2c15c27ae4b98f/lib/mediaType.js#L211-L226
// [3] https://github.com/jshttp/negotiator/issues/35#issuecomment-298381845

const quoteCount = (string) => {
	let count = 0
	let index = 0
	while ((index = string.indexOf('"', index)) !== -1) {
		count++
		index++
	}
	return count
}

const splitAcceptHeader = (accept) => {
	const accepts = accept.split(',')

	let i, j
	for (i = 1, j = 0; i < accepts.length; i++) {
		if (quoteCount(accepts[j]) % 2 == 0) {
			accepts[++j] = accepts[i]
		} else {
			accepts[j] += ',' + accepts[i]
		}
	}

	// trim accepts
	accepts.length = j + 1

	return accepts.map(contentType => contentType.trim())
}

deepStrictEqual(
	splitAcceptHeader('application/protobuf;schedule_sha256=a1a1a1a1, application/protobuf;schedule_version=baz'),
	[
		'application/protobuf;schedule_sha256=a1a1a1a1',
		'application/protobuf;schedule_version=baz',
	],
)

const parseFeedContentType = (cType) => {
	const {
		type: contentType,
		parameters: params,
	} = parseContentType(cType)
	// todo [breaking]: enforce this:
	// strictEqual(contentType, 'application/protobuf')
	let priority = 'q' in params ? parseFloat(params.q) : null
	if (!Number.isFinite(priority)) {
		priority = null // ignore invalid `q` params
	}
	let scheduleFeedVersion = null
	if (params['schedule_version']) {
		scheduleFeedVersion = params['schedule_version']
	} else if (params['schedule_version_bs58']) {
		scheduleFeedVersion = Buffer.from(decodeBase58(params['schedule_version_bs58'])).toString('utf8')
	}
	return {
		contentType,
		priority,
		scheduleFeedSha256: params['schedule_sha256'] ?? null,
		scheduleFeedVersion,
	}
}
deepStrictEqual(
	parseFeedContentType('application/protobuf;schedule_sha256=a1b2c3d4;q=0.9'),
	{
		contentType: 'application/protobuf',
		priority: .9,
		scheduleFeedSha256: 'a1b2c3d4',
		scheduleFeedVersion: null,
	},
)
deepStrictEqual(
	parseFeedContentType('application/protobuf;schedule_version="foo,bar"'),
	{
		contentType: 'application/protobuf',
		priority: null,
		scheduleFeedSha256: null,
		scheduleFeedVersion: 'foo,bar',
	},
)
deepStrictEqual(
	parseFeedContentType('application/protobuf;schedule_version_bs58=6Yo3yC6'),
	{
		contentType: 'application/protobuf',
		priority: null,
		scheduleFeedSha256: null,
		scheduleFeedVersion: '1-2-3',
	},
)

// https://www.rfc-editor.org/rfc/rfc7231#section-5.3.2
// > A request without any Accept header field implies that the user agent will accept any media type in response.  If the header field is present in a request and none of the available representations for the response have a media type that is listed as acceptable, the origin server can either honor the header field by sending a 406 (Not Acceptable) response or disregard the header field by treating the response as if it is not subject to content negotiation.
// > […]
// > Media ranges can be overridden by more specific media ranges or specific media types.  If more than one media range applies to a given type, the most specific reference has precedence.
// > […]
// > The media type quality factor associated with a given type is determined by finding the media range with the highest precedence that matches the type. For example, `Accept: text/*;q=0.3, text/html;q=0.7, text/html;level=1, text/html;level=2;q=0.4, */*;q=0.5` would cause the following values to be associated:
// > +-------------------+---------------+
// > | Media Type        | Quality Value |
// > +-------------------+---------------+
// > | text/html;level=1 | 1             |
// > | text/html         | 0.7           |
// > | text/plain        | 0.3           |
// > | image/jpeg        | 0.5           |
// > | text/html;level=2 | 0.4           |
// > | text/html;level=3 | 0.7           |
// > +-------------------+---------------+

const negotiateFeedAggregator = (cfg) => {
	const {
		requestHeaders,
		defaultFeedAggregator,
		getMatchingFeedAggregator,
	} = cfg

	if (!('accept' in requestHeaders)) {
		// todo: trace-log?
		return defaultFeedAggregator
	}

	const accepted = splitAcceptHeader(requestHeaders['accept'])
		.map(parseFeedContentType)
		// sort by priority (`q` param)
		.sort(({priority: prioA}, {priority: prioB}) => {
			if (prioA === null && prioB === null) return 0
			if (prioA !== null && prioB !== null) {
				return prioB - prioA // descending
			}
			return prioA !== null ? -1 : 1
		})
	// todo: trace-log?

	let feedAggregator = null
	for (const {contentType, scheduleFeedSha256, scheduleFeedVersion} of accepted) {
		if (contentType === '*/*') {
			return defaultFeedAggregator
		}
		// just ignore unsupported types
		if (contentType !== 'application/protobuf') {
			continue
		}
		// no feed variant preferred
		if (scheduleFeedSha256 === null && scheduleFeedVersion === null) {
			return defaultFeedAggregator
		}
		feedAggregator = getMatchingFeedAggregator(scheduleFeedSha256, scheduleFeedVersion)
		if (feedAggregator !== null) {
			// we have a match!
			break
		}
	}
	// todo: debug-log content negotiation result?
	return feedAggregator
}

export {
	negotiateFeedAggregator,
}
