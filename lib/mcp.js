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

const rcloneBlock = (remote, url) =>
    `[${remote}]\ntype = webdav\nurl = ${url}\nvendor = other\nbearer_token = $MIKSER_TOKEN\n`

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

    mcp.registerTool(
        // Prefixed like every other tool this substrate registers; the mirror
        // into the engine's registry strips it back to `webdav_config`.
        'mikser_webdav_config',
        {
            description: 'Ready-to-use WebDAV client configuration for THIS caller: every endpoint, the folder behind it, '
                + 'whether your own capabilities allow you to write there, and the rclone and curl invocations to use it.\n\n'
                + 'Reach for this when the job is moving files rather than editing content — a large media upload, a bulk '
                + 'sync, a directory listing. For changing the text on a page, update_entity is the better tool: it is '
                + 'checksum-guarded, reports what the edit would invalidate, and needs no second client.\n\n'
                + 'Authenticate with the SAME bearer token you are using now; the config carries a $MIKSER_TOKEN placeholder '
                + 'rather than the credential itself. Nothing is written to disk.',
            inputSchema: {
                endpoint: { type: 'string',
                    description: 'Limit the answer to one endpoint by name. Omit for all of them.' },
            },
        },
        async ({ endpoint } = {}) => {
            // Null on the CLI and on a loopback call — there is no caller to
            // be. accessFor degrades to 'unknown' rather than guessing.
            const principal = mcp.principal?.() ?? null
            const origin = runtime.options.url ?? `http://localhost:${runtime.options.port ?? ''}`

            const wanted = Object.entries(endpoints)
                .filter(([name]) => !endpoint || name === endpoint)
            if (endpoint && !wanted.length) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: `No WebDAV endpoint named ${JSON.stringify(endpoint)}. `
                        + `Configured: ${Object.keys(endpoints).join(', ') || '(none)'}` }],
                }
            }

            const rows = wanted.map(([name, ep]) => {
                const url = `${origin}${base}/${name}`
                return {
                    name,
                    url,
                    folder: ep.folder,
                    ...accessFor(principal, {
                        name,
                        readOnly: ep.readOnly === true,
                        capability: capabilityOf(name),
                        writeCapability: writeCapabilityOf(name),
                    }),
                    rclone: rcloneBlock(`mikser-${name}`, url),
                }
            })

            const usable = rows.filter(row => row.access !== 'none')
            const first = usable[0] ?? rows[0]

            return {
                content: [{ type: 'text', text: JSON.stringify({
                    subject: principal?.subject ?? null,
                    origin,
                    endpoints: rows,
                    // One block a caller can paste whole, rather than
                    // reassembling it from the per-endpoint fields.
                    rcloneConfig: usable.map(row => row.rclone).join('\n'),
                    curl: first
                        ? `curl -H "Authorization: Bearer $MIKSER_TOKEN" -X PROPFIND -H 'Depth: 1' ${first.url}/`
                        : null,
                    token: 'Substitute $MIKSER_TOKEN with the bearer token you are authenticating with now. '
                        + 'It is not included here on purpose: this response goes into your transcript.',
                    ...(principal?.expiresAt ? {
                        expiresAt: principal.expiresAt,
                        secondsRemaining: principal.secondsRemaining,
                        // The reported failure wearing different clothes: a
                        // long upload outliving the token it started with.
                        expiry: 'That token expires, so a long transfer can outlive it. The authorization server '
                            + 'grants offline_access with every refresh token — renew and re-run the transfer '
                            + 'rather than starting one that cannot finish inside the window.',
                    } : {}),
                    notCovered: [
                        'davfs2 and GUI clients (Finder, Explorer) speak Basic only, so they cannot use a bearer '
                        + 'token at all — they would need a password, which is what using Bearer avoids. No mount '
                        + 'line is given for them on purpose.',
                        'Nothing here is written to disk. The rclone config is yours to place.',
                    ],
                }, null, 2) }],
            }
        },
    )

    logger?.debug?.('webdav_config tool registered (%d endpoint(s))', Object.keys(endpoints).length)
}

