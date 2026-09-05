import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { createRequire } from 'node:module'

// `derived` is `entity.meta.presets`, spread onto the add response. What this
// package owns is that passthrough: the field it reads and the field it
// writes, over a live server through the real tool.
//
// It used to produce a real derivative to get there — files → assets →
// renderPreset → sharp — which bought two assertions beyond the passthrough
// (a .webp suffix, a URL unlike the source) at the price of a hard dependency
// on mikser-io-assets, a live image encode, and a `skip` whenever sharp was
// absent, so on many machines it never ran at all. Those two assertions are
// presetUrl's behaviour and are unit-tested in mikser-io-assets. A five-line
// plugin stamps the field on the same hook instead.
//
// Two mistakes made while building it, both of which produce SILENCE rather
// than an error and are worth knowing:
//
//   - a preset is a MODULE with a default export that does the work, not an
//     inline options object. Without the default, renderPreset resolves
//     `runtime.preset` to undefined and every render throws.
//   - `match` runs against the entity ID. `outputFolder` prefixes `name` and
//     `meta.url` but NOT `id`, so a glob written against the URL shape
//     (/media/**) matches nothing, produces no variant, and reports only that
//     none matched.

const ENGINE = path.resolve(import.meta.dirname, '..', '..', 'mikser-io')

const PORT = 4211
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64')

let dir, server

async function rpc(token, method, params, session) {
    const headers = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(session.id ? { 'mcp-session-id': session.id } : {}),
    }
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp`,
        { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: session.n++, method, params }) })
    if (res.headers.get('mcp-session-id')) session.id = res.headers.get('mcp-session-id')
    const text = await res.text()
    const frames = text.split('\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5)))
    return (frames.at(-1) ?? JSON.parse(text)).result
}

before(async (t) => {
    dir = await mkdtemp(path.join(tmpdir(), 'mikser-derived-'))
    await mkdir(path.join(dir, 'media'), { recursive: true })
    await mkdir(path.join(dir, 'documents'), { recursive: true })

    // node_modules by symlink, so the fixture resolves the working copies.
    const here = path.resolve(import.meta.dirname, '..')
    await mkdir(path.join(dir, 'node_modules'), { recursive: true })
    const { symlink, readdir } = await import('node:fs/promises')
    // Both donors: this package's own deps, plus the engine's — which is where
    // sharp lives, and a preset cannot run without it.
    for (const donor of [path.join(here, 'node_modules'), path.join(ENGINE, 'node_modules')]) {
        for (const entry of await readdir(donor).catch(() => [])) {
            await symlink(path.join(donor, entry), path.join(dir, 'node_modules', entry)).catch(() => {})
        }
    }
    for (const pkg of ['mikser-io', 'mikser-io-mcp', 'mikser-io-drive']) {
        await rm(path.join(dir, 'node_modules', pkg), { recursive: true, force: true })
        await symlink(path.resolve(here, '..', pkg), path.join(dir, 'node_modules', pkg)).catch(() => {})
    }

    // `match` against the ID shape, which the files plugin builds from the path
    // inside filesFolder — NOT the URL shape.
    // A five-line plugin in place of the assets pipeline.
    //
    // `derived` is `entity.meta.presets`, spread onto the response. What drive
    // owns is that passthrough — the field name it reads and the field name it
    // writes. Producing a real derivative to test it meant a live sharp
    // encode, a preset module on disk, and a hard dependency on
    // mikser-io-assets for a package that does not otherwise use it; the
    // assertions it bought beyond the passthrough (a .webp suffix, a URL
    // unlike the source) are presetUrl's behaviour and are unit-tested in
    // mikser-io-assets, where changing them would be noticed.
    //
    // Stamped in onProcessed, the same hook and the same field the assets
    // plugin writes.
    await writeFile(path.join(dir, 'mikser.config.js'),
        "import { files } from 'mikser-io'\n"
        + "import { mcp } from 'mikser-io-mcp'\n"
        + "import { drive } from 'mikser-io-drive'\n"
        // onProcessed is a PHASE hook — it receives the abort signal, not an
        // entity — so the stamp walks the journal, which is the same shape and
        // the same hook the assets plugin uses to write this field.
        + 'const stampPresets = () => ({ onProcessed, useJournal, updateEntity, constants: { OPERATION } }) =>\n'
        + '    onProcessed(async (signal) => {\n'
        + "    for await (const { entity } of useJournal('Stamp presets', [OPERATION.CREATE, OPERATION.UPDATE], signal)) {\n"
        + "        if (entity.collection !== 'files' || !entity.id.endsWith('.png')) continue\n"
        + "        entity.meta = { ...entity.meta, presets: { web: '/derived/web/shots/hero.webp' } }\n"
        + '        await updateEntity(entity)\n'
        + '    }\n'
        + '})\n'
        + 'export default async () => ({\n'
        + '    plugins: [\n'
        + "        mcp({ base: '' }),\n"
        + "        files({ filesFolder: 'media', outputFolder: 'media' }),\n"
        + '        stampPresets(),\n'
        + "        drive({ allowRemote: true, endpoints: { media: { folder: 'media' } } }),\n"
        + '    ],\n'
        + '})\n')

    server = spawn(process.execPath, [
        path.join(dir, 'node_modules/mikser-io/app.js'),
        '--working-folder', dir, '--output-folder', 'out', '--runtime-folder', 'runtime',
        '--watch', '--server', String(PORT), '--url', `http://127.0.0.1:${PORT}`,
    ], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })

    // Kept so a server that never comes up says WHY. Throwing this away left
    // the failure as a bare ECONNREFUSED, which names the symptom and hides
    // every cause — the one thing this fixture exists to avoid.
    let output = ''
    server.stdout.on('data', (d) => { output += d })
    server.stderr.on('data', (d) => { output += d })
    let exited = null
    server.on('exit', (code, signal) => { exited = signal ?? code })

    // Wait for it to answer rather than sleeping a guess.
    let up = false
    for (let i = 0; i < 60 && !up && exited === null; i++) {
        try {
            const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, { method: 'POST' })
            if (res.status) up = true
        } catch { await new Promise(r => setTimeout(r, 1000)) }
    }
    if (!up) {
        throw new Error(`the fixture server never answered on :${PORT}`
            + (exited === null ? ' (still running)' : ` (exited ${exited})`)
            + `\n\n${output.trim() || '(it printed nothing)'}`)
    }
    await new Promise(r => setTimeout(r, 3000))
})

after(async () => {
    server?.kill()
    if (dir) await rm(dir, { recursive: true, force: true })
})

describe('derived — the preset passthrough', () => {
    it('reports the variant a preset actually produced', async () => {
        const session = { id: null, n: 1 }
        await rpc(null, 'initialize',
            { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } }, session)
        await fetch(`http://127.0.0.1:${PORT}/mcp`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
                       'mcp-session-id': session.id },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        })

        const result = await rpc(null, 'tools/call', {
            name: 'mikser_drive_add',
            arguments: { endpoint: 'media', folder: 'shots',
                         files: [{ name: 'hero.png', base64: PNG.toString('base64'), mime: 'image/png' }] },
        }, session)
        assert.equal(result?.isError, undefined, result?.content?.[0]?.text)

        const body = JSON.parse(result.content[0].text)
        const stored = body.files[0]
        assert.equal(stored.imported, true, 'the cycle must have imported it')
        assert.equal(stored.reference, '/media/shots/hero.png')

        // The field this whole fixture exists for.
        assert.ok(stored.derived, `expected derived variants, got: ${stored.derivedNote ?? '(nothing)'}`)
        assert.ok(stored.derived.web, `expected a "web" variant, got ${JSON.stringify(stored.derived)}`)
        assert.match(stored.derived.web, /\.webp$/,
            'the preset declares format webp, so the variant URL should carry that extension')
        assert.notEqual(stored.derived.web, stored.reference,
            'the variant must be a different URL from the original, or nothing was derived')
    })
})
