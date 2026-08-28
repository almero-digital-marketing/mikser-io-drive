import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { createRequire } from 'node:module'

// `derived` is a passthrough of what the assets plugin stamped, and it was the
// one field in the add response I could not verify by unit test: it only exists
// when a real preset matched and a real derivative was produced. So this runs
// the whole pipeline — files → assets → renderPreset → sharp — against a live
// server and asks the tool.
//
// The read is three lines. What this pins is that those three lines name the
// field the pipeline actually writes, which is the half that silently rots when
// the plugin changes shape.
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

// sharp is mikser-io's dependency, not this package's — the fixture needs it
// because a preset does the actual image work. Resolved from there rather than
// from here, and the fixture's node_modules is built from mikser-io's so the
// spawned build finds it too.
const require_ = createRequire(import.meta.url)
const ENGINE = path.resolve(import.meta.dirname, '..', '..', 'mikser-io')
const hasSharp = (() => {
    try { require_.resolve('sharp', { paths: [ENGINE] }); return true } catch { return false }
})()

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
    if (!hasSharp) return
    dir = await mkdtemp(path.join(tmpdir(), 'mikser-derived-'))
    await mkdir(path.join(dir, 'media'), { recursive: true })
    await mkdir(path.join(dir, 'presets'), { recursive: true })
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
    for (const pkg of ['mikser-io', 'mikser-io-mcp', 'mikser-io-webdav']) {
        await rm(path.join(dir, 'node_modules', pkg), { recursive: true, force: true })
        await symlink(path.resolve(here, '..', pkg), path.join(dir, 'node_modules', pkg)).catch(() => {})
    }

    // A preset is a module whose DEFAULT export does the work.
    await writeFile(path.join(dir, 'presets/web.js'),
        "import sharp from 'sharp'\n"
        + 'export const revision = 1\n'
        + "export const format = 'webp'\n"
        + 'export const options = { width: 8 }\n'
        + 'export default ({ entity: { source, destination }, options }) =>\n'
        + '    sharp(source).resize(options).webp().toFile(destination)\n')

    // `match` against the ID shape, which the files plugin builds from the path
    // inside filesFolder — NOT the URL shape.
    await writeFile(path.join(dir, 'mikser.config.js'),
        "import { files, assets, renderPreset } from 'mikser-io'\n"
        + "import { mcp } from 'mikser-io-mcp'\n"
        + "import { webdav } from 'mikser-io-webdav'\n"
        + 'export default async () => ({\n'
        + '    plugins: [\n'
        + "        mcp({ base: '' }),\n"
        + "        files({ filesFolder: 'media', outputFolder: 'media' }),\n"
        + "        assets({ assetsFolder: 'derived', presetsFolder: 'presets',\n"
        + "                 presets: { web: { match: ['/files/**/*.png'] } } }),\n"
        + '        renderPreset(),\n'
        + "        webdav({ allowRemote: true, endpoints: { media: { folder: 'media' } } }),\n"
        + '    ],\n'
        + '})\n')

    server = spawn(process.execPath, [
        path.join(dir, 'node_modules/mikser-io/app.js'),
        '--working-folder', dir, '--output-folder', 'out', '--runtime-folder', 'runtime',
        '--watch', '--server', String(PORT), '--url', `http://127.0.0.1:${PORT}`,
    ], { cwd: dir, stdio: 'ignore' })

    // Wait for it to answer rather than sleeping a guess.
    for (let i = 0; i < 60; i++) {
        try {
            const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, { method: 'POST' })
            if (res.status) break
        } catch { await new Promise(r => setTimeout(r, 1000)) }
    }
    await new Promise(r => setTimeout(r, 3000))
})

after(async () => {
    server?.kill()
    if (dir) await rm(dir, { recursive: true, force: true })
})

describe('derived — the preset passthrough', { skip: hasSharp ? false : 'sharp is not installed' }, () => {
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
            name: 'mikser_webdav_add',
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
