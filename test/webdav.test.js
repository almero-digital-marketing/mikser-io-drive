import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import bcrypt from 'bcryptjs'

import { runtime } from 'mikser-io'
import { auth } from 'mikser-io-auth'
import { webdav } from '../index.js'

// A real Nephele server over a real directory, authenticated through a real
// htpasswd file. WebDAV is almost entirely I/O and protocol; a mocked
// version of it would prove nothing.
let server, port, dir, content

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
const as  = (user) => ({ authorization: `Basic ${b64(`${user}:${user}-pw`)}` })

before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mikser-webdav-'))
    content = path.join(dir, 'documents')
    await mkdir(content, { recursive: true })
    await mkdir(path.join(dir, 'runtime'), { recursive: true })
    await writeFile(path.join(content, 'page.md'), '# hello\n')

    await writeFile(path.join(dir, 'users.htpasswd'), ['alice', 'bob', 'carol']
        .map(u => `${u}:${bcrypt.hashSync(`${u}-pw`, 10)}`).join('\n') + '\n')
    await writeFile(path.join(dir, 'groups.htgroup'),
        'editors: alice\nreviewers: bob\n')

    const { default: express } = await import('express')
    const app = express()

    runtime.options = { ...runtime.options, app, workingFolder: dir, runtimeFolder: path.join(dir, 'runtime') }
    runtime.config = { ...runtime.config }
    runtime.engine = { ...runtime.engine, logger: { info(){}, warn(){}, error(){}, debug(){}, trace(){}, fatal(){} } }

    const identity = auth({
        capabilities: {
            // Capability names are derived from the endpoint name, so an
            // endpoint you were never granted is invisible to you — which is
            // why `editors` has to name `webdav:locked` too.
            editors:   ['webdav:content', 'webdav:content:write', 'webdav:locked'],
            reviewers: ['webdav:content'],                          // read, no write
        },
    })

    const plugin = webdav({
        endpoints: {
            content: { folder: 'documents' },
            locked:  { folder: 'documents', readOnly: true },
        },
        auth: identity,
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

    server = await new Promise(resolve => {
        const s = app.listen(0, () => resolve(s))
    })
    port = server.address().port
})

after(async () => {
    await new Promise(r => server?.close(r))
    await rm(dir, { recursive: true, force: true })
})

const dav = (method, p, { headers = {}, body } = {}) =>
    fetch(`http://127.0.0.1:${port}${p}`, { method, headers, body })

describe('auth', () => {
    it('challenges an anonymous request with Basic, so a DAV client prompts', async () => {
        const res = await dav('PROPFIND', '/webdav/content/', { headers: { depth: '0' } })
        assert.equal(res.status, 401)
        assert.match(res.headers.get('www-authenticate'), /^Basic realm="mikser"/)
        assert.match(res.headers.get('www-authenticate'), /charset="UTF-8"/)
    })

    it('refuses a wrong password', async () => {
        const res = await dav('PROPFIND', '/webdav/content/', {
            headers: { depth: '0', authorization: `Basic ${b64('alice:wrong')}` },
        })
        assert.equal(res.status, 401)
    })

    it('lets a granted user list the collection', async () => {
        const res = await dav('PROPFIND', '/webdav/content/', { headers: { depth: '1', ...as('alice') } })
        assert.equal(res.status, 207)
        const xml = await res.text()
        assert.match(xml, /page\.md/)
    })

    it('403s an authenticated user who lacks the endpoint capability', async () => {
        // carol is in no group, so with a capability map configured she holds
        // nothing — authenticated, but not for this endpoint.
        const res = await dav('PROPFIND', '/webdav/content/', { headers: { depth: '0', ...as('carol') } })
        assert.equal(res.status, 403)
    })
})

describe('read and write', () => {
    it('GETs a file', async () => {
        const res = await dav('GET', '/webdav/content/page.md', { headers: as('alice') })
        assert.equal(res.status, 200)
        assert.equal(await res.text(), '# hello\n')
    })

    it('PUTs a file, and it lands in the working folder where the build will see it', async () => {
        const res = await dav('PUT', '/webdav/content/new.md', {
            headers: { ...as('alice'), 'content-type': 'text/markdown' },
            body: '# written over dav\n',
        })
        assert.ok([201, 204].includes(res.status), `unexpected ${res.status}`)
        assert.equal(await readFile(path.join(content, 'new.md'), 'utf8'), '# written over dav\n')
    })

    it('DELETEs a file', async () => {
        await dav('PUT', '/webdav/content/gone.md', { headers: as('alice'), body: 'x' })
        const res = await dav('DELETE', '/webdav/content/gone.md', { headers: as('alice') })
        assert.ok([200, 204].includes(res.status), `unexpected ${res.status}`)
        await assert.rejects(() => readFile(path.join(content, 'gone.md')))
    })
})

describe('write capability is per request, not per mount', () => {
    it('a user with read but not write gets a read-only view of the SAME endpoint', async () => {
        // bob is a reviewer: holds webdav:content, not webdav:content:write.
        const list = await dav('PROPFIND', '/webdav/content/', { headers: { depth: '0', ...as('bob') } })
        assert.equal(list.status, 207, 'bob can read')

        const write = await dav('PUT', '/webdav/content/bob.md', { headers: as('bob'), body: 'nope' })
        assert.ok(write.status >= 400, `bob should not write, got ${write.status}`)
        await assert.rejects(() => readFile(path.join(content, 'bob.md')),
                             'nothing should have been written')
    })

    it('and the same URL is writable for someone who holds the capability', async () => {
        const write = await dav('PUT', '/webdav/content/alice.md', { headers: as('alice'), body: 'yes' })
        assert.ok([201, 204].includes(write.status))
    })
})

describe('an endpoint you were not granted is refused outright', () => {
    it('403s a user who holds no capability for it', async () => {
        // bob is a reviewer: webdav:content only, nothing for `locked`.
        const res = await dav('PROPFIND', '/webdav/locked/', { headers: { depth: '0', ...as('bob') } })
        assert.equal(res.status, 403)
    })
})

describe('readOnly is a hard cap', () => {
    it('refuses a write even from a user who holds every capability', async () => {
        // alice holds webdav:content:write, but this endpoint is readOnly —
        // "nobody writes here" is a different statement from "you may not".
        const res = await dav('PUT', '/webdav/locked/hard.md', { headers: as('alice'), body: 'x' })
        assert.ok(res.status >= 400, `expected a refusal, got ${res.status}`)
        await assert.rejects(() => readFile(path.join(content, 'hard.md')))
    })

    it('still allows reading', async () => {
        const res = await dav('GET', '/webdav/locked/page.md', { headers: as('alice') })
        assert.equal(res.status, 200)
    })
})

describe('no .nephelemeta sidecars in a watched source folder', () => {
    it('a PROPPATCH reports success without writing meta files', async () => {
        // The default 'meta-files' strategy would drop .nephelemeta into the
        // documents folder, where mikser's sources would pick it up as an
        // entity — and a rebuild that writes could trip the watcher again.
        const res = await dav('PROPPATCH', '/webdav/content/page.md', {
            headers: { ...as('alice'), 'content-type': 'text/xml' },
            body: `<?xml version="1.0" encoding="utf-8"?>
<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><customprop xmlns="X:">v</customprop></D:prop></D:set></D:propertyupdate>`,
        })
        assert.ok(res.status < 500, `unexpected ${res.status}`)
        const { readdir } = await import('node:fs/promises')
        const files = await readdir(content)
        assert.deepEqual(files.filter(f => f.includes('nephelemeta')), [],
                         'no sidecar files may appear in a source folder')
    })
})

describe('the write gate covers every mutating method', () => {
    // A gate that only knew about PUT would leave MKCOL, MOVE, COPY and
    // PROPPATCH wide open — each of which changes the working folder, which
    // is what the build reads.
    const cases = [
        ['PUT',       '/webdav/content/x.md',  { body: 'x' }],
        ['DELETE',    '/webdav/content/page.md', {}],
        ['MKCOL',     '/webdav/content/newdir/', {}],
        ['MOVE',      '/webdav/content/page.md', { headers: { destination: '/webdav/content/moved.md' } }],
        ['COPY',      '/webdav/content/page.md', { headers: { destination: '/webdav/content/copied.md' } }],
        ['PROPPATCH', '/webdav/content/page.md', {
            headers: { 'content-type': 'text/xml' },
            body: `<?xml version="1.0" encoding="utf-8"?>
<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><p xmlns="X:">v</p></D:prop></D:set></D:propertyupdate>`,
        }],
        ['LOCK',      '/webdav/content/page.md', {
            headers: { 'content-type': 'text/xml' },
            body: `<?xml version="1.0" encoding="utf-8"?>
<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>`,
        }],
    ]

    for (const [method, url, opts] of cases) {
        it(`refuses ${method} for a reader`, async () => {
            const res = await dav(method, url, {
                ...opts,
                headers: { ...(opts.headers ?? {}), ...as('bob') },
            })
            assert.equal(res.status, 403, `${method} should be 403 for bob, got ${res.status}`)
        })
    }

    it('and still lets a reader read', async () => {
        assert.equal((await dav('GET', '/webdav/content/page.md', { headers: as('bob') })).status, 200)
        assert.equal((await dav('PROPFIND', '/webdav/content/', { headers: { depth: '1', ...as('bob') } })).status, 207)
        assert.equal((await dav('OPTIONS', '/webdav/content/', { headers: as('bob') })).status < 300, true)
    })
})
