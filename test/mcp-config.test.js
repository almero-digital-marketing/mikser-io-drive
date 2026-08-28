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

const payload = async (mcp, args) => JSON.parse((await mcp.call('mikser_webdav_access', args)).content[0].text)
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

describe('webdav_access registration', () => {
    it('registers only when there is an MCP surface to register against', () => {
        // No substrate, no tool — and no throw. A deployment without the mcp
        // plugin still mounts WebDAV perfectly well.
        const runtime = { options: {} }
        assert.doesNotThrow(() => registerWebdavMcp({
            runtime, base: '/webdav', endpoints: ENDPOINTS,
            capabilityOf: readCapability, writeCapabilityOf: writeCapability,
        }))
    })

    it('registers ONE tool under the prefixed name the substrate uses', () => {
        // The mirror into the engine's registry strips the prefix back off, so
        // they answer on the CLI too.
        const mcp = boot(editor)
        assert.deepEqual(mcp.names(), ['mikser_webdav_access'])
    })

    it('issues no credential when no endpoint is named', async () => {
        // Nothing to scope one to yet, so there is nothing to hand over.
        const body = await payload(boot(editor))
        assert.equal(body.token, undefined)
        assert.match(body.credential, /None issued/)
        assert.match(body.credential, /naming an endpoint/)
    })

    it('describes its one argument in the neutral vocabulary, needing no zod here', () => {
        const schema = boot(editor).get('mikser_webdav_access').def.inputSchema
        assert.equal(schema.endpoint.type, 'string')
        assert.ok(schema.endpoint.description)
    })
})

describe('webdav_access access, computed from the CALLER', () => {
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
    })

    it('says unknown rather than guessing for a credential that is not capability-scoped', async () => {
        // A static token or a loopback caller declares no capabilities. The
        // endpoint's own gate still applies; this cannot say more truthfully.
        const body = await payload(boot({ subject: 'loopback', capabilities: null }))
        assert.equal(accessOf(body, 'content').access, 'unknown')
        assert.equal(accessOf(body, 'data').access, 'read-only', 'a readOnly endpoint is still knowable')
    })
})

describe('webdav_access output', () => {
    it('the map carries no commands to run, because it carries no credential', async () => {
        // The old split returned a config full of $MIKSER_TOKEN placeholders
        // beside a second tool that returned a real one. Two responses with a
        // `token` field meaning different things is the confusion this merge
        // removes: the map describes, the keyed call hands over.
        const body = await payload(boot(editor))
        assert.equal(body.token, undefined)
        assert.equal(body.examples, undefined)
        assert.equal(body.rcloneConfig, undefined)
    })

    it('builds URLs from the engine\'s external url, not from a guess', async () => {
        assert.equal(accessOf(await payload(boot(editor)), 'content').url,
            'https://example.test/webdav/content')
    })

    it('lists every endpoint, so the caller can see what to ask for', async () => {
        const body = await payload(boot(editor))
        assert.deepEqual(body.endpoints.map(e => e.name), ['content', 'media', 'data'])
        assert.equal(body.origin, 'https://example.test')
    })

    it('says a credential is available rather than leaving the caller to guess', async () => {
        const body = await payload(boot(editor))
        assert.match(body.credential, /naming an endpoint/)
    })

    it('says out loud what it does NOT cover', async () => {
        // davfs2 and GUI clients speak Basic only, so they would need a
        // password rather than the token — the thing using Bearer avoids.
        // Silently omitting them would read as an oversight.
        const body = await payload(boot(editor))
        assert.ok(body.notCovered.some(n => /davfs2/.test(n)))
        assert.ok(body.notCovered.some(n => /written to disk/.test(n)))
    })

    it('refuses a name that is not configured, naming the ones that are', async () => {
        const bad = await boot(editor).call('mikser_webdav_access', { endpoint: 'nope' })
        assert.equal(bad.isError, true)
        assert.match(bad.content[0].text, /content, media, data/)
    })

    it('explains itself when there is no authorization server to mint from', async () => {
        // The map still works without one — only the keyed call needs it.
        const mcp = boot(editor)
        const r = await mcp.call('mikser_webdav_access', { endpoint: 'media' })
        assert.equal(r.isError, true)
        assert.match(r.content[0].text, /nothing to mint from/)
        assert.match(r.content[0].text, /without an endpoint still lists/)
    })
})

// A credential handed to an agent, minted as small and as short-lived as the
// task allows. Never the caller's session bearer: that one carries read AND
// write on every endpoint for about an hour, and a transcript is a log.
describe('mikser_webdav_access', () => {
    const mint = async (mcp, args) => {
        const r = await mcp.call('mikser_webdav_access', args)
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

    it('returns examples that are runnable as written', async () => {
        // These carried a $MIKSER_DAV_TOKEN placeholder so the secret would
        // appear exactly once. An agent reading that either runs it literally
        // and gets a 401, or has to infer a substitution step nobody announced
        // — both worse than the exposure being avoided, since every occurrence
        // lands in the same response anyway.
        const { mcp } = bootMint(editor)
        const t = await mint(mcp, { endpoint: 'media' })
        for (const [name, cmd] of Object.entries(t.examples)) {
            assert.ok(cmd.includes(t.token), `${name} must carry the real credential`)
            assert.equal(/\$MIKSER_DAV_TOKEN|<the token/.test(cmd), false,
                `${name} must not ask the caller to substitute anything`)
        }
    })

    it('still never returns the caller\'s session bearer', async () => {
        // Inlining the MINTED token is the change; the session token — every
        // endpoint, read and write, about an hour — is what must never appear.
        const { mcp } = bootMint(editor)
        const t = await mint(mcp, { endpoint: 'media' })
        assert.notEqual(t.token, 'session-bearer-would-be-here')
        assert.match(t.scopes.join(' '), /^webdav:media/)
        assert.ok(t.ttl <= 900)
        assert.ok(t.jti, 'and it must stay revokable')
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

describe('the ttl bounds the START of a transfer, not its duration', () => {
    // Counter-intuitive and measured: a 10-second PUT with a 3-second token
    // returned 201 with every byte landed, because authorization happens once
    // at the beginning of the request. A caller sizing a 1GB upload against a
    // 900s window would otherwise conclude, wrongly, that it cannot be done.
    const mint = async (mcp, args) => {
        const r = await mcp.call('mikser_webdav_access', args)
        return r.isError ? { isError: true, text: r.content[0].text } : JSON.parse(r.content[0].text)
    }
    function bootMint(principal) {
        const mcp = fakeSubstrate(principal)
        registerWebdavMcp({
            runtime: { options: { mcp, url: 'https://example.test', auth: {
                mint: async ({ request, ttlSec }) => ({
                    token: 'minted.x', jti: 'j', scopes: request, ttl: ttlSec,
                    expiresAt: new Date(Date.now() + ttlSec * 1000).toISOString(),
                }),
            } } },
            base: '/webdav', endpoints: ENDPOINTS,
            capabilityOf: readCapability, writeCapabilityOf: writeCapability,
        })
        return mcp
    }

    it('says so in the response, not only in the tool description', async () => {
        const t = await mint(bootMint(editor), { endpoint: 'media' })
        assert.match(t.duration, /START a transfer/)
        assert.match(t.duration, /runs to completion even after the token expires/)
    })

    it('names the thing that DOES bound a long upload', async () => {
        // Pointing at the wrong constraint is how an operator raises a limit
        // that was never the problem.
        const t = await mint(bootMint(editor), { endpoint: 'media' })
        assert.match(t.duration, /config\.server\.requestTimeout/)
    })
})
