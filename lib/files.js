// File operations over MCP, for an agent that has no route to the host.
//
// WebDAV itself costs nothing in tokens, but it needs the caller to be able to
// reach the server and to have something to speak it with. Neither holds for
// every agent: a sandboxed one may have no egress, and a desktop one may have
// no shell to run a client from. For those, bytes have to travel the connection
// that already works — the MCP session itself. A person with a mounted share is
// still the better answer for anything large, and the caps say so.
//
// So these carry base64 through the tool. That is expensive and bounded, and
// the bound is stated rather than discovered: above the cap they refuse and say
// where the file belongs instead of failing blankly.
//
// Nothing here is media-specific. An endpoint is whatever the deployment
// configured — media, files, styles, js — and what a stored file becomes is
// whatever that deployment's pipeline makes of it. The response reports what
// was actually stamped rather than assuming: a served entity gets a `reference`
// from its meta.url, one that is not served gets its catalog id, and derived
// variants appear only where presets matched.
//
// Page TEXT is not in scope. update_entity owns that: it is checksum-guarded,
// previews blast radius, returns the build report and raises the spec-locked
// advisory. Writing a document through here would lose all four.

import path from 'node:path'
import { z } from 'zod'
import { readFile, writeFile, mkdir, rename, stat, unlink } from 'node:fs/promises'
import {
    runtime, readEntity, findEntities, nextCycleId, whenCycleCompletes, checksum,
} from 'mikser-io'

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] })
const fail = (message) => ({ isError: true, content: [{ type: 'text', text: message }] })

// Bounds, stated in the tool description so a caller can decide before
// spending. These are what mikser refuses; the practical limit is the caller's
// own context, which mikser cannot see and does not pretend to.
//
// Sized against real content: a p90 image on the site this was built for is
// 146KB, so 2MB is an order of magnitude of headroom for one file, and 8MB is
// a batch nobody reaches by accident. A video is not close, and should not be —
// it belongs on a mount.
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_BATCH_BYTES = 8 * 1024 * 1024

// Returned as an image the model can actually look at, rather than as bytes it
// cannot. Everything else comes back described.
const VIEWABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_VIEWABLE_BYTES = 1024 * 1024

const TEXTUAL = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml))/

function mimeFor(name, given) {
    if (given) return given
    const ext = path.extname(name).slice(1).toLowerCase()
    return {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
        webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
        pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm',
        css: 'text/css', js: 'text/javascript', json: 'application/json',
        yml: 'application/x-yaml', yaml: 'application/x-yaml',
        md: 'text/markdown', txt: 'text/plain', html: 'text/html',
    }[ext] ?? 'application/octet-stream'
}

// A name that cannot escape the folder it was given.
//
// `..` in a supplied filename is the oldest write primitive there is, and this
// writes wherever the caller says. Rejected rather than sanitised: a caller
// that meant `logo.png` is not helped by silently getting `logo.png` from
// `../../logo.png`, and one that meant to escape should be told no.
function safeSegment(value, what) {
    const v = String(value ?? '').trim()
    if (!v) return { error: `${what} is required` }
    if (v.startsWith('/') || path.isAbsolute(v)) return { error: `${what} must be relative, got ${JSON.stringify(v)}` }
    const parts = v.split(/[\\/]+/).filter(Boolean)
    if (parts.some(p => p === '..' || p === '.')) {
        return { error: `${what} must not contain . or .. — got ${JSON.stringify(v)}` }
    }
    if (parts.some(p => p.startsWith('.'))) {
        return { error: `${what} must not contain dotfiles — got ${JSON.stringify(v)}` }
    }
    return { value: parts.join('/') }
}

// Where a file is, given whatever form the caller had to hand.
//
// Three forms reach here and all of them are reasonable things to be holding:
// the served URL another tool reported (`/media/x.png`), the catalog id
// (`/files/x.png`), or an endpoint plus a relative path. Resolving all three
// beats making a caller convert between them.
async function locate(pathish, endpoints, workingFolder) {
    const wanted = String(pathish ?? '').trim()
    if (!wanted) return { error: 'path is required' }

    const rootOf = (ep) => (path.isAbsolute(ep.folder) ? ep.folder : path.join(workingFolder, ep.folder))

    // The SOURCE file for an entity, which is not what `entity.uri` holds.
    //
    // Measured on real data: a files-plugin entity has
    // `uri = <working>/out/media/x.png` — the built COPY — while its `name` is
    // `media/x.png`. Operating on the uri would delete or move the output,
    // which the next build simply recreates, so the caller sees success and
    // nothing changes. The source is found by matching the entity's name
    // against each endpoint's folder instead.
    const sourceOf = (entity) => {
        if (!entity) return null
        for (const [name, ep] of Object.entries(endpoints)) {
            const root = rootOf(ep)
            // uri already inside an endpoint — the ordinary case for a
            // collection that is not copied to an output folder.
            if (entity.uri && !path.relative(root, entity.uri).startsWith('..')) {
                return { file: entity.uri, endpoint: name }
            }
            // Otherwise reconstruct from `name`, which is folder-relative.
            const prefix = `${ep.folder}/`
            if (entity.name?.startsWith(prefix)) {
                return { file: path.join(root, entity.name.slice(prefix.length)), endpoint: name }
            }
        }
        return null
    }

    const byId = await readEntity({ id: wanted })
    if (byId) {
        const src = sourceOf(byId)
        if (src) return { entity: byId, file: src.file, endpoint: src.endpoint }
        return { error: `${wanted} exists but its source file is not inside any configured endpoint `
            + `(${Object.keys(endpoints).join(', ')}), so this will not touch it.` }
    }

    const served = (await findEntities({ 'meta.url': wanted })) ?? []
    if (served.length > 1) {
        return { error: `${wanted} is the served URL of ${served.length} entities: `
            + `${served.map(e => e.id).join(', ')}. Use a catalog id instead.` }
    }
    if (served.length === 1) {
        const src = sourceOf(served[0])
        if (src) return { entity: served[0], file: src.file, endpoint: src.endpoint }
    }

    // endpoint/relative form — always unambiguous, and the fallback when the
    // catalog cannot place it.
    const [head, ...rest] = wanted.replace(/^\/+/, '').split('/')
    const ep = endpoints[head]
    if (ep && rest.length) {
        const rel = safeSegment(rest.join('/'), 'path')
        if (rel.error) return { error: rel.error }
        return { entity: served[0] ?? null, file: path.join(rootOf(ep), rel.value), endpoint: head }
    }
    return { error: `Nothing at ${JSON.stringify(wanted)}. Give a catalog id, a served URL, `
        + `or <endpoint>/<path> where endpoint is one of: ${Object.keys(endpoints).join(', ')}` }
}

// What the pipeline made of a stored file, read back after the cycle.
//
// Reported rather than assumed. A served entity carries meta.url and that is
// the string to paste into a document; one that is not served — a stylesheet, a
// script — has no URL and its catalog id is the thing to reference. Derived
// variants appear only where a preset matched, which is a property of the
// deployment's config and not of any folder name.
async function describeStored(id) {
    const entity = await readEntity({ id })
    if (!entity) {
        return { id, imported: false,
                 note: 'Written to disk but not in the catalog yet — no source plugin claims this folder, '
                     + 'or the cycle has not imported it.' }
    }
    const presets = entity.meta?.presets
    return {
        id: entity.id,
        imported: true,
        reference: entity.meta?.url ?? entity.id,
        referenceKind: entity.meta?.url ? 'served URL' : 'catalog id (this entity is not served)',
        ...(presets ? { derived: presets } : {}),
        ...(presets ? {} : { derivedNote: 'No preset matched this file, so no variants were produced.' }),
    }
}

// Wait for a cycle, but not forever.
//
// A build cycle follows a write under --watch. Without a watcher there is no
// cycle to follow, and `whenCycleCompletes` then returns a promise that never
// settles — which hangs the call AFTER the bytes have landed, leaving the
// caller with neither a result nor an error. Bounded instead, and the response
// says which happened, because "stored, references unknown" is a real answer
// and silence is not.
const CYCLE_WAIT_MS = 30_000

async function settledCycle(cycleId) {
    // Without a watcher NOTHING will pick the write up, so there is no cycle
    // to wait for and waiting the full timeout is pure delay — measured, it
    // added 30s to every call and pushed a test run past five minutes.
    // Answered immediately instead, and honestly.
    if (!runtime.options?.watch) {
        return {
            completed: false,
            note: 'Stored, but this server is not watching for changes, so nothing will import them until a build '
                + 'runs. Catalog entries and derived variants are unknown until then.',
        }
    }
    let timer
    const timeout = new Promise(resolve => {
        timer = setTimeout(() => resolve({
            completed: false,
            note: `The files are stored, but no build cycle completed within ${CYCLE_WAIT_MS / 1000}s, so their `
                + 'catalog entries and derived variants are not known yet. A server running without --watch never '
                + 'runs one. Read a file back with mikser_webdav_read once a build has run.',
        }), CYCLE_WAIT_MS)
    })
    try {
        const report = await Promise.race([
            whenCycleCompletes(cycleId).then(r => ({ completed: true, ...r })),
            timeout,
        ])
        return report
    } catch (err) {
        // A report-and-exit invocation refuses the wait outright. The files
        // still landed, and saying so beats a bare failure.
        return { completed: false, note: `${err.message} The files are stored regardless.` }
    } finally {
        clearTimeout(timer)
    }
}

export function registerFileTools({ runtime: rt, endpoints, capabilityOf, writeCapabilityOf, logger }) {
    const mcp = rt.options.mcp
    if (!mcp?.registerTool) return

    const workingFolder = () => rt.options.workingFolder
    const folderOf = (name) => {
        const ep = endpoints[name]
        if (!ep) return null
        return path.isAbsolute(ep.folder) ? ep.folder : path.join(workingFolder(), ep.folder)
    }
    const holds = (principal, capability) => {
        const held = principal?.capabilities
        // Not capability-scoped — a static token or a loopback caller. The
        // endpoint's own gate still applies at the transport; this cannot
        // narrow further without guessing.
        if (held == null) return true
        return held.includes(capability)
    }

    // ── add ──────────────────────────────────────────────────────────────
    mcp.registerTool(
        'mikser_webdav_add',
        {
            description:
                'Store one or more FILES by sending their bytes as base64 through this call. For an agent with no '
                + 'network route to the host — a sandbox with no egress, a desktop client with no shell — this is the '
                + 'channel that works, because it rides the MCP connection you already have.\n\n'
                + 'It costs tokens in proportion to the bytes: roughly 1.4 tokens per byte of file. Ten typical images '
                + `is cheap; a video is not. Per file ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB and per batch `
                + `${Math.round(MAX_BATCH_BYTES / 1024 / 1024)}MB, above which this refuses rather than burning `
                + 'your context. Something that big belongs on a WebDAV mount, placed by a person — every '
                + 'endpoint here is reachable that way with ordinary credentials, and the bytes then cost nothing.\n\n'
                + 'Send the whole batch in ONE call: it is written together and picked up by a single build cycle, so '
                + 'you get one cycleId rather than one rebuild per file.\n\n'
                + 'Each stored file comes back with the reference string to paste into a document, and the derived '
                + 'variants any preset produced. This never writes page text — update_entity owns that, and a raw '
                + 'write here would lose its checksum guard, blast radius, build report and spec-locked advisory.',
            // zod here rather than the engine's neutral vocabulary: `files` is
            // an array of OBJECTS, which that vocabulary cannot express — and
            // teaching it to would make it the schema language the engine has
            // no business owning.
            inputSchema: {
                endpoint: z.string()
                    .describe('Which configured endpoint to store into. A wrong name is refused with the list of real ones.'),
                files: z.array(z.object({
                    name: z.string().describe('Filename, relative to `folder`. May not escape it.'),
                    base64: z.string().describe('The file content, base64-encoded.'),
                    mime: z.string().optional().describe('Content type. Derived from the extension when omitted.'),
                })).min(1).describe('The batch. Sent together so one build cycle picks them all up.'),
                folder: z.string().optional()
                    .describe('Subfolder within the endpoint, e.g. "devices/hera". Omit to store at its root.'),
                overwrite: z.boolean().optional()
                    .describe('Replace a file that already exists. Default false — an existing file is reported and refused rather than silently replaced.'),
                dryRun: z.boolean().optional()
                    .describe('Write nothing. Reports where each file would land, whether it would overwrite, and what it would cost.'),
            },
        },
        async ({ endpoint, files, folder, overwrite = false, dryRun = false } = {}) => {
            const principal = mcp.principal?.() ?? null
            const root = folderOf(endpoint)
            if (!root) {
                return fail(`No endpoint named ${JSON.stringify(endpoint)}. `
                    + `Configured: ${Object.keys(endpoints).join(', ') || '(none)'}`)
            }
            if (endpoints[endpoint].readOnly === true) {
                return fail(`${endpoint} is configured readOnly, so nothing can be stored there.`)
            }
            if (!holds(principal, writeCapabilityOf(endpoint))) {
                return fail(`Refused: you do not hold ${writeCapabilityOf(endpoint)}. Nothing was written.`)
            }
            if (!Array.isArray(files) || !files.length) return fail('files must be a non-empty array')

            const sub = folder ? safeSegment(folder, 'folder') : { value: '' }
            if (sub.error) return fail(sub.error)

            // Decode and check EVERYTHING before writing anything. A batch that
            // fails halfway leaves the caller unable to say what landed.
            const staged = []
            let total = 0
            for (const [i, f] of files.entries()) {
                const named = safeSegment(f?.name, `files[${i}].name`)
                if (named.error) return fail(named.error)
                if (typeof f?.base64 !== 'string' || !f.base64) {
                    return fail(`files[${i}] (${named.value}) has no base64 content`)
                }
                let bytes
                try {
                    bytes = Buffer.from(f.base64, 'base64')
                } catch {
                    return fail(`files[${i}] (${named.value}) is not valid base64`)
                }
                if (!bytes.length) return fail(`files[${i}] (${named.value}) decoded to zero bytes`)
                if (bytes.length > MAX_FILE_BYTES) {
                    return fail(`files[${i}] (${named.value}) is ${(bytes.length / 1024 / 1024).toFixed(1)}MB, over the `
                        + `${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB per-file cap. Nothing was written. A `
                        + `file this size belongs on a WebDAV mount rather than in a tool call — the same `
                        + `folder is reachable at /webdav/${endpoint} with ordinary credentials.`)
                }
                total += bytes.length
                if (total > MAX_BATCH_BYTES) {
                    return fail(`The batch exceeds the ${Math.round(MAX_BATCH_BYTES / 1024 / 1024)}MB cap at `
                        + `files[${i}] (${named.value}). Nothing was written. Send fewer per call, or place `
                        + `them on a WebDAV mount at /webdav/${endpoint} instead.`)
                }
                const relative = sub.value ? `${sub.value}/${named.value}` : named.value
                const file = path.join(root, relative)
                let exists = false
                try { await stat(file); exists = true } catch { /* new */ }
                staged.push({
                    name: named.value, relative, file, bytes,
                    mime: mimeFor(named.value, f.mime),
                    size: bytes.length,
                    exists,
                })
            }

            const collisions = staged.filter(s => s.exists)
            if (collisions.length && !overwrite && !dryRun) {
                return fail(`${collisions.length} file(s) already exist and overwrite is false: `
                    + `${collisions.map(s => s.relative).join(', ')}. Nothing was written. Pass overwrite: true to replace them.`)
            }

            if (dryRun) {
                return ok({
                    dryRun: true, endpoint, folder: sub.value || null,
                    totalBytes: total,
                    approxTokens: Math.round(total * 1.4 / 4),
                    files: staged.map(s => ({
                        name: s.relative, size: s.size, mime: s.mime,
                        wouldOverwrite: s.exists,
                        path: path.relative(workingFolder(), s.file),
                    })),
                    ...(collisions.length && !overwrite ? {
                        blocked: `${collisions.length} of these exist and would be refused without overwrite: true`,
                    } : {}),
                    note: 'Nothing was written. Reference strings and derived variants are only known after a real '
                        + 'write, because they come from what the pipeline makes of the file.',
                })
            }

            // One cycle for the whole batch, claimed before the first write so
            // the watcher's debounce coalesces them all into it.
            const cycleId = nextCycleId()
            const written = []
            for (const s of staged) {
                await mkdir(path.dirname(s.file), { recursive: true })
                await writeFile(s.file, s.bytes)
                written.push(s)
            }
            logger?.info?.('webdav: stored %d file(s) in %s for %j (%d bytes)',
                written.length, endpoint, principal?.subject ?? 'anonymous', total)

            // Bounded, because a cycle is not guaranteed to arrive. A server
            // without --watch never runs one, and awaiting it forever would
            // hang the call after the bytes had already landed — the caller
            // left holding neither a result nor an error. Measured: this hung
            // outright before the race was added.
            const report = await settledCycle(cycleId)

            const results = []
            for (const s of written) {
                const stored = {
                    name: s.relative,
                    path: path.relative(workingFolder(), s.file),
                    size: s.size,
                    mime: s.mime,
                    replaced: s.exists,
                    checksum: await checksum(s.file).catch(() => null),
                }
                // Identify what the catalog made of it.
                //
                // By `name`, not by `uri`: a files-plugin entity's uri is the
                // built copy under the output folder, so matching the source
                // path against it never hits. `name` is folder-relative and
                // indexed, which makes this one indexed lookup per file rather
                // than a scan.
                const found = (await findEntities({ name: `${endpoints[endpoint].folder}/${s.relative}` })) ?? []
                Object.assign(stored, found.length === 1
                    ? await describeStored(found[0].id)
                    : { imported: false, note: found.length
                        ? `Ambiguous: ${found.length} entities claim this file.`
                        : 'Written to disk but not in the catalog — no source plugin claims this folder, or the '
                          + 'cycle did not import it.' })
                results.push(stored)
            }

            return ok({
                endpoint, folder: sub.value || null,
                cycleId,
                stored: results.length,
                totalBytes: total,
                files: results,
                ...(report.completed ? {
                    cycle: { id: report.cycleId ?? cycleId, rendered: report.summary?.rendered ?? null,
                             errors: report.summary?.errors ?? null, warnings: report.summary?.warnings ?? null },
                } : { cycleNote: report.note }),
                next: 'Paste a `reference` into a document with update_entity to use it. `derived` lists the variants '
                    + 'a preset produced, if any matched.',
            })
        },
    )

    // ── read ─────────────────────────────────────────────────────────────
    mcp.registerTool(
        'mikser_webdav_read',
        {
            description:
                'Read a stored FILE back — by catalog id, by served URL, or as <endpoint>/<path>.\n\n'
                + 'An image comes back as an image you can actually look at, not as a refusal or as bytes you cannot '
                + 'reason about. A text file comes back as text. Anything else comes back described — size, type, '
                + 'where it is — because a utf8 read of a font is convincing garbage.\n\n'
                + 'This reads the SOURCE file. mikser_read_output reads what was built and deployed, which is a '
                + 'different question.',
            inputSchema: {
                path: z.string()
                    .describe('Catalog id ("/files/x.png"), served URL ("/media/x.png"), or "<endpoint>/<path>".'),
            },
        },
        async ({ path: pathish } = {}) => {
            const found = await locate(pathish, endpoints, workingFolder())
            if (found.error) return fail(found.error)

            let info
            try {
                info = await stat(found.file)
            } catch {
                return fail(`Nothing on disk at ${path.relative(workingFolder(), found.file)}.`)
            }
            const entity = found.entity
            const mime = mimeFor(found.file, entity?.meta?.mime)
            const meta = {
                path: path.relative(workingFolder(), found.file),
                size: info.size,
                mime,
                ...(entity ? {
                    id: entity.id,
                    reference: entity.meta?.url ?? entity.id,
                    ...(entity.meta?.presets ? { derived: entity.meta.presets } : {}),
                } : { note: 'Not in the catalog — read straight from disk.' }),
            }

            if (VIEWABLE.has(mime)) {
                if (info.size > MAX_VIEWABLE_BYTES) {
                    return ok({ ...meta, viewed: false,
                        note: `Too large to return as an image (${(info.size / 1024 / 1024).toFixed(1)}MB over the `
                            + `${Math.round(MAX_VIEWABLE_BYTES / 1024 / 1024)}MB cap). Its derived variants, if any, `
                            + 'are smaller and listed above.' })
                }
                const bytes = await readFile(found.file)
                // An image block and a text block: the picture to look at, and
                // the facts about it, which an image alone cannot carry.
                return {
                    content: [
                        { type: 'image', data: bytes.toString('base64'), mimeType: mime },
                        { type: 'text', text: JSON.stringify({ ...meta, viewed: true }, null, 2) },
                    ],
                }
            }

            if (TEXTUAL.test(mime)) {
                const text = await readFile(found.file, 'utf8')
                return ok({ ...meta, content: text, contentComplete: true })
            }

            return ok({ ...meta, viewed: false,
                note: `Not a viewable image or a text format, so the bytes are not returned — a utf8 read of a ${mime} `
                    + 'is convincing garbage. The facts above are what there is.' })
        },
    )

    // ── delete ───────────────────────────────────────────────────────────
    mcp.registerTool(
        'mikser_webdav_delete',
        {
            description:
                'Remove a stored FILE. It is moved to a trash folder under the runtime directory, never unlinked — a '
                + 'delete that turns out to be wrong is then a move back rather than a restore from backup.\n\n'
                + 'REFUSED when anything still references it, listing every (entity, field) that would break. Pass '
                + 'force: true to delete anyway, which leaves those references pointing at nothing.\n\n'
                + 'What it can see: values stored in entity META, including inside arrays. It cannot see a reference '
                + 'written in a document BODY, or one a layout builds at render time — so an empty list means '
                + '"nothing of the kind I look at", not "nothing at all". Use mikser_search({ in: ["content"] }) for '
                + 'body text.',
            inputSchema: {
                path: z.string().describe('Catalog id, served URL, or "<endpoint>/<path>".'),
                force: z.boolean().optional()
                    .describe('Delete even though something references it. Those references will break.'),
                dryRun: z.boolean().optional()
                    .describe('Report what would happen and what would break. Removes nothing.'),
            },
        },
        async ({ path: pathish, force = false, dryRun = false } = {}) => {
            const principal = mcp.principal?.() ?? null
            const found = await locate(pathish, endpoints, workingFolder())
            if (found.error) return fail(found.error)

            // Which endpoint owns it, for the capability check. Derived from
            // the resolved file rather than trusted from the input, so a served
            // URL is checked against the folder it actually lives in.
            const owning = found.endpoint ?? Object.keys(endpoints).find(name => {
                const root = folderOf(name)
                return root && !path.relative(root, found.file).startsWith('..')
            })
            if (!owning) {
                return fail(`${pathish} is not inside any configured WebDAV endpoint, so this will not remove it.`)
            }
            if (endpoints[owning].readOnly === true) {
                return fail(`${owning} is configured readOnly, so nothing can be removed from it.`)
            }
            if (!holds(principal, writeCapabilityOf(owning))) {
                return fail(`Refused: you do not hold ${writeCapabilityOf(owning)}. Nothing was removed.`)
            }
            try {
                await stat(found.file)
            } catch {
                return fail(`Nothing on disk at ${path.relative(workingFolder(), found.file)}.`)
            }

            // Who breaks. The reference is the served URL where there is one,
            // because that is the string documents actually carry.
            const reference = found.entity?.meta?.url ?? found.entity?.id ?? null
            const referrers = reference && rt.refs?.inboundFor
                ? rt.refs.inboundFor(reference)
                : []

            const breakage = {
                reference,
                referencedBy: referrers.length,
                references: referrers.map(r => ({ entity: r.id, field: r.field, kind: r.kind })),
                coverage: 'Values in entity meta, including inside arrays. NOT body text, and not links a layout '
                    + 'builds at render time — mikser_search({ in: ["content"] }) covers those.',
            }

            if (dryRun) {
                return ok({
                    dryRun: true, endpoint: owning,
                    path: path.relative(workingFolder(), found.file),
                    id: found.entity?.id ?? null,
                    wouldRefuse: referrers.length > 0 && !force,
                    ...breakage,
                    note: 'Nothing was removed.',
                })
            }

            if (referrers.length && !force) {
                return fail(`Refused: ${referrers.length} reference(s) would break.\n\n`
                    + referrers.map(r => `  ${r.entity ?? r.id}  ${r.field}`).join('\n')
                    + '\n\nNothing was removed. Repoint or remove those first, or pass force: true to delete anyway '
                    + 'and leave them pointing at nothing. Body-text references are not counted here — check with '
                    + 'mikser_search({ in: ["content"] }).')
            }

            // Trash, not unlink. Under the runtime folder so it is outside every
            // served collection — dropping it inside one would republish the
            // file at a new URL and, where git sync is on, commit it.
            const stamp = new Date().toISOString().replace(/[:.]/g, '-')
            const trash = path.join(rt.options.runtimeFolder ?? path.join(workingFolder(), 'runtime'),
                                    'trash', stamp, owning, path.basename(found.file))
            await mkdir(path.dirname(trash), { recursive: true })
            try {
                await rename(found.file, trash)
            } catch {
                // Across devices rename fails; copy-then-unlink is the fallback.
                await writeFile(trash, await readFile(found.file))
                await unlink(found.file)
            }
            logger?.info?.('webdav: trashed %s from %s for %j%s',
                path.relative(workingFolder(), found.file), owning,
                principal?.subject ?? 'anonymous', force && referrers.length ? ' (forced over references)' : '')

            return ok({
                removed: true,
                endpoint: owning,
                path: path.relative(workingFolder(), found.file),
                id: found.entity?.id ?? null,
                trash: path.relative(workingFolder(), trash),
                cycleId: nextCycleId(),
                ...breakage,
                ...(force && referrers.length ? {
                    broke: `Forced past ${referrers.length} reference(s), which now point at nothing.`,
                } : {}),
                restore: `Move it back from ${path.relative(workingFolder(), trash)} to undo this.`,
            })
        },
    )


    // ── move ─────────────────────────────────────────────────────────────
    mcp.registerTool(
        'mikser_webdav_move',
        {
            description:
                'Move or rename a stored FILE. Refused by default when anything still references it, listing every '
                + '(entity, field) that would break — a move is a rename of the thing documents point at, so the '
                + 'references are the whole risk.\n\n'
                + 'With rewriteRefs: true it moves AND repoints them, editing each referring source file. Reference '
                + 'strings here are plain rooted paths ("/media/x.png") rather than $-keyed refs, so this rewrites '
                + 'the literal string; the response names every file changed and how many occurrences in each.\n\n'
                + 'It sees values in entity META, including inside arrays. It cannot see a reference in a document '
                + 'BODY or one a layout builds at render time — so an empty list means "nothing of the kind I look '
                + 'at". Check body text with mikser_search({ in: ["content"] }) before forcing.',
            inputSchema: {
                from: z.string().describe('Catalog id, served URL, or "<endpoint>/<path>".'),
                to: z.string().describe('Destination, relative to the SAME endpoint, e.g. "devices/hera/cta.png".'),
                rewriteRefs: z.boolean().optional()
                    .describe('Repoint every meta reference at the new location instead of refusing.'),
                dryRun: z.boolean().optional()
                    .describe('Report what would move and what would be rewritten. Changes nothing.'),
            },
        },
        async ({ from, to, rewriteRefs = false, dryRun = false } = {}) => {
            const principal = mcp.principal?.() ?? null
            const found = await locate(from, endpoints, workingFolder())
            if (found.error) return fail(found.error)

            const owning = found.endpoint ?? Object.keys(endpoints).find(name => {
                const root = folderOf(name)
                return root && !path.relative(root, found.file).startsWith('..')
            })
            if (!owning) return fail(`${from} is not inside any configured endpoint.`)
            if (endpoints[owning].readOnly === true) {
                return fail(`${owning} is configured readOnly, so nothing can be moved within it.`)
            }
            if (!holds(principal, writeCapabilityOf(owning))) {
                return fail(`Refused: you do not hold ${writeCapabilityOf(owning)}. Nothing was moved.`)
            }
            const dest = safeSegment(to, 'to')
            if (dest.error) return fail(dest.error)
            try { await stat(found.file) } catch {
                return fail(`Nothing on disk at ${path.relative(workingFolder(), found.file)}.`)
            }
            const target = path.join(folderOf(owning), dest.value)
            if (target === found.file) return fail('`to` is the same path as `from`.')
            let clash = false
            try { await stat(target); clash = true } catch { /* free */ }
            if (clash) return fail(`${dest.value} already exists in ${owning}. Nothing was moved.`)

            // What points at it, and what those references would have to become.
            const oldRef = found.entity?.meta?.url ?? null
            const referrers = oldRef && rt.refs?.inboundFor ? rt.refs.inboundFor(oldRef) : []
            // The new served URL is the old one with the path swapped. Derived
            // from the old rather than rebuilt, so a deployment that prefixes
            // its URLs differently is not second-guessed.
            const newRef = oldRef
                ? oldRef.slice(0, oldRef.length - path.relative(folderOf(owning), found.file).length) + dest.value
                : null

            const breakage = {
                from: path.relative(workingFolder(), found.file),
                to: path.relative(workingFolder(), target),
                reference: oldRef,
                newReference: newRef,
                referencedBy: referrers.length,
                references: referrers.map(r => ({ entity: r.id, field: r.field, kind: r.kind })),
                coverage: 'Values in entity meta, including inside arrays. NOT body text, and not links a layout '
                    + 'builds at render time — mikser_search({ in: ["content"] }) covers those.',
            }

            if (dryRun) {
                return ok({ dryRun: true, endpoint: owning, ...breakage,
                    wouldRefuse: referrers.length > 0 && !rewriteRefs,
                    wouldRewrite: rewriteRefs ? [...new Set(referrers.map(r => r.id))] : [],
                    note: 'Nothing was moved or rewritten.' })
            }

            if (referrers.length && !rewriteRefs) {
                return fail(`Refused: ${referrers.length} reference(s) point at ${oldRef}.\n\n`
                    + referrers.map(r => `  ${r.id}  ${r.field}`).join('\n')
                    + '\n\nNothing was moved. Pass rewriteRefs: true to move and repoint them, or repoint them '
                    + 'yourself first. Body-text references are not counted here — check with '
                    + 'mikser_search({ in: ["content"] }).')
            }

            await mkdir(path.dirname(target), { recursive: true })
            try {
                await rename(found.file, target)
            } catch {
                await writeFile(target, await readFile(found.file))
                await unlink(found.file)
            }

            // Repoint the referrers, by editing the literal string in each
            // source file. A rooted path like /media/x.png is specific enough
            // that a coincidental match is not a real risk, and every file
            // changed is named so the caller can check rather than trust.
            const rewritten = []
            if (rewriteRefs && oldRef && newRef) {
                for (const id of [...new Set(referrers.map(r => r.id))]) {
                    const entity = await readEntity({ id })
                    if (!entity?.uri) { rewritten.push({ id, rewrote: 0, note: 'no source file' }); continue }
                    try {
                        const before = await readFile(entity.uri, 'utf8')
                        const occurrences = before.split(oldRef).length - 1
                        if (!occurrences) { rewritten.push({ id, rewrote: 0, note: 'not present as literal text' }); continue }
                        await writeFile(entity.uri, before.split(oldRef).join(newRef), 'utf8')
                        rewritten.push({ id, path: path.relative(workingFolder(), entity.uri), rewrote: occurrences })
                    } catch (err) {
                        rewritten.push({ id, rewrote: 0, error: err.message })
                    }
                }
            }
            logger?.info?.('webdav: moved %s to %s for %j%s',
                path.relative(workingFolder(), found.file), dest.value, principal?.subject ?? 'anonymous',
                rewritten.length ? ` (repointed ${rewritten.length} referrer(s))` : '')

            const missed = rewritten.filter(r => !r.rewrote)
            return ok({
                moved: true, endpoint: owning, ...breakage,
                cycleId: nextCycleId(),
                ...(rewriteRefs ? { rewritten } : {}),
                ...(missed.length ? {
                    warning: `${missed.length} referrer(s) were not rewritten — the reference is not in their source `
                        + 'as literal text, so it is built at render time or lives in a body. Those still point at '
                        + `${oldRef}, which no longer exists.`,
                } : {}),
            })
        },
    )

    logger?.debug?.('mikser_webdav_add/read/move/delete registered')
}
