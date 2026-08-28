import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { registerWebdavMcp } from '../lib/mcp.js'
import { readCapability, writeCapability } from '../index.js'

// The tool answers "how do I, a REMOTE client, reach these folders over HTTP".
// It exists because the authenticator already accepts a Bearer token on every
// endpoint — measured: PROPFIND 207, PUT 201, GET 200 with one, 401 without —
// so the missing piece was never access. It was knowing which endpoints exist
// and which of them your own capabilities let you write.

const ENDPOINTS = {
    content: { folder: 'documents' },
    media:   { folder: 'media' },
    data:    { folder: 'data', readOnly: true },
}

// A stand-in substrate: enough of the surface for the plugin to register
// against, plus a settable principal so each test can be a different caller.
function fakeSubstrate(principal) {
    const tools = new Map()
    return {
        principal: () => principal,
        registerTool(name, def, handler) { tools.set(name, { def, handler }) },
        call: (name, args) => tools.get(name).handler(args ?? {}),
        get: (name) => tools.get(name),
        names: () => [...tools.keys()],
    }
}

function boot(principal, options = {}) {
    const mcp = fakeSubstrate(principal)
    const runtime = { options: { mcp, url: 'https://example.test', ...options } }
    registerWebdavMcp({
        runtime, base: '/webdav', endpoints: ENDPOINTS,
        capabilityOf: readCapability, writeCapabilityOf: writeCapability,
    })
    return mcp
}

const payload = async (mcp, args) => JSON.parse((await mcp.call('mikser_webdav_config', args)).content[0].text)
const accessOf = (body, name) => body.endpoints.find(e => e.name === name)

let editor
beforeEach(() => {
    editor = {
        subject: 'alice',
        capabilities: [
            'webdav:content', 'webdav:content:write',
            'webdav:media',                       // read, no write
            'webdav:data',
        ],
        expiresAt: '2026-08-28T12:00:00.000Z',
        secondsRemaining: 1800,
    }
})

describe('webdav_config registration', () => {
    it('registers only when there is an MCP surface to register against', () => {
        // No substrate, no tool — and no throw. A deployment without the mcp
        // plugin still mounts WebDAV perfectly well.
        const runtime = { options: {} }
        assert.doesNotThrow(() => registerWebdavMcp({
            runtime, base: '/webdav', endpoints: ENDPOINTS,
            capabilityOf: readCapability, writeCapabilityOf: writeCapability,
        }))
    })

    it('registers both tools under the prefixed names the substrate uses', () => {
        // The mirror into the engine's registry strips the prefix back off, so
        // they answer on the CLI too.
        const mcp = boot(editor)
        assert.deepEqual(mcp.names().sort(), ['mikser_dav_token', 'mikser_webdav_config'])
    })

    it('points webdav_config at the minting tool instead of inlining a credential', async () => {
        // The refusal to include one stays; what changes is that there is now
        // somewhere to go for a credential that is safe to paste.
        const body = await payload(boot(editor))
        assert.match(body.token, /not included here on purpose/)
        assert.match(body.token, /mikser_dav_token/)
    })

    it('describes its one argument in the neutral vocabulary, needing no zod here', () => {
        const schema = boot(editor).get('mikser_webdav_config').def.inputSchema
        assert.equal(schema.endpoint.type, 'string')
        assert.ok(schema.endpoint.description)
    })
})

describe('webdav_config access, computed from the CALLER', () => {
    it('reports read-write only where the caller holds the write capability', async () => {
        const body = await payload(boot(editor))
        assert.equal(accessOf(body, 'content').access, 'read-write')
    })

    it('names WHY a writable endpoint is read-only for this caller', async () => {
        // Discovering this by having a 40MB PUT return 403 is the failure worth
        // preventing — the same reason a write refuses ahead of expiry rather
        // than part way through.
        const media = accessOf(await payload(boot(editor)), 'media')
        assert.equal(media.access, 'read-only')
        assert.match(media.why, /webdav:media but not webdav:media:write/)
    })

    it('reports a readOnly endpoint as read-only for everyone, not as a personal limit', async () => {
        const data = accessOf(await payload(boot(editor)), 'data')
        assert.equal(data.access, 'read-only')
        assert.match(data.why, /readOnly for everyone/)
    })

    it('says none for an endpoint the caller holds nothing on', async () => {
        const stranger = { subject: 'bob', capabilities: ['mcp:use'] }
        const body = await payload(boot(stranger))
        assert.ok(body.endpoints.every(e => e.access === 'none'))
        // And offers no config for what cannot be used.
        assert.equal(body.rcloneConfig, '')
    })

    it('says unknown rather than guessing for a credential that is not capability-scoped', async () => {
        // A static token or a loopback caller declares no capabilities. The
        // endpoint's own gate still applies; this cannot say more truthfully.
        const body = await payload(boot({ subject: 'loopback', capabilities: null }))
        assert.equal(accessOf(body, 'content').access, 'unknown')
        assert.equal(accessOf(body, 'data').access, 'read-only', 'a readOnly endpoint is still knowable')
    })
})

describe('webdav_config output', () => {
    it('carries a placeholder, never a credential', async () => {
        // This response lands in the caller's transcript. The caller already
        // holds the token; putting it here would be a new exposure for a saved
        // string substitution.
        const body = await payload(boot(editor))
        assert.match(body.rcloneConfig, /bearer_token = \$MIKSER_TOKEN/)
        assert.match(body.curl, /\$MIKSER_TOKEN/)
        assert.match(body.token, /not included here on purpose/)
    })

    it('builds URLs from the engine\'s external url, not from a guess', async () => {
        assert.equal(accessOf(await payload(boot(editor)), 'content').url,
            'https://example.test/webdav/content')
    })

    it('omits from the pasteable config what the caller cannot use', async () => {
        const body = await payload(boot(editor))
        assert.match(body.rcloneConfig, /\[mikser-content\]/)
        assert.match(body.rcloneConfig, /\[mikser-media\]/)   // read-only is still usable
        const stranger = await payload(boot({ subject: 'bob', capabilities: [] }))
        assert.equal(stranger.rcloneConfig, '')
    })

    it('names the expiry, because a long transfer can outlive the token', async () => {
        const body = await payload(boot(editor))
        assert.equal(body.secondsRemaining, 1800)
        assert.match(body.expiry, /offline_access/)
    })

    it('omits expiry talk for a credential that has none', async () => {
        const body = await payload(boot({ subject: 'static', capabilities: ['webdav:content'] }))
        assert.equal(body.expiresAt, undefined)
        assert.equal(body.expiry, undefined)
    })

    it('says out loud what it does NOT cover', async () => {
        // davfs2 and GUI clients speak Basic only, so they would need a
        // password rather than the token — the thing using Bearer avoids.
        // Silently omitting them would read as an oversight.
        const body = await payload(boot(editor))
        assert.ok(body.notCovered.some(n => /davfs2/.test(n)))
        assert.ok(body.notCovered.some(n => /written to disk/.test(n)))
    })

    it('narrows to one endpoint, and refuses a name that is not configured', async () => {
        const mcp = boot(editor)
        const one = await payload(mcp, { endpoint: 'media' })
        assert.deepEqual(one.endpoints.map(e => e.name), ['media'])

        const bad = await mcp.call('mikser_webdav_config', { endpoint: 'nope' })
        assert.equal(bad.isError, true)
        // Names what IS configured rather than only what is not.
        assert.match(bad.content[0].text, /content, media, data/)
    })
})

// A credential handed to an agent, minted as small and as short-lived as the
// task allows. Never the caller's session bearer: that one carries read AND
// write on every endpoint for about an hour, and a transcript is a log.
describe('mikser_dav_token', () => {
    const mint = async (mcp, args) => {
        const r = await mcp.call('mikser_dav_token', args)
        return r.isError ? { isError: true, text: r.content[0].text } : JSON.parse(r.content[0].text)
    }

    // A stand-in minter with the same contract as the auth plugin's: it can
    // only ever narrow, and it names what is missing when asked for more.
    function bootMint(principal, { fail } = {}) {
        const minted = []
        const mcp = fakeSubstrate(principal)
        const runtime = {
            options: {
                mcp, url: 'https://example.test',
                auth: fail === 'no-minter' ? undefined : {
                    mint: async ({ subject, capabilities, request, ttlSec, purpose }) => {
                        const missing = request.filter(s => !(capabilities ?? []).includes(s))
                        if (missing.length) {
                            const err = new Error(`mint refused: you do not hold ${missing.join(', ')}`)
                            err.missing = missing
                            throw err
                        }
                        const rec = { subject, scopes: request, ttl: ttlSec, purpose,
                                      token: 'minted.' + Math.random().toString(36).slice(2),
                                      jti: 'jti-' + minted.length,
                                      expiresAt: new Date(Date.now() + ttlSec * 1000).toISOString() }
                        minted.push(rec)
                        return rec
                    },
                },
            },
        }
        registerWebdavMcp({
            runtime, base: '/webdav', endpoints: ENDPOINTS,
            capabilityOf: readCapability, writeCapabilityOf: writeCapability,
        })
        return { mcp, minted }
    }

    it('mints read-only by default', async () => {
        const { mcp } = bootMint(editor)
        const t = await mint(mcp, { endpoint: 'media' })
        assert.deepEqual(t.scopes, ['webdav:media'])
        assert.equal(t.write, false)
    })

    it('scopes to the named endpoint alone', async () => {
        // A token minted for media must not open layouts. This is the property
        // the whole tool exists for.
        const { mcp } = bootMint(editor)
        const t = await mint(mcp, { endpoint: 'media', write: false })
        assert.ok(t.scopes.every(s => s.startsWith('webdav:media')))
        assert.equal(t.scopes.some(s => s.includes('content')), false)
    })

    it('refuses a scope the caller does not hold, naming it, and mints nothing', async () => {
        // `editor` holds webdav:media (read) but not :write.
        const { mcp, minted } = bootMint({ subject: 'alice', capabilities: ['webdav:media'] })
        const r = await mint(mcp, { endpoint: 'media', write: true })
        assert.equal(r.isError, true)
        assert.match(r.text, /webdav:media:write/)
        assert.match(r.text, /Nothing was minted/)
        assert.equal(minted.length, 0)
    })

    it('clamps ttl to the maximum and SAYS it clamped', async () => {
        // Silently shortening it would have a caller plan a transfer around a
        // number that was never true.
        const { mcp } = bootMint(editor)
        const t = await mint(mcp, { endpoint: 'media', ttl: 7200 })
        assert.equal(t.ttl, 900)
        assert.match(t.notes[0], /clamped from 7200s/)
    })

    it('defaults the ttl, and does not claim to have clamped when it did not', async () => {
        const { mcp } = bootMint(editor)
        const t = await mint(mcp, { endpoint: 'media' })
        assert.equal(t.ttl, 300)
        assert.equal(t.notes, undefined)
    })

    it('is never renewable — expiry IS the revocation', async () => {
        const { mcp } = bootMint(editor)
        assert.equal((await mint(mcp, { endpoint: 'media' })).renewable, false)
    })

    it('puts the literal token in exactly ONE place', async () => {
        // The examples reference a placeholder, so the secret is not repeated
        // into the transcript once per command.
        const { mcp } = bootMint(editor)
        const t = await mint(mcp, { endpoint: 'media' })
        const blob = JSON.stringify(t)
        assert.equal(blob.split(t.token).length - 1, 1)
        assert.match(JSON.stringify(t.examples), /\$MIKSER_DAV_TOKEN/)
        assert.equal(JSON.stringify(t.examples).includes(t.token), false)
    })

    it('withholds write on the documents endpoint without a second, explicit flag', async () => {
        // A PUT there loses the ifChecksum guard, the blast radius, the build
        // report and the spec-locked advisory. The refusal has to say so, or it
        // reads as an arbitrary obstacle.
        const { mcp, minted } = bootMint(editor)
        const r = await mint(mcp, { endpoint: 'content', write: true })
        assert.equal(r.isError, true)
        assert.match(r.text, /allowContentWrite/)
        assert.match(r.text, /update_entity/)
        assert.match(r.text, /ifChecksum/)
        assert.equal(minted.length, 0)
    })

    it('grants documents write when asked for twice', async () => {
        const { mcp } = bootMint(editor)
        const t = await mint(mcp, { endpoint: 'content', write: true, allowContentWrite: true })
        assert.deepEqual(t.scopes, ['webdav:content', 'webdav:content:write'])
    })

    it('does not guard READ on documents', async () => {
        const { mcp } = bootMint(editor)
        assert.deepEqual((await mint(mcp, { endpoint: 'content' })).scopes, ['webdav:content'])
    })

    it('refuses write on an endpoint configured readOnly for everyone', async () => {
        // Minting one would produce a token that 403s on its first PUT.
        const { mcp } = bootMint(editor)
        const r = await mint(mcp, { endpoint: 'data', write: true })
        assert.equal(r.isError, true)
        assert.match(r.text, /readOnly for everyone/)
    })

    it('refuses an endpoint that is not configured, naming the ones that are', async () => {
        const { mcp } = bootMint(editor)
        const r = await mint(mcp, { endpoint: 'nope' })
        assert.equal(r.isError, true)
        assert.match(r.text, /content, media, data/)
    })

    it('refuses when there is no authenticated caller to narrow from', async () => {
        const { mcp } = bootMint(null)
        const r = await mint(mcp, { endpoint: 'media' })
        assert.equal(r.isError, true)
        assert.match(r.text, /no identity here to narrow from/)
    })

    it('refuses when no authorization server is configured', async () => {
        const { mcp } = bootMint(editor, { fail: 'no-minter' })
        const r = await mint(mcp, { endpoint: 'media' })
        assert.equal(r.isError, true)
        assert.match(r.text, /nothing to mint from/)
    })

    it('records the purpose, so a mint is accountable afterwards', async () => {
        // `editor` holds content read+write; media is read-only for them, which
        // is why this asks for content.
        const { mcp, minted } = bootMint(editor)
        await mint(mcp, { endpoint: 'content', write: true, allowContentWrite: true })
        assert.match(minted[0].purpose, /webdav:content \(write\)/)
        assert.equal(minted[0].subject, 'alice')
        assert.deepEqual(minted[0].scopes, ['webdav:content', 'webdav:content:write'])
    })

    it('mints nothing at all when it refuses — no partial credential', async () => {
        // Every refusal path must leave the minter untouched, not mint a
        // read token as a consolation prize.
        for (const args of [
            { endpoint: 'media', write: true },          // scope not held
            { endpoint: 'content', write: true },        // guarded endpoint
            { endpoint: 'data', write: true },           // readOnly endpoint
            { endpoint: 'nope' },                        // unknown endpoint
        ]) {
            const { mcp, minted } = bootMint(editor)
            const r = await mint(mcp, args)
            assert.equal(r.isError, true, JSON.stringify(args))
            assert.equal(minted.length, 0, `${JSON.stringify(args)} must mint nothing`)
        }
    })
})
