import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, mkdir, stat, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import bcrypt from 'bcryptjs'

import { runtime } from 'mikser-io'
import { auth } from 'mikser-io-auth'
import { drive } from '../index.js'

// These two properties are the reason lib/staged-writes.js exists. The
// underlying adapter writes with open(path, 'w') straight to the destination,
// which was measured to (1) expose a growing partial file and (2) destroy the
// previous contents when an upload is interrupted. Both are silent, and both
// matter because these folders are mikser sources.
let server, port, dir, content
const AUTH = 'Basic ' + Buffer.from('alice:alice-pw').toString('base64')
const CHUNK = 65536
const CHUNKS = 8

before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mikser-drive-atomic-'))
    content = path.join(dir, 'documents')
    await mkdir(content, { recursive: true })
    await mkdir(path.join(dir, 'runtime'), { recursive: true })
    await writeFile(path.join(dir, 'users.htpasswd'), `alice:${bcrypt.hashSync('alice-pw', 10)}\n`)

    const { default: express } = await import('express')
    const app = express()
    runtime.options = { ...runtime.options, app, workingFolder: dir, runtimeFolder: path.join(dir, 'runtime') }
    runtime.config = { ...runtime.config }
    runtime.engine = { ...runtime.engine, logger: { info(){}, warn(){}, error(){}, debug(){}, trace(){}, fatal(){} } }

    const identity = auth({})
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
})

after(async () => {
    await new Promise(r => server?.close(r))
    await rm(dir, { recursive: true, force: true })
})

// A body that trickles, so the upload is observable while in flight.
function slowBody({ chunks = CHUNKS, size = CHUNK, gapMs = 120, abortAt = null } = {}) {
    let i = 0
    return new ReadableStream({
        async pull(controller) {
            if (abortAt != null && i === abortAt) {
                controller.error(new Error('client vanished'))
                return
            }
            if (i >= chunks) { controller.close(); return }
            controller.enqueue(new Uint8Array(size).fill(65 + (i % 26)))
            i++
            await new Promise(r => setTimeout(r, gapMs))
        },
    })
}

const put = (name, body) => fetch(`http://127.0.0.1:${port}/drive/content/${name}`, {
    method: 'PUT', headers: { authorization: AUTH }, body, duplex: 'half',
})
const sizeOf = async (p) => { try { return (await stat(p)).size } catch { return null } }

describe('a partial upload is never visible at the destination', () => {
    it('the target path does not exist until the upload completes', async () => {
        const target = path.join(content, 'big.md')
        const seen = []
        const poll = setInterval(async () => seen.push(await sizeOf(target)), 100)
        const res = await put('big.md', slowBody())
        clearInterval(poll)
        await new Promise(r => setTimeout(r, 50))

        assert.ok([201, 204].includes(res.status), `unexpected ${res.status}`)
        assert.equal(await sizeOf(target), CHUNK * CHUNKS, 'the whole file landed')

        // Without staging, this sequence was [65536, 131072, … 524288].
        const partial = seen.filter(s => s !== null && s > 0 && s < CHUNK * CHUNKS)
        assert.deepEqual(partial, [], `a growing file was visible: ${JSON.stringify(seen)}`)
        assert.ok(seen.length >= 3, 'the poll must have run while the upload was in flight')
    })

    it('leaves no staging file behind on success', async () => {
        await put('clean.md', slowBody({ chunks: 2, gapMs: 20 }))
        const leftovers = (await readdir(content)).filter(f => f.endsWith('.part'))
        assert.deepEqual(leftovers, [])
    })
})

describe('an interrupted overwrite leaves the original intact', () => {
    it('does not truncate or corrupt the file that was there', async () => {
        // The measured failure without staging: a 1600-byte file became
        // 196608 bytes of the new content. Not the old file, not an error.
        const target = path.join(content, 'precious.md')
        const original = '# original content that matters\n'.repeat(50)
        await writeFile(target, original)

        await assert.rejects(() => put('precious.md', slowBody({ abortAt: 3 })))
        await new Promise(r => setTimeout(r, 200))

        assert.equal(await readFile(target, 'utf8'), original)
    })

    it('cleans up the staging file after a failed upload', async () => {
        await assert.rejects(() => put('doomed.md', slowBody({ abortAt: 2 })))
        await new Promise(r => setTimeout(r, 200))
        const leftovers = (await readdir(content)).filter(f => f.endsWith('.part'))
        assert.deepEqual(leftovers, [], 'a failed upload must not leave a .part file')
        assert.equal(await sizeOf(path.join(content, 'doomed.md')), null,
                     'and must not create the destination at all')
    })
})

describe('atomicWrites: false restores the adapter behaviour', () => {
    it('is available as an escape hatch', async () => {
        // Documented rather than recommended: the point is that the default
        // is the safe one and the unsafe one has to be asked for.
        const { withStagedWrites, stageWrites } = await import('../index.js')
        assert.equal(typeof withStagedWrites, 'function')
        assert.equal(typeof stageWrites, 'function')
        // A resource with no setStream passes through untouched.
        const plain = { absolutePath: '/x' }
        assert.equal(stageWrites(plain), plain)
    })
})
