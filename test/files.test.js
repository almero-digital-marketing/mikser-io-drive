import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { runtime, provideService, resetServices } from 'mikser-io'
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

    mcp = fakeSubstrate({ subject: 'alice', capabilities: ['drive:media', 'drive:media:write'] })
    resetServices()
    provideService('mcp', mcp)
    registerFileTools({
        runtime: { options: { ...runtime.options }, refs: runtime.refs },
        endpoints: { media: { folder: 'media' }, locked: { folder: 'locked', readOnly: true } },
        capabilityOf: readCapability, writeCapabilityOf: writeCapability,
    })
    tools = mcp.names()
})

after(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

describe('registration', () => {
    it('registers exactly the four file tools', () => {
        assert.deepEqual(tools.sort(),
            ['mikser_drive_add', 'mikser_drive_delete', 'mikser_drive_move', 'mikser_drive_read'])
    })
})

describe('add', () => {
    it('stores a batch in one call, under one cycle', async () => {
        // Ten files, one cycleId — not one rebuild per file.
        const files = Array.from({ length: 10 }, (_, i) =>
            ({ name: `shot-${i}.png`, base64: PNG.toString('base64'), mime: 'image/png' }))
        const r = body(await call('mikser_drive_add', { endpoint: 'media', folder: 'batch', files }))
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
        assert.equal(body(await call('mikser_drive_add', { endpoint: 'media', files: one })).stored, 1)

        const again = await call('mikser_drive_add',
            { endpoint: 'media', files: [{ name: 'once.txt', base64: b64('second') }] })
        assert.equal(again.isError, true)
        assert.match(again.content[0].text, /already exist/)
        assert.equal(await readFile(path.join(dir, 'media/once.txt'), 'utf8'), 'first',
            'the original must be untouched')
    })

    it('replaces when told to, and says it replaced', async () => {
        const r = body(await call('mikser_drive_add',
            { endpoint: 'media', overwrite: true, files: [{ name: 'once.txt', base64: b64('third') }] }))
        assert.equal(r.files[0].replaced, true)
        assert.equal(await readFile(path.join(dir, 'media/once.txt'), 'utf8'), 'third')
    })

    it('writes NOTHING when any file in the batch is bad', async () => {
        // Decoded and checked before a single write. A batch that fails halfway
        // leaves the caller unable to say what landed.
        const r = await call('mikser_drive_add', { endpoint: 'media', folder: 'atomic', files: [
            { name: 'good.txt', base64: b64('fine') },
            { name: 'bad.txt', base64: '' },
        ] })
        assert.equal(r.isError, true)
        await assert.rejects(() => stat(path.join(dir, 'media/atomic/good.txt')))
    })

    it('refuses a name that would escape the folder', async () => {
        for (const name of ['../escape.txt', 'a/../../escape.txt', '/abs.txt', '.hidden']) {
            const r = await call('mikser_drive_add', { endpoint: 'media', files: [{ name, base64: b64('x') }] })
            assert.equal(r.isError, true, `${name} must be refused`)
        }
        await assert.rejects(() => stat(path.join(dir, 'escape.txt')))
    })

    it('refuses a file over the per-file cap, and points somewhere useful', async () => {
        const big = Buffer.alloc(3 * 1024 * 1024, 1).toString('base64')
        const r = await call('mikser_drive_add', { endpoint: 'media', files: [{ name: 'big.bin', base64: big }] })
        assert.equal(r.isError, true)
        assert.match(r.content[0].text, /per-file cap/)
        assert.match(r.content[0].text, /WebDAV mount/)
        assert.match(r.content[0].text, /Nothing was written/)
    })

    it('refuses a readOnly endpoint, and names the real ones for a wrong guess', async () => {
        const ro = await call('mikser_drive_add', { endpoint: 'locked', files: [{ name: 'x.txt', base64: b64('x') }] })
        assert.equal(ro.isError, true)
        assert.match(ro.content[0].text, /readOnly/)

        const nope = await call('mikser_drive_add', { endpoint: 'nope', files: [{ name: 'x.txt', base64: b64('x') }] })
        assert.equal(nope.isError, true)
        assert.match(nope.content[0].text, /media, locked/)
    })

    it('dryRun reports the cost and writes nothing', async () => {
        const r = body(await call('mikser_drive_add', { endpoint: 'media', dryRun: true, folder: 'dry', files: [
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
        await call('mikser_drive_add', { endpoint: 'media', files: [
            { name: 'look.png', base64: PNG.toString('base64'), mime: 'image/png' } ] })
        const r = await call('mikser_drive_read', { path: 'media/look.png' })
        const image = r.content.find(c => c.type === 'image')
        assert.ok(image, 'a model must be able to look at it, not be refused')
        assert.equal(image.mimeType, 'image/png')
        assert.equal(body(r).size, PNG.length)
    })

    it('returns text as text', async () => {
        await call('mikser_drive_add', { endpoint: 'media', files: [{ name: 'note.txt', base64: b64('readable') }] })
        assert.equal(body(await call('mikser_drive_read', { path: 'media/note.txt' })).content, 'readable')
    })

    it('describes a binary it cannot show rather than returning garbage', async () => {
        // Genuinely binary bytes. The previous fixture was a single SPACE
        // named .woff2, which passed only because the extension was unknown —
        // it asserted the old extension rule, not the behaviour the name
        // describes, and a real font would have been indistinguishable from a
        // real template.
        const woff2 = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0x00, 0x00])
        await call('mikser_drive_add', { endpoint: 'media', files: [
            { name: 'font.woff2', base64: woff2.toString('base64') } ] })
        const r = body(await call('mikser_drive_read', { path: 'media/font.woff2' }))
        assert.equal(r.viewed, false)
        assert.equal(r.content, undefined)
        assert.match(r.note, /convincing garbage/)
    })

    // The reported bug: `.liquid` mapped to application/octet-stream, so the
    // tool refused to return a template this very engine renders — leaving a
    // caller with a stale catalog copy, two checksums, and no way to see the
    // bytes it was about to overwrite.
    it('returns a template whose extension it has never heard of', async () => {
        const template = '{% assign city = "Лозенец" %}\n<h1>{{ city }}</h1>\n'
        await call('mikser_drive_add', { endpoint: 'media', files: [
            { name: 'page.liquid', base64: Buffer.from(template, 'utf8').toString('base64') } ] })
        const r = body(await call('mikser_drive_read', { path: 'media/page.liquid' }))
        assert.equal(r.content, template, 'the actual disk bytes, not a refusal')
        assert.equal(r.contentComplete, true)
        assert.equal(r.typedBy, 'content', 'and it should say the extension was not what decided this')
    })

    it('does the same for any other textual extension, without a list to keep', async () => {
        // One test per render plugin is the shape this fix exists to avoid.
        for (const [name, text] of [
            ['view.hbs', '<h1>{{title}}</h1>'],
            ['view.eta', '<h1><%= it.title %></h1>'],
            ['conf.toml', 'title = "x"\n'],
            ['rows.csv', 'a,b\n1,2\n'],
            ['query.sql', 'select 1;\n'],
            ['notes.rst', 'Title\n=====\n'],
        ]) {
            await call('mikser_drive_add', { endpoint: 'media', files: [
                { name, base64: Buffer.from(text, 'utf8').toString('base64') } ] })
            const r = body(await call('mikser_drive_read', { path: `media/${name}` }))
            assert.equal(r.content, text, `${name} must come back as text`)
        }
    })

    it('names types the old hand-written map had never heard of', async () => {
        // The map covered eighteen extensions. Everything else was
        // `application/octet-stream`, which is both a wrong label and, under
        // the old rule, a refusal to return the content.
        const woff2 = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0x00, 0x00])
        await call('mikser_drive_add', { endpoint: 'media', files: [
            { name: 'body.woff2', base64: woff2.toString('base64') } ] })
        assert.equal(body(await call('mikser_drive_read', { path: 'media/body.woff2' })).mime, 'font/woff2')
    })

    it('returns an svg as text instead of refusing it', async () => {
        // image/svg+xml was in neither the viewable set nor the textual
        // pattern, so the one image format that IS text fell between them.
        const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>'
        await call('mikser_drive_add', { endpoint: 'media', files: [
            { name: 'mark.svg', base64: Buffer.from(svg, 'utf8').toString('base64') } ] })
        const r = body(await call('mikser_drive_read', { path: 'media/mark.svg' }))
        assert.equal(r.mime, 'image/svg+xml')
        assert.equal(r.content, svg)
    })

    it('does not mistake corrupt bytes for a cut-off character', async () => {
        // C3 28 is invalid UTF-8, not a truncated codepoint. A classifier that
        // retries while chopping bytes off the end decodes the remainder
        // cleanly and calls a binary file text.
        const corrupt = Buffer.from([0x74, 0x65, 0x78, 0x74, 0xc3, 0x28])
        await call('mikser_drive_add', { endpoint: 'media', files: [
            { name: 'broken.bin', base64: corrupt.toString('base64') } ] })
        const r = body(await call('mikser_drive_read', { path: 'media/broken.bin' }))
        assert.equal(r.content, undefined)
        assert.equal(r.viewed, false)
    })

    it('says so when there is nothing there', async () => {
        const r = await call('mikser_drive_read', { path: 'media/absent.png' })
        assert.equal(r.isError, true)
    })
})

describe('delete', () => {
    const put = (name, text) => call('mikser_drive_add',
        { endpoint: 'media', files: [{ name, base64: b64(text) }] })

    it('moves to trash rather than unlinking, and can be undone', async () => {
        await put('bye.txt', 'content')
        const r = body(await call('mikser_drive_delete', { paths: ['media/bye.txt'] }))
        assert.equal(r.removed, 1)
        await assert.rejects(() => stat(path.join(dir, 'media/bye.txt')), 'gone from the folder')
        // Still on disk, so a wrong delete is a move back and not a restore.
        assert.ok(await stat(path.join(dir, r.trash)))
        assert.match(r.restore, /Move everything back/)
    })

    it('reports one cycle and one trash stamp for the whole batch', async () => {
        // The reason the batch form exists. Three separate calls cost three
        // cycles and three rebuilds; sent together they cost one.
        //
        // What is asserted is what is observable: a single reported cycleId and
        // a single trash stamp. That only ONE cycle runs comes from claiming it
        // before the first rename — nextCycleId() predicts the next cycle from
        // the current one, so it cannot be counted from here.
        await put('c1.txt', '1')
        await put('c2.txt', '2')
        await put('c3.txt', '3')
        const r = body(await call('mikser_drive_delete',
            { paths: ['media/c1.txt', 'media/c2.txt', 'media/c3.txt'] }))
        assert.equal(r.removed, 3)
        assert.equal(r.files.length, 3)
        assert.ok(r.cycleId != null, 'one cycle claimed for the batch')
        // All three under one trash stamp, so undoing the batch is one move.
        assert.equal(new Set(r.files.map(f => path.dirname(path.dirname(f.trash)))).size, 1)
    })

    it('removes nothing when any path in the batch is bad', async () => {
        await put('good.txt', 'x')
        const r = await call('mikser_drive_delete', { paths: ['media/good.txt', 'media/nosuch.txt'] })
        assert.equal(r.isError, true)
        assert.match(r.content[0].text, /all-or-nothing/)
        assert.ok(await stat(path.join(dir, 'media/good.txt')), 'the valid one was left alone')
    })

    it('refuses the same file listed twice rather than failing mid-batch', async () => {
        await put('twice.txt', 'x')
        const r = await call('mikser_drive_delete', { paths: ['media/twice.txt', 'media/twice.txt'] })
        assert.equal(r.isError, true)
        assert.match(r.content[0].text, /listed twice/)
        assert.ok(await stat(path.join(dir, 'media/twice.txt')))
    })

    it('puts trash OUTSIDE the served folder', async () => {
        // Inside it, the file would be republished at a new URL and, where git
        // sync is on, committed.
        await put('gone.txt', 'x')
        const r = body(await call('mikser_drive_delete', { paths: ['media/gone.txt'] }))
        assert.equal(r.trash.startsWith('media/'), false, `trash must not be inside the endpoint: ${r.trash}`)
    })

    it('refuses a readOnly endpoint', async () => {
        await writeFile(path.join(dir, 'locked/x.txt'), 'x')
        const r = await call('mikser_drive_delete', { paths: ['locked/x.txt'] })
        assert.equal(r.isError, true)
        assert.match(r.content[0].text, /readOnly/)
    })

    it('dryRun removes nothing', async () => {
        await put('keep.txt', 'x')
        const r = body(await call('mikser_drive_delete', { paths: ['media/keep.txt'], dryRun: true }))
        assert.equal(r.dryRun, true)
        assert.equal(r.wouldRemove, 1)
        assert.ok(await stat(path.join(dir, 'media/keep.txt')))
    })

    it('always states what its reference check does NOT cover', async () => {
        // An empty list means "nothing of the kind I look at", not "nothing".
        await put('cov.txt', 'x')
        const r = body(await call('mikser_drive_delete', { paths: ['media/cov.txt'], dryRun: true }))
        assert.match(r.coverage, /NOT body text/)
    })
})

describe('move', () => {
    const put = (name, text) => call('mikser_drive_add',
        { endpoint: 'media', files: [{ name, base64: b64(text) }] })
    const move = (moves, rest) => call('mikser_drive_move', { moves, ...rest })

    it('moves a file that nothing references', async () => {
        await put('loose.txt', 'x')
        const r = body(await move([{ from: 'media/loose.txt', to: 'moved/loose.txt' }]))
        assert.equal(r.moved, 1)
        assert.ok(await stat(path.join(dir, 'media/moved/loose.txt')))
        await assert.rejects(() => stat(path.join(dir, 'media/loose.txt')))
    })

    it('reports one cycle for the whole batch', async () => {
        await put('b1.txt', '1')
        await put('b2.txt', '2')
        const r = body(await move([
            { from: 'media/b1.txt', to: 'bulk/b1.txt' },
            { from: 'media/b2.txt', to: 'bulk/b2.txt' },
        ]))
        assert.equal(r.moved, 2)
        assert.ok(r.cycleId != null, 'one cycle claimed for the batch')
        assert.ok(await stat(path.join(dir, 'media/bulk/b1.txt')))
        assert.ok(await stat(path.join(dir, 'media/bulk/b2.txt')))
    })

    it('moves nothing when any entry in the batch is bad', async () => {
        await put('ok1.txt', 'x')
        const r = await move([
            { from: 'media/ok1.txt', to: 'fine.txt' },
            { from: 'media/absent.txt', to: 'wherever.txt' },
        ])
        assert.equal(r.isError, true)
        assert.match(r.content[0].text, /all-or-nothing/)
        assert.ok(await stat(path.join(dir, 'media/ok1.txt')), 'the valid one was left alone')
    })

    it('refuses two entries landing on one destination', async () => {
        await put('t1.txt', '1')
        await put('t2.txt', '2')
        const r = await move([
            { from: 'media/t1.txt', to: 'same-target.txt' },
            { from: 'media/t2.txt', to: 'same-target.txt' },
        ])
        assert.equal(r.isError, true)
        assert.match(r.content[0].text, /both move onto/)
    })

    it('refuses one source moved twice', async () => {
        await put('twice-src.txt', 'x')
        const r = await move([
            { from: 'media/twice-src.txt', to: 'first.txt' },
            { from: 'media/twice-src.txt', to: 'second.txt' },
        ])
        assert.equal(r.isError, true)
        assert.match(r.content[0].text, /listed twice/)
    })

    it('refuses a chain, because the outcome would depend on order', async () => {
        // A→B, B→C. B exists, so the clash check catches it before anything
        // moves — no separate ordering check needed.
        await put('ch1.txt', '1')
        await put('ch2.txt', '2')
        const r = await move([
            { from: 'media/ch1.txt', to: 'ch2.txt' },
            { from: 'media/ch2.txt', to: 'ch3.txt' },
        ])
        assert.equal(r.isError, true)
        assert.equal(await readFile(path.join(dir, 'media/ch1.txt'), 'utf8'), '1')
        assert.equal(await readFile(path.join(dir, 'media/ch2.txt'), 'utf8'), '2')
    })

    it('refuses to land on something that already exists', async () => {
        await put('a.txt', 'a')
        await put('b.txt', 'b')
        const r = await move([{ from: 'media/a.txt', to: 'b.txt' }])
        assert.equal(r.isError, true)
        assert.match(r.content[0].text, /already exists/)
        // Neither file moved.
        assert.equal(await readFile(path.join(dir, 'media/a.txt'), 'utf8'), 'a')
        assert.equal(await readFile(path.join(dir, 'media/b.txt'), 'utf8'), 'b')
    })

    it('refuses a destination that would escape the endpoint', async () => {
        await put('stay.txt', 'x')
        const r = await move([{ from: 'media/stay.txt', to: '../../escaped.txt' }])
        assert.equal(r.isError, true)
        assert.ok(await stat(path.join(dir, 'media/stay.txt')))
    })

    it('refuses a no-op move rather than pretending it did something', async () => {
        await put('same.txt', 'x')
        const r = await move([{ from: 'media/same.txt', to: 'same.txt' }])
        assert.equal(r.isError, true)
        assert.match(r.content[0].text, /same path/)
    })

    it('states what its reference check does not cover', async () => {
        await put('cover.txt', 'x')
        const r = body(await move([{ from: 'media/cover.txt', to: 'elsewhere.txt' }], { dryRun: true }))
        assert.equal(r.dryRun, true)
        assert.equal(r.wouldMove, 1)
        assert.match(r.coverage, /NOT body text/)
        assert.ok(await stat(path.join(dir, 'media/cover.txt')), 'dryRun moves nothing')
    })

    it('refuses a readOnly endpoint', async () => {
        await writeFile(path.join(dir, 'locked/ro.txt'), 'x')
        const r = await move([{ from: 'locked/ro.txt', to: 'other.txt' }])
        assert.equal(r.isError, true)
        assert.match(r.content[0].text, /readOnly/)
    })
})

// Reads are capability-gated, the same as the WebDAV mount.
//
// The mount has always checked `drive:<name>` before serving a byte; this tool
// did not, so the two surfaces disagreed about the same endpoint and a
// `readOnly` list derived from capabilities described a rule only half the
// transports enforced.
describe('read capability', () => {
    const toolsFor = async (principal) => {
        const substrate = fakeSubstrate(principal)
        resetServices()
        provideService('mcp', substrate)
        registerFileTools({
            runtime: {
                options: {
                    ...runtime.options,
                    roles: {
                        catalogue: {
                            editors: ['drive:media', 'drive:media:write', 'drive:secrets'],
                            developers: ['drive:media', 'drive:media:write', 'drive:secrets', 'drive:secrets:write'],
                        },
                        summaries: { developers: 'Everything an editor has, plus the code.' },
                    },
                },
                refs: runtime.refs,
            },
            endpoints: { media: { folder: 'media' }, secrets: { folder: 'locked' } },
            capabilityOf: readCapability, writeCapabilityOf: writeCapability,
        })
        return substrate
    }

    it('serves a file the principal may read', async () => {
        await call('mikser_drive_add', { endpoint: 'media', files: [{ name: 'readable.txt', base64: b64('hello') }] })
        const substrate = await toolsFor({ subject: 'ed', roles: ['editors'],
                                           capabilities: ['drive:media', 'drive:media:write'] })
        const r = await substrate.call('mikser_drive_read', { path: 'media/readable.txt' })
        assert.equal(JSON.parse(r.content.find(c => c.type === 'text').text).content, 'hello')
    })

    it('refuses one it may not, naming the role and who can', async () => {
        const substrate = await toolsFor({ subject: 'ed', roles: ['editors'],
                                           capabilities: ['drive:media', 'drive:media:write'] })
        const r = await substrate.call('mikser_drive_read', { path: 'secrets/anything.txt' })
        assert.equal(r.isError, true)
        const message = r.content.find(c => c.type === 'text').text
        assert.match(message, /Connected as editors/, 'the refusal names the acting role')
        assert.match(message, /drive:secrets/, 'and the capability it lacks')
        assert.match(message, /developers/, 'and who carries it')
        assert.doesNotMatch(message, /request|escalat|retry/i, 'and never suggests obtaining it')
    })

    it('does not narrow a credential that is not capability-scoped', async () => {
        // A static token or a loopback caller. The endpoint's own gate still
        // applies; this must not guess a narrower answer.
        const substrate = await toolsFor({ subject: 'static', capabilities: null })
        const r = await substrate.call('mikser_drive_read', { path: 'media/readable.txt' })
        assert.notEqual(r.isError, true)
    })
})
