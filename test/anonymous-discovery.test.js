// The escape hatch for a deployment that wants an unauthenticated probe at
// the root.
//
// Challenging OPTIONS is the default because an anonymous 200 there costs a
// Windows client its stored credential — see lib/root-listing.js. But it is
// a change to who may touch `/`, and a deployment with a health check or a
// monitor pointed at the root should be able to keep the old answer rather
// than being told its monitoring is wrong.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import bcrypt from 'bcryptjs'
import http from 'node:http'

import { runtime } from 'mikser-io'
import { auth } from 'mikser-io-auth'
import { drive } from '../index.js'

const HOST = 'anon.example.test'
let server, port, dir

// Raw http: the Host header is what selects the drive's domain, and fetch()
// drops it — `Host` is forbidden in undici.
function request(method, urlPath, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: '127.0.0.1', port, path: urlPath, method, headers: { Host: HOST, ...headers } },
            (res) => {
                let body = ''
                res.on('data', (chunk) => { body += chunk })
                res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
            })
        req.on('error', reject)
        req.end()
    })
}

before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mikser-drive-anon-'))
    for (const folder of ['documents', 'runtime']) {
        await mkdir(path.join(dir, folder), { recursive: true })
    }
    await writeFile(path.join(dir, 'users.htpasswd'),
        `alice:${bcrypt.hashSync('alice-pw', 10)}\n`)
    await writeFile(path.join(dir, 'groups.htgroup'), 'editors: alice\n')

    const { default: express } = await import('express')
    const app = express()
    runtime.options = { ...runtime.options, app, workingFolder: dir, runtimeFolder: path.join(dir, 'runtime') }
    runtime.config = { ...runtime.config }
    runtime.engine = { ...runtime.engine, logger: { info(){}, warn(){}, error(){}, debug(){}, trace(){}, fatal(){} } }

    const identity = auth({ capabilities: { editors: ['drive:SkinCheck'] } })
    const plugin = drive({
        host: HOST,
        auth: identity,
        anonymousDiscovery: true,
        endpoints: { SkinCheck: { folder: 'documents' } },
    })

    const load = [], loaded = []
    const core = {
        runtime,
        onLoad:    (cb) => load.push(cb),
        onLoaded:  (cb) => loaded.push(cb),
        useLogger: () => ({ info(){}, warn(){}, error(){}, debug(){}, trace(){} }),
    }
    identity(core)
    plugin(core)
    for (const cb of load)   await cb()
    for (const cb of loaded) await cb()

    server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)) })
    port = server.address().port
})

after(async () => {
    server?.closeAllConnections?.()
    await new Promise(r => server?.close(r))
    await rm(dir, { recursive: true, force: true })
})

describe('anonymousDiscovery: true', () => {
    it('answers OPTIONS at the root without credentials', async () => {
        const res = await request('OPTIONS', '/')
        assert.equal(res.status, 200)
        assert.match(res.headers.dav ?? '', /\b1\b/)
        assert.match(res.headers.allow ?? '', /PROPFIND/)
    })

    it('still gates the listing, which is the part that discloses anything', async () => {
        // The flag relaxes DISCOVERY, not access. An anonymous 200 says a
        // WebDAV server is here; the endpoint names are what a caller has to
        // earn, and that is unchanged.
        const res = await request('PROPFIND', '/', { depth: '1' })
        assert.equal(res.status, 401)
        assert.match(res.headers['www-authenticate'] ?? '', /^Basic /)
    })
})
