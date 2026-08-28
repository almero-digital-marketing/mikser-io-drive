// A ready-to-use client configuration for the WebDAV endpoints this caller can
// actually reach.
//
// The problem it solves is friction, not access. The authenticator already
// accepts a Bearer token on every endpoint — measured: PROPFIND 207, PUT 201,
// GET 200 with an OAuth token, 401 without — so an agent with rclone or curl
// can already mount this. What it could not easily discover was WHICH
// endpoints exist, which of them its own capabilities allow it to write, and
// what the client invocation looks like.
//
// MCP tools are the right shape for editing a page. They are the wrong shape
// for moving a 40MB video, and that is what this exists for.
//
// Three things it deliberately does not do:
//
//   - No token in the output. The config carries `$MIKSER_TOKEN` and the
//     caller substitutes the credential it is already authenticating with.
//     Inlining it would mean the substrate handing out raw credentials to
//     every registered tool, and would put a live token in the caller's
//     transcript — to save one string substitution.
//   - No writing to disk. An rclone config file belongs to the person running
//     rclone, and persisting a credential into a file mikser does not own is
//     not this tool's business.
//   - No davfs2 line. davfs2 speaks Basic only, so it would need a password
//     rather than the token — walking straight back into what using Bearer
//     avoids. Said out loud in the response rather than silently omitted.


// Which of read / write this caller actually holds for an endpoint.
//
// Computed from the caller's own capabilities rather than from the endpoint,
// so an agent learns it cannot write BEFORE streaming a large upload into a
// 403 — the same reason a write refuses ahead of expiry rather than part way
// through.
function accessFor(principal, { name, readOnly, capability, writeCapability }) {
    const held = principal?.capabilities
    // A credential that declares no capabilities is not capability-scoped —
    // a static token, or a loopback caller. The endpoint's own gate still
    // applies; this cannot say more than "unknown" without guessing.
    if (held == null) return { access: readOnly ? 'read-only' : 'unknown' }
    const canRead  = held.includes(capability)
    const canWrite = !readOnly && held.includes(writeCapability)
    if (!canRead && !canWrite) {
        return { access: 'none', why: `you hold neither ${capability} nor ${writeCapability}` }
    }
    if (readOnly) return { access: 'read-only', why: `${name} is configured readOnly for everyone` }
    if (!canWrite) return { access: 'read-only', why: `you hold ${capability} but not ${writeCapability}` }
    return { access: 'read-write' }
}

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] })
const fail = (message) => ({ isError: true, content: [{ type: 'text', text: message }] })

const rcloneBlock = (remote, url, placeholder = '$MIKSER_TOKEN') =>
    `[${remote}]\ntype = webdav\nurl = ${url}\nvendor = other\nbearer_token = ${placeholder}\n`

// Expiry IS the revocation mechanism for a minted token, so it is short and
// hard-capped. Fifteen minutes is long enough for a large upload on a slow
// link and short enough that a token sitting in a transcript stops mattering
// quickly.
const TTL_DEFAULT = 300
const TTL_MAX = 900

// `documents/` is the one endpoint where a raw PUT is almost always the wrong
// tool, so write there is withheld unless asked for twice. See the refusal
// text for why.
const GUARDED_ENDPOINT = 'content'

export function registerWebdavMcp({ runtime, base, endpoints, capabilityOf, writeCapabilityOf, logger }) {
    // Registered on the MCP substrate, which mirrors it into the engine's
    // registry — so it answers on the CLI too.
    //
    // It is aimed at a remote client: a caller with a shell already has the
    // folders and does not need a mount config. But one tool is not worth an
    // exception in the registry, and a slightly noisy `--tools` listing is a
    // smaller cost than a second rule about where tools live.
    //
    // The substrate accepts the engine's neutral `{ type, description }`
    // vocabulary, so describing one optional string costs no zod dependency
    // here. If this ever needs an enum or a range, zod is the way.
    const mcp = runtime.options.mcp
    if (!mcp?.registerTool) return

    // ONE door to the file surface, not two.
    //
    // This was split: a config tool that returned a $MIKSER_TOKEN placeholder
    // and a separate minting tool that returned a real credential. An agent had
    // to know which to call and why, and the split invited exactly the confusion
    // it was meant to avoid — two responses with a `token` field meaning
    // different things.
    //
    // Now the argument decides. No endpoint named: the map — what exists, what
    // you may write, no credential, because there is nothing to scope one to.
    // Name an endpoint: the same answer for it, plus a credential minted for
    // that endpoint alone and the commands to use it.
    mcp.registerTool(
        'mikser_webdav_access',
        {
            description:
                'File access over WebDAV, for moving bytes rather than editing content — a media upload, a bulk '
                + 'sync, a directory listing. Nothing transfers through this tool: it hands you a door and the '
                + 'transfer happens over HTTP, so a gigabyte costs the same few tokens as a thumbnail.\n\n'
                + 'Called with NO endpoint it lists what exists: every endpoint, the folder behind it, and whether '
                + 'your own capabilities let you write there. No credential, because there is nothing to scope one to '
                + 'yet.\n\n'
                + 'Called WITH an endpoint it also mints a credential for that endpoint alone: read-only unless you '
                + `pass write: true, ${TTL_DEFAULT}s by default and ${TTL_MAX}s at most, revokable, and never carrying `
                + 'a capability you do not already hold. Asking for more than you hold is refused with the missing '
                + 'scope named.\n\n'
                + 'The ttl is how long you have to START a transfer, not how long it may run. Authorization happens '
                + 'once, when the request begins, so an upload that takes an hour completes fine on a token that '
                + 'expired in its first minute. Long transfers are bounded instead by the server request timeout '
                + '(config.server.requestTimeout).\n\n'
                + 'For changing the text on a page use update_entity instead: it is checksum-guarded, previews what '
                + 'the edit would invalidate, returns the build report, and raises the spec-locked advisory. A PUT '
                + 'loses all four.',
            inputSchema: {
                endpoint: { type: 'string',
                    description: 'Endpoint to get a credential for. Omit to list what exists without minting anything.' },
                write: { type: 'boolean',
                    description: 'Ask for write as well as read. Default false. Ignored when no endpoint is named.' },
                ttl: { type: 'number',
                    description: `Seconds you have to START a transfer. Default ${TTL_DEFAULT}, clamped to ${TTL_MAX}; the response says when it was clamped. A transfer already under way is not interrupted when this expires.` },
                allowContentWrite: { type: 'boolean',
                    description: 'Required IN ADDITION to write:true for write on the documents endpoint. Editing page text belongs on update_entity; see the refusal for why.' },
            },
        },
        async ({ endpoint, write = false, ttl, allowContentWrite = false } = {}) => {
            const principal = mcp.principal?.() ?? null
            const origin = runtime.options.url ?? `http://localhost:${runtime.options.port ?? ''}`

            const describe = ([name, ep]) => ({
                name,
                url: `${origin}${base}/${name}`,
                folder: ep.folder,
                ...accessFor(principal, {
                    name,
                    readOnly: ep.readOnly === true,
                    capability: capabilityOf(name),
                    writeCapability: writeCapabilityOf(name),
                }),
            })

            // ── the map ──────────────────────────────────────────────────
            if (!endpoint) {
                const rows = Object.entries(endpoints).map(describe)
                return ok({
                    subject: principal?.subject ?? null,
                    origin,
                    endpoints: rows,
                    credential: 'None issued. Call again naming an endpoint to get one scoped to it — read-only '
                        + 'unless you pass write: true.',
                    notCovered: [
                        'davfs2 and GUI clients (Finder, Explorer) speak Basic only, so they cannot use a bearer '
                        + 'token at all. No mount line is given for them on purpose.',
                        'Nothing is written to disk. Any config below is yours to place.',
                    ],
                })
            }

            // ── the key ──────────────────────────────────────────────────
            const ep = endpoints[endpoint]
            if (!ep) {
                return fail(`No WebDAV endpoint named ${JSON.stringify(endpoint)}. `
                    + `Configured: ${Object.keys(endpoints).join(', ') || '(none)'}`)
            }
            const minter = runtime.options.auth?.mint
            if (!minter) {
                return fail('No authorization server is configured here, so there is nothing to mint from. '
                    + 'Add mikser-io-auth to the plugins array. Calling without an endpoint still lists what exists.')
            }
            if (!principal?.subject) {
                return fail('Minting requires an authenticated caller — there is no identity here to narrow from.')
            }

            const notes = []
            if (write && ep.readOnly === true) {
                return fail(`${endpoint} is configured readOnly for everyone, so no write token can be minted for it. `
                    + 'Ask for read instead, or change the endpoint configuration.')
            }
            if (write && endpoint === GUARDED_ENDPOINT && !allowContentWrite) {
                return fail(
                    `Write on "${endpoint}" is withheld unless you also pass allowContentWrite: true.\n\n`
                    + 'A PUT here silently loses four things update_entity gives you: the ifChecksum guard against '
                    + 'overwriting someone else\'s edit, the dryRun blast radius, the build report telling you what '
                    + 'your edit invalidated, and the spec-locked advisory on files governed by an external '
                    + 'specification.\n\n'
                    + 'If you are editing the text on a page, use update_entity. If you genuinely need to move FILES '
                    + `in and out of ${ep.folder} — a bulk import, a binary — pass allowContentWrite: true.`)
            }

            const requested = [capabilityOf(endpoint), ...(write ? [writeCapabilityOf(endpoint)] : [])]

            let seconds = Number.isFinite(ttl) ? Math.floor(ttl) : TTL_DEFAULT
            if (seconds > TTL_MAX) {
                notes.push(`ttl clamped from ${seconds}s to the ${TTL_MAX}s maximum. This bounds when you must START `
                    + 'a transfer, not how long it may run, so a long upload is unaffected.')
                seconds = TTL_MAX
            }
            if (seconds < 1) seconds = TTL_DEFAULT

            let minted
            try {
                minted = await minter({
                    subject: principal.subject,
                    capabilities: principal.capabilities,
                    request: requested,
                    ttlSec: seconds,
                    purpose: `webdav:${endpoint}${write ? ' (write)' : ''}`,
                })
            } catch (err) {
                return fail(err.missing?.length
                    ? `Refused: you do not hold ${err.missing.join(', ')}, so it cannot be delegated to a minted `
                      + 'token. Nothing was minted. Call without an endpoint to see what you do hold.'
                    : `Refused: ${err.message}`)
            }

            const url = `${origin}${base}/${endpoint}`
            const P = '$MIKSER_DAV_TOKEN'
            return ok({
                ...describe([endpoint, ep]),
                // The ONE place the secret appears. Everything below references
                // the placeholder, so it is not repeated per command into a
                // transcript that is a log.
                token: minted.token,
                jti: minted.jti,
                scopes: minted.scopes,
                write,
                ttl: minted.ttl,
                expiresAt: minted.expiresAt,
                renewable: false,
                examples: {
                    export: `export ${P.slice(1)}='<the token field above>'`,
                    curlPut: `curl -H "Authorization: Bearer ${P}" -T ./file.bin ${url}/file.bin`,
                    curlList: `curl -H "Authorization: Bearer ${P}" -X PROPFIND -H 'Depth: 1' ${url}/`,
                    rclone: rcloneBlock(`mikser-${endpoint}`, url, P),
                },
                duration: 'The ttl is how long you have to START a transfer. Authorization happens once, at the '
                    + 'beginning of the request, so a transfer already under way runs to completion even after the '
                    + 'token expires. Long uploads are bounded instead by the server request timeout '
                    + '(config.server.requestTimeout — Node defaults to 5 minutes).',
                revoke: 'Killable before it expires by its jti, for a leak. Expiry is the normal mechanism.',
                scopeNote: `Scoped to ${endpoint} alone. It cannot reach any other endpoint, and it carries no `
                    + 'capability you did not already hold.',
                ...(notes.length ? { notes } : {}),
            })
        },
    )

}

