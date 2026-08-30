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
import { lookup as mimeLookup } from 'mime-types'
// One implementation of "is this text", in the engine, so drive and
// read_entity cannot drift into disagreeing about the same file.
// Drive writes with fs directly rather than through a collection handle, so
// it records its own paths. Without this a media replacement — the change most
// worth taking back — falls into the unattributed sweep.
import { looksTextual, recordChangeSetWrite, explainRefusal, actingRole } from 'mikser-io'
import { readFile, writeFile, mkdir, rename, stat, unlink, open } from 'node:fs/promises'
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

// How much of a file is enough to tell text from binary. A binary format
// that hides every NUL and every invalid sequence for 8KB is not one anybody
// stores here.
const SNIFF_BYTES = 8 * 1024

// The mime is a LABEL, not a decision. `mime-types` is the IANA registry via
// mime-db — some thousand types against the eighteen this hand-maintained a
// map of, which is why `.woff2`, `.toml`, `.csv` and `.sql` now come back
// named instead of as `application/octet-stream`.
//
// It is still not complete, and nothing ever will be: `.liquid`, `.eta` and
// `.rst` are not in the registry either. That is the point — whether content
// comes back is decided by reading the bytes, so an unregistered extension
// costs an accurate label and nothing else.
function mimeFor(name, given) {
    return given || mimeLookup(name) || 'application/octet-stream'
}

// Read at most `limit` bytes. Returned separately from the decode so the
// caller can sniff the same buffer it is about to hand back.
async function readPrefix(file, limit) {
    const handle = await open(file, 'r')
    try {
        const buf = Buffer.alloc(limit)
        const { bytesRead } = await handle.read(buf, 0, limit, 0)
        return buf.subarray(0, bytesRead)
    } finally {
        await handle.close()
    }
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
                + 'runs one. Read a file back with mikser_drive_read once a build has run.',
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
        'mikser_drive_add',
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
            mutates: true,
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
                        + `folder is reachable over WebDAV at /drive/${endpoint} with ordinary credentials.`)
                }
                total += bytes.length
                if (total > MAX_BATCH_BYTES) {
                    return fail(`The batch exceeds the ${Math.round(MAX_BATCH_BYTES / 1024 / 1024)}MB cap at `
                        + `files[${i}] (${named.value}). Nothing was written. Send fewer per call, or place `
                        + `them on a WebDAV mount at /drive/${endpoint} instead.`)
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
                recordChangeSetWrite({ uri: s.file })
                written.push(s)
            }
            logger?.info?.('drive: stored %d file(s) in %s for %j (%d bytes)',
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
        'mikser_drive_read',
        {
            description:
                'Read a stored FILE back — by catalog id, by served URL, or as <endpoint>/<path>.\n\n'
                + 'An image comes back as an image you can actually look at, not as a refusal or as bytes you cannot '
                + 'reason about. A text file comes back as text — decided by reading the bytes, not by the '
                + 'extension, so templates (.liquid, .hbs, .eta) and anything else textual come back as text '
                + 'whether or not the type is one this tool has heard of. Genuinely binary files come back '
                + 'described — size, type, where it is — because a utf8 read of a font is convincing garbage.\n\n'
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

            // Reads are capability-gated, the same as the WebDAV mount, which
            // has always checked `drive:<name>` before serving a byte. This
            // tool did not, so the two surfaces disagreed about the same
            // endpoint — and a `readOnly` list derived from capabilities was
            // describing a rule only half the transports enforced.
            //
            // A credential that is not capability-scoped is unaffected: holds()
            // returns true for it, and the endpoint's own gate still applies.
            const principal = mcp.principal?.() ?? null
            if (found.endpoint && !holds(principal, capabilityOf(found.endpoint))) {
                return fail(explainRefusal({
                    capability: capabilityOf(found.endpoint),
                    role: actingRole(principal?.roles ?? [], rt.options?.roles?.catalogue ?? {}),
                    target: pathish,
                    catalogue: rt.options?.roles?.catalogue ?? {},
                    summaries: rt.options?.roles?.summaries ?? {},
                }))
            }

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

            // Decided by the bytes, every time. Not by a mime allowlist with
            // a fast path, because a fast path IS the allowlist: it decides
            // the answer for everything it happens to list and hands the rest
            // to a rule nobody checked against it. Bounded, because an
            // unbounded read of whatever is on disk is how a 40MB log ends up
            // being the whole answer.
            const prefix = await readPrefix(found.file, Math.min(info.size, MAX_FILE_BYTES))
            const textual = looksTextual(prefix.subarray(0, Math.min(prefix.length, SNIFF_BYTES)))

            if (textual) {
                const complete = info.size <= MAX_FILE_BYTES
                // Non-fatal on purpose: a cut at MAX_FILE_BYTES can land
                // mid-codepoint, and one replacement character at the very end
                // of an explicitly truncated read is not worth failing over.
                const text = new TextDecoder('utf8').decode(prefix)
                return ok({
                    ...meta,
                    content: text,
                    contentComplete: complete,
                    ...(complete ? {} : {
                        returnedBytes: prefix.length,
                        note: `Truncated at the ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB read cap — `
                            + `this is the first ${prefix.length} of ${info.size} bytes. Do not write it back as `
                            + 'if it were the whole file.',
                    }),
                    typedBy: 'content',
                    // Worth saying only when the label and the bytes disagree.
                    // Silence otherwise: a note on every read of a .txt is
                    // noise, and noise is what gets skimmed past on the read
                    // where it mattered.
                    ...(mime === 'application/octet-stream' ? {
                        typeNote: 'The extension is not in the mime registry, so the type is unnamed — but the '
                            + 'bytes are valid UTF-8 with no NUL, so the content is returned as text.',
                    } : {}),
                })
            }

            return ok({ ...meta, viewed: false, typedBy: 'content',
                note: `Not a viewable image, and the bytes are not text — a utf8 read of a ${mime} `
                    + 'is convincing garbage. The facts above are what there is.' })
        },
    )

    // ── delete ───────────────────────────────────────────────────────────
    mcp.registerTool(
        'mikser_drive_delete',
        {
            description:
                'Remove stored FILES. They are moved to a trash folder under the runtime directory, never unlinked '
                + '— a delete that turns out to be wrong is then a move back rather than a restore from backup.\n\n'
                + 'Send the whole set in ONE call. Like mikser_drive_add, the batch is claimed as a single build '
                + 'cycle; N separate calls cost N cycles and N rebuilds.\n\n'
                + 'All-or-nothing: if any path cannot be removed, nothing is removed and every reason is listed. '
                + 'REFUSED when anything still references a file, listing every (entity, field) that would break. '
                + 'Pass force: true to delete anyway, which leaves those references pointing at nothing.\n\n'
                + 'What it can see: values stored in entity META, including inside arrays. It cannot see a reference '
                + 'written in a document BODY, or one a layout builds at render time — so an empty list means '
                + '"nothing of the kind I look at", not "nothing at all". Use mikser_search({ in: ["content"] }) for '
                + 'body text.',
            inputSchema: {
                paths: z.array(z.string()).min(1)
                    .describe('The batch. Each entry a catalog id, served URL, or "<endpoint>/<path>". Sent '
                        + 'together so one build cycle covers them all.'),
                force: z.boolean().optional()
                    .describe('Delete even though something references them. Those references will break.'),
                dryRun: z.boolean().optional()
                    .describe('Report what would happen and what would break. Removes nothing.'),
            },
            mutates: true,
        },
        async ({ paths, force = false, dryRun = false } = {}) => {
            const principal = mcp.principal?.() ?? null

            // Resolve and check EVERY path before touching any of them. A
            // half-applied batch leaves the caller guessing which half landed,
            // and there is no cheap way for them to find out.
            const staged = []
            const problems = []
            const claimed = new Map()
            for (const pathish of paths) {
                const refuse = (reason) => problems.push({ path: pathish, reason })
                const found = await locate(pathish, endpoints, workingFolder())
                if (found.error) { refuse(found.error); continue }

                // Which endpoint owns it, for the capability check. Derived from
                // the resolved file rather than trusted from the input, so a
                // served URL is checked against the folder it actually lives in.
                const owning = found.endpoint ?? Object.keys(endpoints).find(name => {
                    const root = folderOf(name)
                    return root && !path.relative(root, found.file).startsWith('..')
                })
                if (!owning) { refuse('Not inside any configured endpoint, so this will not remove it.'); continue }
                if (endpoints[owning].readOnly === true) {
                    refuse(`${owning} is configured readOnly, so nothing can be removed from it.`); continue
                }
                if (!holds(principal, writeCapabilityOf(owning))) {
                    refuse(`You do not hold ${writeCapabilityOf(owning)}.`); continue
                }
                try { await stat(found.file) } catch {
                    refuse(`Nothing on disk at ${path.relative(workingFolder(), found.file)}.`); continue
                }
                // Two inputs can name one file — an id and its served URL. The
                // second rename would fail on a file already in the trash, so
                // it is caught here rather than surfacing as a mid-batch error.
                const already = claimed.get(found.file)
                if (already !== undefined) {
                    refuse(`Same file as ${JSON.stringify(already)}, listed twice.`); continue
                }
                claimed.set(found.file, pathish)

                // Who breaks. The reference is the served URL where there is
                // one, because that is the string documents actually carry.
                const reference = found.entity?.meta?.url ?? found.entity?.id ?? null
                const referrers = reference && rt.refs?.inboundFor ? rt.refs.inboundFor(reference) : []
                staged.push({ input: pathish, file: found.file, entity: found.entity, owning, reference, referrers })
            }

            if (problems.length) {
                return fail(`Refused: ${problems.length} of ${paths.length} path(s) cannot be removed, so none `
                    + 'were — the batch is all-or-nothing.\n\n'
                    + problems.map(p => `  ${p.path}\n      ${p.reason}`).join('\n'))
            }

            const coverage = 'Values in entity meta, including inside arrays. NOT body text, and not links a layout '
                + 'builds at render time — mikser_search({ in: ["content"] }) covers those.'
            const describe = (s) => ({
                path: path.relative(workingFolder(), s.file),
                id: s.entity?.id ?? null,
                endpoint: s.owning,
                reference: s.reference,
                referencedBy: s.referrers.length,
                references: s.referrers.map(r => ({ entity: r.id, field: r.field, kind: r.kind })),
            })
            const blocked = staged.filter(s => s.referrers.length)

            if (dryRun) {
                return ok({
                    dryRun: true,
                    files: staged.map(describe),
                    wouldRemove: staged.length,
                    wouldRefuse: blocked.length > 0 && !force,
                    coverage,
                    note: 'Nothing was removed.',
                })
            }

            if (blocked.length && !force) {
                return fail(`Refused: ${blocked.length} of ${staged.length} file(s) are still referenced, so none `
                    + 'were removed.\n\n'
                    + blocked.map(s => `  ${s.reference}\n`
                        + s.referrers.map(r => `      ${r.entity ?? r.id}  ${r.field}`).join('\n')).join('\n')
                    + '\n\nRepoint or remove those first, or pass force: true to delete anyway and leave them '
                    + 'pointing at nothing. Body-text references are not counted here — check with '
                    + 'mikser_search({ in: ["content"] }).')
            }

            // One cycle for the whole batch, claimed before the first rename so
            // the watcher's debounce coalesces them all into it. Claiming it
            // afterwards — as this did while delete was single-file — yields an
            // id for a cycle that has already been and gone.
            const cycleId = nextCycleId()

            // Trash, not unlink. Under the runtime folder so it is outside every
            // served collection — dropping it inside one would republish the
            // file at a new URL and, where git sync is on, commit it. One stamp
            // for the batch, so undoing it is one move back.
            const stamp = new Date().toISOString().replace(/[:.]/g, '-')
            const trashRoot = path.join(rt.options.runtimeFolder ?? path.join(workingFolder(), 'runtime'),
                                        'trash', stamp)
            const results = []
            for (const s of staged) {
                const trash = path.join(trashRoot, s.owning, path.basename(s.file))
                await mkdir(path.dirname(trash), { recursive: true })
                try {
                    await rename(s.file, trash)
                } catch {
                    // Across devices rename fails; copy-then-unlink is the fallback.
                    await writeFile(trash, await readFile(s.file))
                    await unlink(s.file)
                }
                recordChangeSetWrite({ uri: s.file, operation: 'delete' })
                results.push({ ...describe(s), trash: path.relative(workingFolder(), trash) })
            }
            logger?.info?.('drive: trashed %d file(s) for %j%s',
                results.length, principal?.subject ?? 'anonymous',
                force && blocked.length ? ` (forced over ${blocked.length} referenced)` : '')

            const report = await settledCycle(cycleId)

            return ok({
                removed: results.length,
                cycleId,
                trash: path.relative(workingFolder(), trashRoot),
                files: results,
                coverage,
                ...(force && blocked.length ? {
                    broke: `Forced past ${blocked.length} referenced file(s), whose referrers now point at nothing.`,
                } : {}),
                ...(report.completed ? {
                    cycle: { id: report.cycleId ?? cycleId, rendered: report.summary?.rendered ?? null,
                             errors: report.summary?.errors ?? null, warnings: report.summary?.warnings ?? null },
                } : { cycleNote: report.note }),
                restore: `Move everything back from ${path.relative(workingFolder(), trashRoot)} to undo this batch.`,
            })
        },
    )


    // ── move ─────────────────────────────────────────────────────────────
    mcp.registerTool(
        'mikser_drive_move',
        {
            description:
                'Move stored FILES within their endpoint, optionally repointing everything that references them.\n\n'
                + 'Send the whole set in ONE call. Like mikser_drive_add, the batch is claimed as a single build '
                + 'cycle; N separate calls cost N cycles and N rebuilds.\n\n'
                + 'All-or-nothing: if any move cannot be made, nothing moves and every reason is listed. REFUSED by '
                + 'default when anything references a file, listing every (entity, field) that would break. With '
                + 'rewriteRefs: true it moves AND repoints them, naming every file it edited.\n\n'
                + 'What it can see: values stored in entity META, including inside arrays. A reference in a document '
                + 'BODY, or one a layout builds at render time, is neither counted nor rewritten — those are '
                + 'reported as missed rather than silently left behind. Use mikser_search({ in: ["content"] }).',
            inputSchema: {
                moves: z.array(z.object({
                    from: z.string().describe('Catalog id, served URL, or "<endpoint>/<path>".'),
                    to: z.string().describe('Destination, relative to the SAME endpoint, e.g. "devices/hera/cta.png".'),
                })).min(1).describe('The batch. Sent together so one build cycle covers them all.'),
                rewriteRefs: z.boolean().optional()
                    .describe('Repoint every meta reference at the new location instead of refusing.'),
                dryRun: z.boolean().optional()
                    .describe('Report what would move and what would be rewritten. Changes nothing.'),
            },
            mutates: true,
        },
        async ({ moves, rewriteRefs = false, dryRun = false } = {}) => {
            const principal = mcp.principal?.() ?? null

            const staged = []
            const problems = []
            const sources = new Map()
            const targets = new Map()
            for (const [index, entry] of moves.entries()) {
                const { from, to } = entry ?? {}
                const label = `${from ?? '(no from)'} → ${to ?? '(no to)'}`
                const refuse = (reason) => problems.push({ move: label, reason })
                if (!from || !to) { refuse('Both `from` and `to` are required.'); continue }

                const found = await locate(from, endpoints, workingFolder())
                if (found.error) { refuse(found.error); continue }

                const owning = found.endpoint ?? Object.keys(endpoints).find(name => {
                    const root = folderOf(name)
                    return root && !path.relative(root, found.file).startsWith('..')
                })
                if (!owning) { refuse('`from` is not inside any configured endpoint.'); continue }
                if (endpoints[owning].readOnly === true) {
                    refuse(`${owning} is configured readOnly, so nothing can be moved within it.`); continue
                }
                if (!holds(principal, writeCapabilityOf(owning))) {
                    refuse(`You do not hold ${writeCapabilityOf(owning)}.`); continue
                }
                const dest = safeSegment(to, 'to')
                if (dest.error) { refuse(dest.error); continue }
                try { await stat(found.file) } catch {
                    refuse(`Nothing on disk at ${path.relative(workingFolder(), found.file)}.`); continue
                }
                const target = path.join(folderOf(owning), dest.value)
                if (target === found.file) { refuse('`to` is the same path as `from`.'); continue }
                let clash = false
                try { await stat(target); clash = true } catch { /* free */ }
                if (clash) { refuse(`${dest.value} already exists in ${owning}.`); continue }

                // Cross-entry checks. Within one batch the result must not
                // depend on the order entries happen to be applied in, so a
                // source moved twice and two entries landing on one destination
                // are refused rather than resolved. A chain (A→B, B→C) needs no
                // check of its own: B exists on disk, so the clash check above
                // already refused it before anything moved.
                const dupe = sources.get(found.file)
                if (dupe !== undefined) { refuse(`Same source as ${JSON.stringify(dupe)}, listed twice.`); continue }
                const taken = targets.get(target)
                if (taken !== undefined) { refuse(`Two entries both move onto ${dest.value}.`); continue }
                sources.set(found.file, label)
                targets.set(target, label)
                staged.push({ index, label, from, file: found.file, entity: found.entity, owning, target, dest: dest.value })
            }

            if (problems.length) {
                return fail(`Refused: ${problems.length} of ${moves.length} move(s) cannot be made, so none were `
                    + '— the batch is all-or-nothing.\n\n'
                    + problems.map(p => `  ${p.move}\n      ${p.reason}`).join('\n'))
            }

            // What points at each, and what those references would become. The
            // new served URL is the old one with the path swapped — derived from
            // the old rather than rebuilt, so a deployment that prefixes its
            // URLs differently is not second-guessed.
            for (const s of staged) {
                s.oldRef = s.entity?.meta?.url ?? null
                s.referrers = s.oldRef && rt.refs?.inboundFor ? rt.refs.inboundFor(s.oldRef) : []
                s.newRef = s.oldRef
                    ? s.oldRef.slice(0, s.oldRef.length - path.relative(folderOf(s.owning), s.file).length) + s.dest
                    : null
            }

            const coverage = 'Values in entity meta, including inside arrays. NOT body text, and not links a layout '
                + 'builds at render time — mikser_search({ in: ["content"] }) covers those.'
            const describe = (s) => ({
                from: path.relative(workingFolder(), s.file),
                to: path.relative(workingFolder(), s.target),
                endpoint: s.owning,
                reference: s.oldRef,
                newReference: s.newRef,
                referencedBy: s.referrers.length,
                references: s.referrers.map(r => ({ entity: r.id, field: r.field, kind: r.kind })),
            })
            const blocked = staged.filter(s => s.referrers.length)

            if (dryRun) {
                return ok({
                    dryRun: true,
                    moves: staged.map(describe),
                    wouldMove: staged.length,
                    wouldRefuse: blocked.length > 0 && !rewriteRefs,
                    wouldRewrite: rewriteRefs
                        ? [...new Set(blocked.flatMap(s => s.referrers.map(r => r.id)))] : [],
                    coverage,
                    note: 'Nothing was moved or rewritten.',
                })
            }

            if (blocked.length && !rewriteRefs) {
                return fail(`Refused: ${blocked.length} of ${staged.length} file(s) are referenced, so none were `
                    + 'moved.\n\n'
                    + blocked.map(s => `  ${s.oldRef}\n`
                        + s.referrers.map(r => `      ${r.id}  ${r.field}`).join('\n')).join('\n')
                    + '\n\nPass rewriteRefs: true to move and repoint them, or repoint them yourself first. '
                    + 'Body-text references are not counted here — check with mikser_search({ in: ["content"] }).')
            }

            // One cycle for the whole batch, claimed before the first rename so
            // the watcher's debounce coalesces them all into it.
            const cycleId = nextCycleId()

            for (const s of staged) {
                await mkdir(path.dirname(s.target), { recursive: true })
                try {
                    await rename(s.file, s.target)
                } catch {
                    await writeFile(s.target, await readFile(s.file))
                    await unlink(s.file)
                }
                // Both ends: a move is a delete and a create, and an undo that
                // restored the file without removing the copy would leave two.
                recordChangeSetWrite({ uri: s.file, operation: 'delete' })
                recordChangeSetWrite({ uri: s.target })
            }

            // Repoint the referrers, by editing the literal string in each
            // source file. A rooted path like /media/x.png is specific enough
            // that a coincidental match is not a real risk, and every file
            // changed is named so the caller can check rather than trust.
            //
            // Grouped by referring entity, not by moved file: one document that
            // cites three of the moved files is then read and written once, and
            // cannot lose two of the three rewrites to a stale read.
            const rewritten = []
            if (rewriteRefs) {
                const byEntity = new Map()
                for (const s of staged) {
                    if (!s.oldRef || !s.newRef) continue
                    for (const id of new Set(s.referrers.map(r => r.id))) {
                        if (!byEntity.has(id)) byEntity.set(id, [])
                        byEntity.get(id).push({ oldRef: s.oldRef, newRef: s.newRef })
                    }
                }
                for (const [id, swaps] of byEntity) {
                    const entity = await readEntity({ id })
                    if (!entity?.uri) { rewritten.push({ id, rewrote: 0, note: 'no source file' }); continue }
                    try {
                        const before = await readFile(entity.uri, 'utf8')
                        let after = before
                        let occurrences = 0
                        for (const { oldRef, newRef } of swaps) {
                            const hits = after.split(oldRef).length - 1
                            if (!hits) continue
                            occurrences += hits
                            after = after.split(oldRef).join(newRef)
                        }
                        if (!occurrences) {
                            rewritten.push({ id, rewrote: 0, note: 'not present as literal text' }); continue
                        }
                        await writeFile(entity.uri, after, 'utf8')
                        rewritten.push({ id, path: path.relative(workingFolder(), entity.uri), rewrote: occurrences })
                    } catch (err) {
                        rewritten.push({ id, rewrote: 0, error: err.message })
                    }
                }
            }
            logger?.info?.('drive: moved %d file(s) for %j%s',
                staged.length, principal?.subject ?? 'anonymous',
                rewritten.length ? ` (repointed ${rewritten.length} referrer(s))` : '')

            const report = await settledCycle(cycleId)
            const missed = rewritten.filter(r => !r.rewrote)

            return ok({
                moved: staged.length,
                cycleId,
                moves: staged.map(describe),
                coverage,
                ...(rewriteRefs ? { rewritten } : {}),
                ...(missed.length ? {
                    warning: `${missed.length} referrer(s) were not rewritten — the reference is not in their source `
                        + 'as literal text, so it is built at render time or lives in a body. Those still point at '
                        + 'locations that no longer exist.',
                } : {}),
                ...(report.completed ? {
                    cycle: { id: report.cycleId ?? cycleId, rendered: report.summary?.rendered ?? null,
                             errors: report.summary?.errors ?? null, warnings: report.summary?.warnings ?? null },
                } : { cycleNote: report.note }),
            })
        },
    )

    logger?.debug?.('mikser_drive_add/read/move/delete registered')
}
