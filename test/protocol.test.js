import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, mkdir, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import bcrypt from 'bcryptjs'

import { runtime, junkIgnore, junkFilter } from 'mikser-io'
import { auth } from 'mikser-io-auth'
import { drive } from '../index.js'

// Protocol-surface facts that decide whether a real client will mount at all,
// and what it leaves behind when it does. Found by testing against a real
// client rather than by reading the spec.
let server, port, dir, content
const AUTH = 'Basic ' + Buffer.from('alice:pw').toString('base64')

before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mikser-drive-proto-'))
    content = path.join(dir, 'documents')
    await mkdir(content, { recursive: true })
    await mkdir(path.join(dir, 'runtime'), { recursive: true })
    await writeFile(path.join(content, 'page.md'), '# page\n')
    await writeFile(path.join(dir, 'users.htpasswd'), `alice:${bcrypt.hashSync('pw', 10)}\n`)

    const { default: express } = await import('express')
    const app = express()
    runtime.options = { ...runtime.options, app, workingFolder: dir, runtimeFolder: path.join(dir, 'runtime') }
    runtime.config = { ...runtime.config }
    runtime.engine = { ...runtime.engine, logger: { info(){}, warn(){}, error(){}, debug(){}, trace(){}, fatal(){} } }

    const identity = auth({})
    const plugin = drive({
        endpoints: {
            emulated: { folder: 'documents' },                                        // the default
            strict:   { folder: 'documents', properties: 'disallow', locks: 'disallow' },
            meta:     { folder: 'documents', properties: 'meta-files', locks: 'meta-files' },
        },
        auth: identity,
    })
    const load = [], loaded = []
    const core = {
        runtime,
        onLoad: (c) => load.push(c),
        onLoaded: (c) => loaded.push(c),
        useLogger: () => ({ info(){}, warn(){}, error(){}, debug(){}, trace(){} }),
    }
    identity(core)
    plugin(core)
    for (const c of load) await c()
    for (const c of loaded) await c()

    server = await new Promise(r => { const s = app.listen(0, () => r(s)) })
    port = server.address().port
})

after(async () => {
    await new Promise(r => server?.close(r))
    await rm(dir, { recursive: true, force: true })
})

const options = (ep) => fetch(`http://127.0.0.1:${port}/drive/${ep}/`, {
    method: 'OPTIONS', headers: { authorization: AUTH },
})
const lock = (ep, file = 'page.md') => fetch(`http://127.0.0.1:${port}/drive/${ep}/${file}`, {
    method: 'LOCK',
    headers: { authorization: AUTH, 'content-type': 'text/xml', timeout: 'Second-3600' },
    body: `<?xml version="1.0" encoding="utf-8"?>
<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype>
<D:owner><D:href>test</D:href></D:owner></D:lockinfo>`,
})

describe('DAV compliance class — what decides whether Finder will mount', () => {
    it('the default advertises class 2, which macOS requires for a read-write mount', async () => {
        const res = await options('emulated')
        const dav = res.headers.get('dav')
        assert.match(dav, /\b2\b/, `expected class 2, got ${dav}`)
        assert.match(res.headers.get('allow'), /LOCK/)
    })

    it("locks: 'disallow' DROPS class 2 — a trap for macOS clients", async () => {
        // Documented because it is invisible until someone tries to mount:
        // Finder refuses a read-write mount without class 2.
        const res = await options('strict')
        const dav = res.headers.get('dav')
        assert.ok(!/\b2\b/.test(dav), `expected no class 2, got ${dav}`)
        assert.ok(!/LOCK/.test(res.headers.get('allow')))
    })

    it('every mode returns a usable Lock-Token header', async () => {
        // A distinct file per lock: the meta-files mode PERSISTS locks, so
        // reusing one path makes the second LOCK a legitimate 423.
        for (const ep of ['emulated', 'meta']) {
            const res = await lock(ep, `token-${ep}.md`)
            // 201, not 200: RFC 4918 §9.10.4 has LOCK on an unmapped URL
            // CREATE an empty resource. Worth knowing — a client that locks
            // before writing (Finder's Save As does) leaves an empty file in
            // the content folder even if the write never arrives.
            assert.equal(res.status, 201, ep)
            assert.match(res.headers.get('lock-token'), /^<urn:uuid:/, ep)
        }
    })

    it("but 'emulate' returns an EMPTY lockdiscovery body where 'meta-files' returns the lock", async () => {
        // RFC 4918 puts the activelock in the body. Clients read the header,
        // so this is survivable — but a client that parses the body for the
        // token finds nothing, and that is the cost of a clean folder.
        const emulated = await (await lock('emulated', 'body-emulated.md')).text()
        assert.match(emulated, /<lockdiscovery\s*\/>/)

        const meta = await (await lock('meta', 'body-meta.md')).text()
        assert.match(meta, /<activelock>/)
    })
})

describe('a persisted lock is honoured', () => {
    it('a second LOCK on an already-locked resource is refused', async () => {
        // Only meaningful where locks are persisted. Worth asserting because
        // it is what makes 'meta-files' a real locking implementation rather
        // than a polite one.
        const first = await lock('meta', 'contended.md')
        assert.equal(first.status, 201, 'LOCK on an unmapped URL creates it')
        const second = await lock('meta', 'contended.md')
        assert.equal(second.status, 423, 'expected 423 Locked')
    })
})

describe("nephele's own sidecars are declared to the engine", () => {
    it('the per-file sidecar is NOT dot-prefixed, and would otherwise be imported', async () => {
        // <dir>/.nephelemeta is dot-prefixed and was already invisible;
        // <dir>/page.md.nephelemeta is not, and setting one dead property
        // produced a second entity for the sidecar.
        await fetch(`http://127.0.0.1:${port}/drive/meta/page.md`, {
            method: 'PROPPATCH',
            headers: { authorization: AUTH, 'content-type': 'text/xml' },
            body: `<?xml version="1.0" encoding="utf-8"?>
<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><note xmlns="X:">hi</note></D:prop></D:set></D:propertyupdate>`,
        })
        const onDisk = await readdir(content)
        assert.ok(onDisk.includes('page.md.nephelemeta'),
                  `meta-files should have written the sidecar; got ${JSON.stringify(onDisk)}`)

        const { globby } = await import('globby')
        const scanned = await globby('**/*', { cwd: content, onlyFiles: true, ignore: junkIgnore() })
        assert.deepEqual(scanned.filter(f => f.includes('nephelemeta')), [],
                         'the scan must not pick up a sidecar')

        const watched = (p) => !(/[/\\]\./.test(p) || junkFilter()(p))
        assert.equal(watched(path.join(content, 'page.md.nephelemeta')), false,
                     'the watcher must not pick up a sidecar')
        assert.equal(watched(path.join(content, 'page.md')), true,
                     'and must still pick up real content')
    })

    it('the default mode writes no sidecars at all', async () => {
        await fetch(`http://127.0.0.1:${port}/drive/emulated/page.md`, {
            method: 'PROPPATCH',
            headers: { authorization: AUTH, 'content-type': 'text/xml' },
            body: `<?xml version="1.0" encoding="utf-8"?>
<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><note xmlns="X:">hi</note></D:prop></D:set></D:propertyupdate>`,
        })
        // The 'meta' endpoint above shares this folder, so only assert that
        // emulate added nothing new for a file it alone touched.
        const res = await fetch(`http://127.0.0.1:${port}/drive/emulated/solo.md`, {
            method: 'PUT', headers: { authorization: AUTH }, body: 'x',
        })
        assert.ok([201, 204].includes(res.status))
        await fetch(`http://127.0.0.1:${port}/drive/emulated/solo.md`, {
            method: 'PROPPATCH',
            headers: { authorization: AUTH, 'content-type': 'text/xml' },
            body: `<?xml version="1.0" encoding="utf-8"?>
<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><note xmlns="X:">hi</note></D:prop></D:set></D:propertyupdate>`,
        })
        const onDisk = await readdir(content)
        assert.ok(!onDisk.includes('solo.md.nephelemeta'), 'emulate must not write a sidecar')
    })
})

describe('known nephele non-compliance, pinned', () => {
    // Found with litmus 0.13 (see README). These assertions describe what the
    // dependency does TODAY, wrongly, so that an upgrade which fixes it fails
    // here and gets noticed rather than silently changing behaviour.
    const dav = (method, p, headers = {}) => fetch(`http://127.0.0.1:${port}/drive/${p}`, {
        method, headers: { authorization: AUTH, ...headers },
    })
    const origin = () => `http://127.0.0.1:${port}`

    it('COPY with Overwrite: F protects the destination but reports 207, not 412', async () => {
        // RFC 4918 §9.8.5 requires 412 as the RESPONSE status. Nephele
        // returns 207 with the 412 inside the multistatus body, so a client
        // sees a 2xx and believes the copy happened.
        //
        // The safe half holds: the destination is NOT clobbered. The unsafe
        // half is the false success.
        await fetch(`${origin()}/drive/emulated/ow-src.md`, {
            method: 'PUT', headers: { authorization: AUTH }, body: 'SOURCE',
        })
        await fetch(`${origin()}/drive/emulated/ow-dst.md`, {
            method: 'PUT', headers: { authorization: AUTH }, body: 'ORIGINAL',
        })

        const res = await dav('COPY', 'emulated/ow-src.md', {
            destination: `${origin()}/drive/emulated/ow-dst.md`,
            overwrite: 'F',
        })
        assert.equal(res.status, 207, 'if this becomes 412, nephele fixed it — update the README')
        assert.match(await res.text(), /412 Precondition Failed/)

        const after = await (await dav('GET', 'emulated/ow-dst.md')).text()
        assert.equal(after, 'ORIGINAL', 'the destination must not be clobbered')
    })

    it('MOVE with Overwrite: F behaves the same way', async () => {
        await fetch(`${origin()}/drive/emulated/mv-src.md`, {
            method: 'PUT', headers: { authorization: AUTH }, body: 'SOURCE',
        })
        await fetch(`${origin()}/drive/emulated/mv-dst.md`, {
            method: 'PUT', headers: { authorization: AUTH }, body: 'ORIGINAL',
        })
        const res = await dav('MOVE', 'emulated/mv-src.md', {
            destination: `${origin()}/drive/emulated/mv-dst.md`,
            overwrite: 'F',
        })
        assert.equal(res.status, 207)
        assert.equal(await (await dav('GET', 'emulated/mv-dst.md')).text(), 'ORIGINAL')
        assert.equal((await dav('GET', 'emulated/mv-src.md')).status, 200, 'the source survives')
    })

    it('a malformed PROPFIND body answers 500 where 400 is required', async () => {
        const res = await fetch(`${origin()}/drive/emulated/`, {
            method: 'PROPFIND',
            headers: { authorization: AUTH, 'content-type': 'text/xml', depth: '0' },
            body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:allprop>',   // unterminated
        })
        assert.equal(res.status, 500, 'if this becomes 400, nephele fixed it')
    })
})
