import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, mkdir, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import bcrypt from 'bcryptjs'
import { createClient } from 'webdav'

import { runtime } from 'mikser-io'
import { auth } from 'mikser-io-auth'
import { drive } from '../index.js'

// Everything else in this suite drives the server with fetch and hand-written
// XML, which tests the protocol as I understand it. This file drives it with
// `webdav` (perry-mitchell/webdav-client) — a third-party client that builds
// its own PROPFIND bodies, parses its own multistatus responses, and has its
// own opinions about what a compliant server does. If my understanding of
// WebDAV is wrong somewhere, this is what notices.
let server, port, dir, content
let editor, reviewer, stranger

before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mikser-drive-client-'))
    content = path.join(dir, 'documents')
    await mkdir(path.join(content, 'guides'), { recursive: true })
    await mkdir(path.join(dir, 'runtime'), { recursive: true })
    await writeFile(path.join(content, 'index.md'), '# index\n')
    await writeFile(path.join(content, 'guides', 'start.md'), '# start\n')

    await writeFile(path.join(dir, 'users.htpasswd'), ['alice', 'bob', 'carol']
        .map(u => `${u}:${bcrypt.hashSync(`${u}-pw`, 10)}`).join('\n') + '\n')
    await writeFile(path.join(dir, 'groups.htgroup'), 'editors: alice\nreviewers: bob\n')

    const { default: express } = await import('express')
    const app = express()
    runtime.options = { ...runtime.options, app, workingFolder: dir, runtimeFolder: path.join(dir, 'runtime') }
    runtime.config = { ...runtime.config }
    runtime.engine = { ...runtime.engine, logger: { info(){}, warn(){}, error(){}, debug(){}, trace(){}, fatal(){} } }

    const identity = auth({
        capabilities: {
            editors:   ['drive:content', 'drive:content:write'],
            reviewers: ['drive:content'],
        },
    })
    const plugin = drive({ endpoints: { content: { folder: 'documents' } }, auth: identity })

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

    const url = `http://127.0.0.1:${port}/drive/content`
    editor   = createClient(url, { username: 'alice', password: 'alice-pw' })
    reviewer = createClient(url, { username: 'bob',   password: 'bob-pw' })
    stranger = createClient(url, { username: 'carol', password: 'carol-pw' })
})

after(async () => {
    await new Promise(r => server?.close(r))
    await rm(dir, { recursive: true, force: true })
})

describe('a real client browses the tree', () => {
    it('lists a directory and reports types and sizes', async () => {
        const items = await editor.getDirectoryContents('/')
        const byName = Object.fromEntries(items.map(i => [i.basename, i]))
        assert.equal(byName['index.md'].type, 'file')
        assert.equal(byName['index.md'].size, '# index\n'.length)
        assert.equal(byName['guides'].type, 'directory')
    })

    it('walks into a subdirectory', async () => {
        const items = await editor.getDirectoryContents('/guides')
        assert.deepEqual(items.map(i => i.basename), ['start.md'])
    })

    it('fetches deep contents in one call', async () => {
        const items = await editor.getDirectoryContents('/', { deep: true })
        const names = items.map(i => i.filename).sort()
        assert.ok(names.includes('/guides/start.md'), `got ${JSON.stringify(names)}`)
    })

    it('stats a single file', async () => {
        const stat = await editor.stat('/index.md')
        assert.equal(stat.basename, 'index.md')
        assert.equal(stat.type, 'file')
        assert.ok(stat.lastmod, 'a live property the client actually parses')
    })

    it('reports existence correctly both ways', async () => {
        assert.equal(await editor.exists('/index.md'), true)
        assert.equal(await editor.exists('/nope.md'), false)
    })
})

describe('a real client reads and writes', () => {
    it('round-trips text', async () => {
        await editor.putFileContents('/written.md', '# by a real client\n')
        assert.equal(await editor.getFileContents('/written.md', { format: 'text' }), '# by a real client\n')
        assert.equal(await readFile(path.join(content, 'written.md'), 'utf8'), '# by a real client\n')
    })

    it('round-trips binary without corrupting it', async () => {
        // 256KB of every byte value, so any encoding mistake shows up.
        const bytes = Buffer.from(Array.from({ length: 262144 }, (_, i) => i % 256))
        await editor.putFileContents('/blob.bin', bytes)
        const back = await editor.getFileContents('/blob.bin')
        assert.equal(Buffer.compare(Buffer.from(back), bytes), 0)
    })

    it('creates and removes a directory', async () => {
        await editor.createDirectory('/new-section')
        assert.equal((await editor.stat('/new-section')).type, 'directory')
        await editor.deleteFile('/new-section')
        assert.equal(await editor.exists('/new-section'), false)
    })

    it('creates a nested directory path', async () => {
        await editor.createDirectory('/a/b/c', { recursive: true })
        assert.equal((await editor.stat('/a/b/c')).type, 'directory')
    })

    it('moves a file', async () => {
        await editor.putFileContents('/to-move.md', 'x')
        await editor.moveFile('/to-move.md', '/moved.md')
        assert.equal(await editor.exists('/to-move.md'), false)
        assert.equal(await editor.exists('/moved.md'), true)
    })

    it('copies a file', async () => {
        await editor.copyFile('/index.md', '/index-copy.md')
        assert.equal(await editor.getFileContents('/index-copy.md', { format: 'text' }), '# index\n')
        assert.equal(await editor.exists('/index.md'), true, 'the source survives a copy')
    })

    it('deletes a file', async () => {
        await editor.putFileContents('/temp.md', 'x')
        await editor.deleteFile('/temp.md')
        assert.equal(await editor.exists('/temp.md'), false)
    })

    it('streams a download', async () => {
        const chunks = []
        const stream = editor.createReadStream('/index.md')
        for await (const chunk of stream) chunks.push(chunk)
        assert.equal(Buffer.concat(chunks).toString(), '# index\n')
    })

    it('streams an upload', async () => {
        await new Promise((resolve, reject) => {
            const stream = editor.createWriteStream('/streamed.md', {}, resolve)
            stream.on('error', reject)
            stream.end('# streamed\n')
        })
        assert.equal(await readFile(path.join(content, 'streamed.md'), 'utf8'), '# streamed\n')
    })
})

describe('a real client meets the capability model', () => {
    it('a reviewer reads', async () => {
        const items = await reviewer.getDirectoryContents('/')
        assert.ok(items.length > 0)
        assert.equal(await reviewer.getFileContents('/index.md', { format: 'text' }), '# index\n')
    })

    it('a reviewer is refused every kind of write', async () => {
        await assert.rejects(() => reviewer.putFileContents('/nope.md', 'x'), /403|Forbidden/i)
        await assert.rejects(() => reviewer.createDirectory('/nope'), /403|Forbidden/i)
        await assert.rejects(() => reviewer.deleteFile('/index.md'), /403|Forbidden/i)
        await assert.rejects(() => reviewer.moveFile('/index.md', '/x.md'), /403|Forbidden/i)
        await assert.rejects(() => reviewer.copyFile('/index.md', '/y.md'), /403|Forbidden/i)
        assert.equal(await readFile(path.join(content, 'index.md'), 'utf8'), '# index\n')
    })

    it('a user with no grant for this endpoint cannot even list it', async () => {
        await assert.rejects(() => stranger.getDirectoryContents('/'), /403|Forbidden/i)
    })

    it('a wrong password is refused', async () => {
        const impostor = createClient(`http://127.0.0.1:${port}/drive/content`,
                                      { username: 'alice', password: 'wrong' })
        await assert.rejects(() => impostor.getDirectoryContents('/'), /401|Unauthorized/i)
    })
})

describe('the client sees no staging artifacts', () => {
    it('a large upload leaves exactly one file and no .part', async () => {
        const bytes = Buffer.alloc(512 * 1024, 7)
        await editor.putFileContents('/large.bin', bytes)
        const items = await editor.getDirectoryContents('/')
        const names = items.map(i => i.basename)
        assert.ok(names.includes('large.bin'))
        assert.deepEqual(names.filter(n => n.endsWith('.part')), [])
        assert.deepEqual((await readdir(content)).filter(n => n.endsWith('.part')), [])
    })
})
