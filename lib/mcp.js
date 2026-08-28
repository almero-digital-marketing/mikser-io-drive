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
    const readCapability = capabilityOf
    const writeCapability = writeCapabilityOf
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
                        + 'It is not included here on purpose: this response goes into your transcript.\n\n'
                        + 'For a credential you can paste somewhere, use mikser_dav_token — it mints one scoped to '
                        + 'a single endpoint, read-only by default, expiring in minutes, and revokable. Prefer that '
                        + 'over reusing your session token, which carries every endpoint for about an hour.',
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


    // A credential narrower than the caller's own, for one transfer.
    //
    // The decision this implements: an agent may receive a DAV credential in
    // MCP output. So the job is not to withhold the capability — it is to make
    // what the agent receives as small and as short-lived as the task allows.
    //
    // Never the caller's session bearer. That one carries read AND write on
    // every endpoint for about an hour, and a transcript is a log: assume
    // anything returned here is readable later. An hour of write on layouts,
    // styles and scripts is a site rewrite. Ten minutes of write on media is a
    // nuisance. So this mints, and mints small.
    mcp.registerTool(
        'mikser_dav_token',
        {
            description:
                'Mint a SHORT-LIVED WebDAV credential scoped to ONE endpoint, for one transfer. Use it when '
                + 'moving files — a media upload, a bulk sync — where an MCP tool is the wrong shape.\n\n'
                + 'Read-only unless you pass write: true. Scoped to the endpoint you name and no other. Default '
                + `${TTL_DEFAULT}s, hard maximum ${TTL_MAX}s — that is how long you have to START a transfer, not how `
                + 'long it may run. Authorization happens once, when the request begins, so an upload that takes an '
                + 'hour completes fine on a token that expired in its first minute. Measured, not assumed. Not '
                + 'renewable and not refreshable: expiry IS how this is revoked, so mint another rather than asking '
                + 'for a longer window.\n\n'
                + 'The scopes are the intersection of what you ask for and what you already hold — this can never '
                + 'widen your reach, only narrow it. Asking for more than you hold is refused, naming the scope.\n\n'
                + 'The token appears exactly ONCE in the response. `examples` reference $MIKSER_DAV_TOKEN; export '
                + 'it and use the variable, so the secret is not repeated into your transcript for every command.',
            inputSchema: {
                endpoint: { type: 'string', required: true,
                    description: 'Endpoint name, as reported by mikser_webdav_config.' },
                write: { type: 'boolean',
                    description: 'Ask for write as well as read. Default false.' },
                ttl: { type: 'number',
                    description: `Seconds you have to START a transfer. Default ${TTL_DEFAULT}, clamped to ${TTL_MAX}; the response says when it was clamped. A transfer already under way is not interrupted when this expires.` },
                allowContentWrite: { type: 'boolean',
                    description: 'Required IN ADDITION to write:true to get write on the documents endpoint. Editing page text belongs on update_entity; see the refusal for why.' },
            },
        },
        async ({ endpoint, write = false, ttl, allowContentWrite = false } = {}) => {
            const principal = mcp.principal?.() ?? null
            const minter = runtime.options.auth?.mint
            if (!minter) {
                return fail('No authorization server is configured here, so there is nothing to mint from. '
                    + 'Add mikser-io-auth to the plugins array.')
            }
            if (!principal?.subject) {
                return fail('Minting requires an authenticated caller — there is no identity here to narrow from.')
            }
            const ep = endpoint && endpoints[endpoint]
            if (!ep) {
                return fail(`No WebDAV endpoint named ${JSON.stringify(endpoint)}. `
                    + `Configured: ${Object.keys(endpoints).join(', ') || '(none)'}`)
            }

            const notes = []
            let wantWrite = write === true

            // A readOnly endpoint cannot grant write to anyone, so saying so
            // here is better than minting a token that 403s on first PUT.
            if (wantWrite && ep.readOnly === true) {
                return fail(`${endpoint} is configured readOnly for everyone, so no write token can be minted for it. `
                    + 'Mint a read token, or change the endpoint configuration.')
            }

            // documents/ is guarded twice on purpose.
            if (wantWrite && endpoint === GUARDED_ENDPOINT && !allowContentWrite) {
                return fail(
                    `Write on "${endpoint}" is withheld unless you also pass allowContentWrite: true.\n\n`
                    + 'A PUT here silently loses four things update_entity gives you: the ifChecksum guard against '
                    + 'overwriting someone else\'s edit, the dryRun blast radius, the build report telling you what '
                    + 'your edit invalidated, and the spec-locked advisory on files governed by an external '
                    + 'specification.\n\n'
                    + 'If you are editing the text on a page, use update_entity. If you genuinely need to move FILES '
                    + `in and out of ${ep.folder} — a bulk import, a binary — pass allowContentWrite: true and this `
                    + 'will mint.')
            }

            const requested = [readCapability(endpoint), ...(wantWrite ? [writeCapability(endpoint)] : [])]

            // Clamped, and said out loud. A caller that asked for an hour and
            // silently got five minutes would plan a transfer around a number
            // that was never true.
            let seconds = Number.isFinite(ttl) ? Math.floor(ttl) : TTL_DEFAULT
            if (seconds > TTL_MAX) {
                notes.push(`ttl clamped from ${seconds}s to the ${TTL_MAX}s maximum — expiry is how this token is `
                    + 'revoked, so it is deliberately short. Mint again if a transfer outlives it.')
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
                    purpose: `webdav:${endpoint}${wantWrite ? ' (write)' : ''}`,
                })
            } catch (err) {
                // Naming the missing scope is the useful half: the caller can
                // ask an operator for exactly that, rather than for "access".
                return fail(err.missing?.length
                    ? `Refused: you do not hold ${err.missing.join(', ')}, so it cannot be delegated to a minted `
                      + 'token. Nothing was minted. mikser_webdav_config reports what you do hold.'
                    : `Refused: ${err.message}`)
            }

            const origin = runtime.options.url ?? `http://localhost:${runtime.options.port ?? ''}`
            const url = `${origin}${base}/${endpoint}`
            const P = '$MIKSER_DAV_TOKEN'

            return ok({
                // The ONE place the secret appears.
                token: minted.token,
                jti: minted.jti,
                url,
                endpoint,
                folder: ep.folder,
                scopes: minted.scopes,
                write: wantWrite,
                ttl: minted.ttl,
                expiresAt: minted.expiresAt,
                renewable: false,
                // Counter-intuitive enough to be worth stating in the response
                // and not only in the description: a caller sizing a 1GB
                // upload against a 900s window would otherwise conclude, wrongly,
                // that it cannot be done.
                duration: 'This is how long you have to START a transfer. Authorization happens once, at the '
                    + 'beginning of the request, so a transfer already under way runs to completion even after the '
                    + 'token expires. Long uploads are instead bounded by the server request timeout '
                    + '(config.server.requestTimeout — Node defaults to 5 minutes).',
                examples: {
                    export: `export ${P.slice(1)}='<the token field above>'`,
                    curlPut: `curl -H "Authorization: Bearer ${P}" -T ./file.png ${url}/file.png`,
                    curlList: `curl -H "Authorization: Bearer ${P}" -X PROPFIND -H 'Depth: 1' ${url}/`,
                    rclone: rcloneBlock(`mikser-${endpoint}`, url, P),
                },
                revoke: 'This token can be killed before it expires — an operator revokes it by its jti. Expiry is '
                    + 'the normal mechanism; revocation is for a leak.',
                ...(notes.length ? { notes } : {}),
                scopeNote: `Scoped to ${endpoint} alone. It cannot reach any other endpoint, and it carries no `
                    + 'capability you did not already hold.',
            })
        },
    )

    logger?.debug?.('webdav_config tool registered (%d endpoint(s))', Object.keys(endpoints).length)
}

