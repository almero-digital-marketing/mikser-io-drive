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

    it('is MCP-only — it must not reach the engine registry, and so not the CLI', () => {
        // A caller with a shell is already on the machine with the folders in
        // front of it. A mount config is noise there.
        const mcp = boot(editor)
        assert.equal(mcp.get('mikser_webdav_config').def.mcpOnly, true)
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
