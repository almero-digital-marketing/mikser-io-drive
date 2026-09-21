// The drive's own root, on a domain of its own.
//
// The Microsoft WebDAV redirector establishes its session against the SERVER
// ROOT before it touches the path. A share at `<base>/<name>` on a site whose
// `/` is a static site is therefore one Explorer may never reach: it asks `/`,
// gets a static site's answer, and stops — the leaf being correct makes no
// difference. Measured on a live host: OPTIONS on the mount answered
// `DAV: 1, 3, 2` while `dir \\host@SSL\DavWWWRoot\drive\SkinCheck\` still
// failed, and it failed at the root.
//
// `drive({ host })` gives the drive a domain where `/` is the drive itself: a
// collection whose children are the endpoints the caller may read. Each child
// is the real mount, so entering one lands on that endpoint's own Nephele
// server with its own authenticator — no virtual adapter, and no fake
// directory tree to keep in step with the mount keys.
//
// Host-scoped, and that is not optional: mounted at `/` for every host, a
// drive shadows every page on the site.

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

const HOST = 'drive.example.test'
let server, port, dir

const as = (user) => 'Basic ' + Buffer.from(`${user}:${user}-pw`).toString('base64')

// Raw http, not fetch.
//
// The Host header IS the test here — it is what decides whether this request
// is for the drive's domain — and fetch() silently drops it: `Host` is a
// forbidden header in undici, so every request went out as 127.0.0.1 and the
// host gate correctly refused all of them. The first version of this file
// failed for that reason and the code was fine.
function request(method, urlPath, { host = HOST, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: '127.0.0.1', port, path: urlPath, method, headers: { Host: host, ...headers } },
            (res) => {
                let body = ''
                res.on('data', (chunk) => { body += chunk })
                res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
            })
        req.on('error', reject)
        req.end()
    })
}
const propfind = (opts = {}) =>
    request('PROPFIND', '/', { ...opts, headers: { depth: '1', ...(opts.headers ?? {}) } })

before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mikser-drive-root-'))
    for (const folder of ['documents', 'reports', 'media', 'runtime']) {
        await mkdir(path.join(dir, folder), { recursive: true })
    }
    await writeFile(path.join(dir, 'documents/page.md'), '# hello\n')
    await writeFile(path.join(dir, 'users.htpasswd'), ['alice', 'bob', 'carol']
        .map(u => `${u}:${bcrypt.hashSync(`${u}-pw`, 10)}`).join('\n') + '\n')
    await writeFile(path.join(dir, 'groups.htgroup'),
        'editors: alice\nreviewers: bob\nowners: carol\n')

    const { default: express } = await import('express')
    const app = express()
    runtime.options = { ...runtime.options, app, workingFolder: dir, runtimeFolder: path.join(dir, 'runtime') }
    runtime.config = { ...runtime.config }
    runtime.engine = { ...runtime.engine, logger: { info(){}, warn(){}, error(){}, debug(){}, trace(){}, fatal(){} } }

    const identity = auth({
        capabilities: {
            editors:   ['drive:SkinCheck'],          // alice: one endpoint
            reviewers: ['drive:Reports'],            // bob: a different one
            owners:    ['*'],                        // carol: all of them
        },
    })
    const plugin = drive({
        host: HOST,
        auth: identity,
        endpoints: {
            SkinCheck: { folder: 'documents' },
            Reports:   { folder: 'reports' },
            Media:     { folder: 'media', displayName: 'Media library' },
        },
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

describe('host in the wrong place', () => {
    // It was per-endpoint while this was being designed, and moved to the
    // plugin when the root listing arrived — several endpoints share one
    // domain, and `/` on it lists them. This file's own JSDoc went on showing
    // the old shape, which is a config that reads as though it works and does
    // nothing at all. So it says so.
    it('warns instead of silently ignoring it', async () => {
        const said = []
        const core = {
            runtime,
            onLoad:    () => {},
            onLoaded:  (cb) => said.push(cb),
            useLogger: () => ({
                info(){}, error(){}, debug(){}, trace(){},
                warn: (...args) => said.push(args.join(' ')),
            }),
        }
        drive({ endpoints: { Share: { folder: 'documents', host: 'drive.example.test' } } })(core)
        for (const entry of [...said]) if (typeof entry === 'function') await entry()

        const warning = said.find(entry =>
            typeof entry === 'string' && entry.includes('plugin-level option'))
        assert.ok(warning, `no warning about a misplaced host:\n${said.filter(e => typeof e === 'string').join('\n')}`)
    })
})

describe('the drive root on its own host', () => {
    it('challenges an anonymous OPTIONS, so the session authenticates at the root', async () => {
        // This used to answer 200 without credentials, and that is what cost
        // Windows its stored credential. The redirector builds its session
        // against the SERVER ROOT before it touches the path; told the root
        // needed nothing, it established the session anonymously and attached
        // credentials only reactively at the PROPFIND 401. That attachment did
        // not survive a reboot or WebClient's idle teardown — the redirector
        // asked again, got the same clean 200, and prompted a human rather
        // than replaying Credential Manager, with the credential sitting in
        // cmdkey the whole time.
        //
        // Apache mod_dav inside `Require valid-user` 401s here, and reconnects
        // there are silent.
        const res = await request('OPTIONS', '/')
        assert.equal(res.status, 401)
        assert.match(res.headers['www-authenticate'] ?? '', /^Basic /,
            'Basic is the only scheme Explorer and Finder speak')
    })

    it('announces itself as WebDAV once the request authenticates', async () => {
        const res = await request('OPTIONS', '/', { headers: { authorization: as('alice') } })
        assert.equal(res.status, 200)
        assert.match(res.headers.allow ?? '', /PROPFIND/)
        assert.equal(res.headers['ms-author-via'], 'DAV')
        assert.equal(res.headers['cache-control'], 'no-cache',
            'a discovery answer that can be cached is one a client keeps refusing')
    })

    it('advertises the same compliance classes as the endpoints beneath it', async () => {
        // Finder refuses a read-write mount without class 2, and both it and
        // the redirector read capability at the ROOT and decide the whole
        // mount from it. Deliberately more than this resource can do on its
        // own — RFC 4918 §18.2 wants LOCK from a class 2 resource and `Allow`
        // says this one serves OPTIONS and PROPFIND. See respondOptions.
        const res = await request('OPTIONS', '/', { headers: { authorization: as('alice') } })
        for (const compliance of ['1', '2', '3']) {
            assert.match(res.headers.dav ?? '', new RegExp(`\\b${compliance}\\b`),
                `the root must claim class ${compliance}, as the endpoints do`)
        }
    })

    it('keeps Allow truthful about what the root itself serves', async () => {
        // The other half of advertising class 2: a client that asks what this
        // resource permits must not be told it can LOCK here.
        const res = await request('OPTIONS', '/', { headers: { authorization: as('alice') } })
        assert.doesNotMatch(res.headers.allow ?? '', /LOCK/,
            'the root is read-only and must say so')
    })

    it('answers an authenticated OPTIONS on the listing too', async () => {
        // The 207 carries a DAV header of its own, and a client reading class
        // from either answer must get the same story.
        const res = await propfind({ headers: { authorization: as('alice') } })
        assert.equal(res.status, 207)
        assert.match(res.headers.dav ?? '', /\b2\b/)
    })

    it('challenges an anonymous listing, so a DAV client prompts', async () => {
        const res = await propfind()
        assert.equal(res.status, 401)
        assert.match(res.headers['www-authenticate'] ?? '', /^Basic /,
            'Basic is the only scheme Explorer and Finder speak')
    })

    it('challenges an unknown user, which is what a challenge is for', async () => {
        const res = await request('OPTIONS', '/', { headers: { authorization: as('dave') } })
        assert.equal(res.status, 401)
    })

    it('accepts a bearer-carrying client at the root', async () => {
        // rclone and curl carry a token rather than Basic. Challenging
        // OPTIONS must not turn them away — the verifier already accepts
        // them, and OPTIONS now goes through the same verifier PROPFIND does.
        const listing = await propfind({ headers: { authorization: as('carol') } })
        assert.equal(listing.status, 207, 'precondition: this principal can list')
        const res = await request('OPTIONS', '/', { headers: { authorization: as('carol') } })
        assert.equal(res.status, 200, 'the same credentials must satisfy OPTIONS')
    })

    it('leaves the endpoint mounts beneath it untouched', async () => {
        // A different code path — the Nephele mounts, not this middleware —
        // and the report asked for it to stay exactly as it was.
        const res = await request('OPTIONS', '/SkinCheck',
            { headers: { authorization: as('alice') } })
        assert.equal(res.status, 200)
        for (const compliance of ['1', '2']) {
            assert.match(res.headers.dav ?? '', new RegExp(`\\b${compliance}\\b`))
        }
    })

    it('lists only the endpoints the user may read', async () => {
        const xml = (await propfind({ headers: { authorization: as('alice') } })).body
        assert.match(xml, /<D:href>\/SkinCheck\/<\/D:href>/, xml)
        assert.doesNotMatch(xml, /Reports/, 'bob\'s endpoint is not alice\'s to see')
        assert.doesNotMatch(xml, /Media/, 'nor one nobody granted her')
    })

    it('shows a different user a different drive', async () => {
        const xml = (await propfind({ headers: { authorization: as('bob') } })).body
        assert.match(xml, /<D:href>\/Reports\/<\/D:href>/, xml)
        assert.doesNotMatch(xml, /SkinCheck/, xml)
    })

    it('gives a wildcard holder everything, under its display name', async () => {
        const xml = (await propfind({ headers: { authorization: as('carol') } })).body
        for (const name of ['SkinCheck', 'Reports', 'Media']) {
            assert.match(xml, new RegExp(`<D:href>/${name}/</D:href>`), `${name} missing:\n${xml}`)
        }
        assert.match(xml, /<D:displayname>Media library<\/D:displayname>/,
            'the listing uses the same name the mount reports')
    })

    it('describes only itself at Depth 0', async () => {
        const xml = (await propfind({ headers: { authorization: as('carol'), depth: '0' } })).body
        assert.match(xml, /<D:href>\/<\/D:href>/)
        assert.doesNotMatch(xml, /SkinCheck/, 'Depth 0 is the collection, not its children')
    })

    it('leaves every other host alone', async () => {
        // The whole safety of mounting at `/`. Without the Host gate a drive
        // shadows every page on the site.
        for (const method of ['OPTIONS', 'PROPFIND']) {
            const res = await request(method, '/', { host: 'www.example.test', headers: { depth: '1' } })
            assert.notEqual(res.status, 207, `${method} answered for the wrong host`)
            assert.equal(res.headers.dav, undefined, `${method} advertised DAV to the wrong host`)
        }
    })

    it('serves the endpoint itself beneath the root', async () => {
        const res = await request('PROPFIND', '/SkinCheck/', {
            headers: { depth: '1', authorization: as('alice') },
        })
        assert.equal(res.status, 207, res.body)
        assert.match(res.body, /page\.md/, 'entering an endpoint reaches its real files')
    })
})
