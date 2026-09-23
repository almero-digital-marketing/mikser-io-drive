// A caller who authenticated and is still not permitted must get 403, never
// 401 — at OPTIONS as well as at PROPFIND.
//
// This is the prompt loop from the other direction, and it is why OPTIONS
// now shares PROPFIND's authorization path rather than getting a challenge
// of its own: telling a client to authenticate again with credentials that
// just worked makes Explorer prompt forever. The distinction is the
// verifier's to make — `rejectionFor` is how it refines "presented and
// invalid" into "refreshing will not help" — so this drives the middleware
// directly with such a verifier, which is the only way to reach that branch.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { rootListing } from '../lib/root-listing.js'

// The middleware only touches these.
function fakeResponse() {
    const res = {
        statusCode: null, headers: {}, ended: false,
        status(code) { res.statusCode = code; return res },
        set(name, value) { res.headers[name.toLowerCase()] = value; return res },
        end() { res.ended = true; return res },
        send() { res.ended = true; return res },
    }
    return res
}

const middleware = (verifier) => rootListing({
    entries:  [{ name: 'SkinCheck', displayName: 'SkinCheck', capability: 'drive:SkinCheck' }],
    rootName: 'drive',
    auth:     { verifier, allowRemote: true, trustLoopback: false, realm: 'mikser' },
    logger:   { debug() {}, error() {} },
})

const request = (method) => ({
    path: '/', method, ip: '203.0.113.9',
    get: (name) => (name.toLowerCase() === 'depth' ? '1' : undefined),
    headers: { authorization: 'Bearer stale' },
})

// Presented a credential, rejected, and the verifier says refreshing will
// not help.
const insufficient = {
    verify: async () => false,
    rejectionFor: () => ({ status: 403, code: 'insufficient_scope' }),
}
// Presented a credential, rejected, no refinement — the ordinary 401.
const invalid = { verify: async () => false }

// A verifier that throws — a store that cannot be read, a hash library that
// blew up. The root answers 401 rather than 500, because a client that can
// retry with credentials is more use than a stack trace, and this branch has
// its own `res.set` call that a mutation can change independently of the
// ordinary one.
const throwing = { verify: async () => { throw new Error('store unreadable') } }

describe('when the verifier itself fails', () => {
    for (const method of ['OPTIONS', 'PROPFIND']) {
        it(`challenges with the configured bytes on ${method}`, async () => {
            const res = fakeResponse()
            await middleware(throwing)(request(method), res, () => {
                assert.fail('the root must answer, not fall through')
            })
            assert.equal(res.statusCode, 401)
            assert.equal(res.headers['www-authenticate'], 'Basic realm="mikser", charset="UTF-8"',
                'the error path must emit what the happy path emits, not its own header')
        })
    }
})

describe('an authenticated caller who is not permitted', () => {
    for (const method of ['OPTIONS', 'PROPFIND']) {
        it(`gets 403 and no challenge on ${method}`, async () => {
            const res = fakeResponse()
            await middleware(insufficient)(request(method), res, () => {
                assert.fail('the root must answer, not fall through')
            })
            assert.equal(res.statusCode, 403)
            assert.equal(res.headers['www-authenticate'], undefined,
                're-challenging credentials that already worked is an infinite prompt')
        })

        it(`still gets 401 with a challenge on ${method} when the credential is merely invalid`, async () => {
            const res = fakeResponse()
            await middleware(invalid)(request(method), res, () => {
                assert.fail('the root must answer, not fall through')
            })
            assert.equal(res.statusCode, 401)
            assert.match(res.headers['www-authenticate'] ?? '', /^Basic /)
        })
    }
})
