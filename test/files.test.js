import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { runtime } from 'mikser-io'
import { registerFileTools } from '../lib/files.js'
import { readCapability, writeCapability } from '../index.js'

// These carry bytes through the tool, for a caller with no route to the host.
// What a stored file BECOMES is the pipeline's business, and the whole point of
// the response is reporting that rather than assuming it — so the parts that
// depend on a catalog say so rather than being faked here.

let dir, mcp, tools

function fakeSubstrate(principal) {
    const registry = new Map()
    return {
        principal: () => principal,
        registerTool: (name, def, handler) => registry.set(name, handler),
        call: (name, args) => registry.get(name)(args ?? {}),
        names: () => [...registry.keys()],
    }
}

const b64 = (s) => Buffer.from(s).toString('base64')
// A 1x1 PNG, so the viewable path has something real to return.
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64')

const body = (r) => JSON.parse(r.content.find(c => c.type === 'text').text)
const call = (name, args) => mcp.call(name, args)

before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mikser-files-'))
    await mkdir(path.join(dir, 'media'), { recursive: true })
    await mkdir(path.join(dir, 'locked'), { recursive: true })
    runtime.options = { ...runtime.options, workingFolder: dir, runtimeFolder: path.join(dir, 'runtime') }

    mcp = fakeSubstrate({ subject: 'alice', capabilities: ['webdav:media', 'webdav:media:write'] })
    registerFileTools({
        runtime: { options: { ...runtime.options, mcp }, refs: runtime.refs },
        endpoints: { media: { folder: 'media' }, locked: { folder: 'locked', readOnly: true } },
        capabilityOf: readCapability, writeCapabilityOf: writeCapability,
    })
    tools = mcp.names()
})

after(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

describe('registration', () => {
    it('registers exactly the four file tools', () => {
        assert.deepEqual(tools.sort(),
            ['mikser_webdav_add', 'mikser_webdav_delete', 'mikser_webdav_move', 'mikser_webdav_read'])
    })
})

describe('add', () => {
    it('stores a batch in one call, under one cycle', async () => {
        // Ten files, one cycleId — not one rebuild per file.
        const files = Array.from({ length: 10 }, (_, i) =>
            ({ name: `shot-${i}.png`, base64: PNG.toString('base64'), mime: 'image/png' }))
        const r = body(await call('mikser_webdav_add', { endpoint: 'media', folder: 'batch', files }))
        assert.equal(r.stored, 10)
        assert.equal(typeof r.cycleId, 'number')
        for (const f of r.files) {
            assert.equal(f.size, PNG.length)
            assert.equal(f.mime, 'image/png')
        }
        assert.ok(await stat(path.join(dir, 'media/batch/shot-0.png')))
        assert.ok(await stat(path.join(dir, 'media/batch/shot-9.png')))
    })

    it('refuses an existing file rather than replacing it silently', async () => {
        const one = [{ name: 'once.txt', base64: b64('first') }]
        assert.equal(body(await call('mikser_webdav_add', { endpoint: 'media', files: one })).stored, 1)

        const again = await call('mikser_webdav_add',
            { endpoint: 'media', files: [{ name: 'once.txt', base64: b64('second') }] })
        assert.equal(again.isError, true)
        assert.match(again.content[0].text, /already exist/)
        assert.equal(await readFile(path.join(dir, 'media/once.txt'), 'utf8'), 'first',
            'the original must be untouched')
    })

    it('replaces when told to, and says it replaced', async () => {
        const r = body(await call('mikser_webdav_add',
            { endpoint: 'media', overwrite: true, files: [{ name: 'once.txt', base64: b64('third') }] }))
        assert.equal(r.files[0].replaced, true)
        assert.equal(await readFile(path.join(dir, 'media/once.txt'), 'utf8'), 'third')
    })

    it('writes NOTHING when any file in the batch is bad', async () => {
        // Decoded and checked before a single write. A batch that fails halfway
        // leaves the caller unable to say what landed.
        const r = await call('mikser_webdav_add', { endpoint: 'media', folder: 'atomic', files: [
            { name: 'good.txt', base64: b64('fine') },
            { name: 'bad.txt', base64: '' },
        ] })
        assert.equal(r.isError, true)
        await assert.rejects(() => stat(path.join(dir, 'media/atomic/good.txt')))
    })

    it('refuses a name that would escape the folder', async () => {
        for (const name of ['../escape.txt', 'a/../../escape.txt', '/abs.txt', '.hidden']) {
            const r = await call('mikser_webdav_add', { endpoint: 'media', files: [{ name, base64: b64('x') }] })
            assert.equal(r.isError, true, `${name} must be refused`)
        }
        await assert.rejects(() => stat(path.join(dir, 'escape.txt')))
    })

    it('refuses a file over the per-file cap, and points somewhere useful', async () => {
        const big = Buffer.alloc(3 * 1024 * 1024, 1).toString('base64')
        const r = await call('mikser_webdav_add', { endpoint: 'media', files: [{ name: 'big.bin', base64: big }] })
        assert.equal(r.isError, true)
        assert.match(r.content[0].text, /per-file cap/)
        assert.match(r.content[0].text, /WebDAV mount/)
        assert.match(r.content[0].text, /Nothing was written/)
    })

    it('refuses a readOnly endpoint, and names the real ones for a wrong guess', async () => {
        const ro = await call('mikser_webdav_add', { endpoint: 'locked', files: [{ name: 'x.txt', base64: b64('x') }] })
        assert.equal(ro.isError, true)
        assert.match(ro.content[0].text, /readOnly/)

        const nope = await call('mikser_webdav_add', { endpoint: 'nope', files: [{ name: 'x.txt', base64: b64('x') }] })
        assert.equal(nope.isError, true)
        assert.match(nope.content[0].text, /media, locked/)
    })

    it('dryRun reports the cost and writes nothing', async () => {
        const r = body(await call('mikser_webdav_add', { endpoint: 'media', dryRun: true, folder: 'dry', files: [
            { name: 'a.txt', base64: b64('hello') },
        ] }))
        assert.equal(r.dryRun, true)
        assert.equal(r.totalBytes, 5)
        assert.equal(typeof r.approxTokens, 'number')
        assert.equal(r.files[0].wouldOverwrite, false)
        await assert.rejects(() => stat(path.join(dir, 'media/dry/a.txt')))
    })
})

describe('read', () => {
    it('returns an image as an image, with the facts beside it', async () => {
        await call('mikser_webdav_add', { endpoint: 'media', files: [
            { name: 'look.png', base64: PNG.toString('base64'), mime: 'image/png' } ] })
        const r = await call('mikser_webdav_read', { path: 'media/look.png' })
        const image = r.content.find(c => c.type === 'image')
        assert.ok(image, 'a model must be able to look at it, not be refused')
        assert.equal(image.mimeType, 'image/png')
        assert.equal(body(r).size, PNG.length)
    })

    it('returns text as text', async () => {
        await call('mikser_webdav_add', { endpoint: 'media', files: [{ name: 'note.txt', base64: b64('readable') }] })
        assert.equal(body(await call('mikser_webdav_read', { path: 'media/note.txt' })).content, 'readable')
    })

    it('describes a binary it cannot show rather than returning garbage', async () => {
        await call('mikser_webdav_add', { endpoint: 'media', files: [{ name: 'font.woff2', base64: b64(' ') }] })
        const r = body(await call('mikser_webdav_read', { path: 'media/font.woff2' }))
        assert.equal(r.viewed, false)
        assert.equal(r.content, undefined)
        assert.match(r.note, /convincing garbage/)
    })

    it('says so when there is nothing there', async () => {
        const r = await call('mikser_webdav_read', { path: 'media/absent.png' })
        assert.equal(r.isError, true)
    })
})

describe('delete', () => {
    it('moves to trash rather than unlinking, and can be undone', async () => {
        await call('mikser_webdav_add', { endpoint: 'media', files: [{ name: 'bye.txt', base64: b64('content') }] })
        const r = body(await call('mikser_webdav_delete', { path: 'media/bye.txt' }))
        assert.equal(r.removed, true)
        await assert.rejects(() => stat(path.join(dir, 'media/bye.txt')), 'gone from the folder')
        // Still on disk, so a wrong delete is a move back and not a restore.
        assert.ok(await stat(path.join(dir, r.trash)))
        assert.match(r.restore, /Move it back/)
    })

    it('puts trash OUTSIDE the served folder', async () => {
        // Inside it, the file would be republished at a new URL and, where git
        // sync is on, committed.
        await call('mikser_webdav_add', { endpoint: 'media', files: [{ name: 'gone.txt', base64: b64('x') }] })
        const r = body(await call('mikser_webdav_delete', { path: 'media/gone.txt' }))
        assert.equal(r.trash.startsWith('media/'), false, `trash must not be inside the endpoint: ${r.trash}`)
    })

    it('refuses a readOnly endpoint', async () => {
        await writeFile(path.join(dir, 'locked/x.txt'), 'x')
        const r = await call('mikser_webdav_delete', { path: 'locked/x.txt' })
        assert.equal(r.isError, true)
        assert.match(r.content[0].text, /readOnly/)
    })

    it('dryRun removes nothing', async () => {
        await call('mikser_webdav_add', { endpoint: 'media', files: [{ name: 'keep.txt', base64: b64('x') }] })
        const r = body(await call('mikser_webdav_delete', { path: 'media/keep.txt', dryRun: true }))
        assert.equal(r.dryRun, true)
        assert.ok(await stat(path.join(dir, 'media/keep.txt')))
    })

    it('always states what its reference check does NOT cover', async () => {
        // An empty list means "nothing of the kind I look at", not "nothing".
        await call('mikser_webdav_add', { endpoint: 'media', files: [{ name: 'cov.txt', base64: b64('x') }] })
        const r = body(await call('mikser_webdav_delete', { path: 'media/cov.txt', dryRun: true }))
        assert.match(r.coverage, /NOT body text/)
    })
})

describe('move', () => {
    const put = (name, text) => call('mikser_webdav_add',
        { endpoint: 'media', files: [{ name, base64: b64(text) }] })

    it('moves a file that nothing references', async () => {
        await put('loose.txt', 'x')
        const r = body(await call('mikser_webdav_move', { from: 'media/loose.txt', to: 'moved/loose.txt' }))
        assert.equal(r.moved, true)
        assert.ok(await stat(path.join(dir, 'media/moved/loose.txt')))
        await assert.rejects(() => stat(path.join(dir, 'media/loose.txt')))
    })

    it('refuses to land on something that already exists', async () => {
        await put('a.txt', 'a')
        await put('b.txt', 'b')
        const r = await call('mikser_webdav_move', { from: 'media/a.txt', to: 'b.txt' })
        assert.equal(r.isError, true)
        assert.match(r.content[0].text, /already exists/)
        // Neither file moved.
        assert.equal(await readFile(path.join(dir, 'media/a.txt'), 'utf8'), 'a')
        assert.equal(await readFile(path.join(dir, 'media/b.txt'), 'utf8'), 'b')
    })

    it('refuses a destination that would escape the endpoint', async () => {
        await put('stay.txt', 'x')
        const r = await call('mikser_webdav_move', { from: 'media/stay.txt', to: '../../escaped.txt' })
        assert.equal(r.isError, true)
        assert.ok(await stat(path.join(dir, 'media/stay.txt')))
    })

    it('refuses a no-op move rather than pretending it did something', async () => {
        await put('same.txt', 'x')
        const r = await call('mikser_webdav_move', { from: 'media/same.txt', to: 'same.txt' })
        assert.equal(r.isError, true)
        assert.match(r.content[0].text, /same path/)
    })

    it('states what its reference check does not cover', async () => {
        await put('cover.txt', 'x')
        const r = body(await call('mikser_webdav_move',
            { from: 'media/cover.txt', to: 'elsewhere.txt', dryRun: true }))
        assert.equal(r.dryRun, true)
        assert.match(r.coverage, /NOT body text/)
        assert.ok(await stat(path.join(dir, 'media/cover.txt')), 'dryRun moves nothing')
    })

    it('refuses a readOnly endpoint', async () => {
        await writeFile(path.join(dir, 'locked/ro.txt'), 'x')
        const r = await call('mikser_webdav_move', { from: 'locked/ro.txt', to: 'other.txt' })
        assert.equal(r.isError, true)
        assert.match(r.content[0].text, /readOnly/)
    })
})
