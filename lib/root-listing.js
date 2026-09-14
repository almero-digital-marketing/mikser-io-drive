// The drive's own root: a collection whose children are the endpoints you may
// read.
//
// Only reachable on a dedicated host (`drive({ host: … })`), and that is the
// point of it. The Microsoft WebDAV redirector establishes its session against
// the SERVER ROOT before it touches the path, so a share at `<base>/<name>` on
// a site whose `/` is a static site is one Explorer may never reach — it asks
// `/`, gets a static site's answer, and stops. Given a domain of its own, `/`
// is the drive, and a listing there is what makes several endpoints reachable
// through one mount.
//
// Deliberately NOT Nephele's multi-mount virtual root, for the reasons in this
// plugin's header: no virtual-adapter dependency, and no fake directory tree
// whose names have to be kept in step with the mount keys. The children here
// ARE the mount keys, and entering one lands on that endpoint's own Nephele
// server with its own authenticator — so per-endpoint auth stays exactly where
// it was rather than hanging off a shared root.

import { authorize, hasCapability } from 'mikser-io'

const escape = (text) => String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const collection = (href, displayName) =>
    `  <D:response>\n`
    + `    <D:href>${escape(href)}</D:href>\n`
    + `    <D:propstat>\n`
    + `      <D:prop>\n`
    + `        <D:resourcetype><D:collection/></D:resourcetype>\n`
    + `        <D:displayname>${escape(displayName)}</D:displayname>\n`
    + `      </D:prop>\n`
    + `      <D:status>HTTP/1.1 200 OK</D:status>\n`
    + `    </D:propstat>\n`
    + `  </D:response>`

/**
 * Middleware serving OPTIONS and PROPFIND for the host root.
 *
 * @param {object} input
 * @param {Array}  input.entries   [{ name, displayName, capability }]
 * @param {string} input.rootName  what the root collection calls itself
 * @param {object} input.auth      { verifier, allowRemote, trustLoopback, realm }
 * @param {object} input.logger
 */
export function rootListing({ entries, rootName, auth, logger }) {
    return async (req, res, next) => {
        // Only the root itself. Everything below is a real endpoint mount.
        if (req.path !== '/') return next()

        if (req.method === 'OPTIONS') {
            // Answered WITHOUT authentication, on purpose: this is discovery,
            // and it is what the redirector asks before it has credentials to
            // offer. It discloses that a WebDAV server is here and nothing
            // about what is in it — the listing below is the gated part.
            //
            // Class 1 only. This collection supports reading its own children
            // and nothing else; the endpoints inside it advertise their own
            // classes, including locking.
            res.set('DAV', '1')
            res.set('MS-Author-Via', 'DAV')
            res.set('Allow', 'OPTIONS, PROPFIND')
            // No caching of a discovery answer — the same rule as the mounts,
            // and for the same reason: a client that cached a refusal keeps it.
            res.set('Cache-Control', 'no-cache')
            return res.status(200).end()
        }

        if (req.method !== 'PROPFIND') return next()

        let outcome
        try {
            outcome = await authorize(req, auth.verifier, {
                allowRemote:   auth.allowRemote,
                trustLoopback: auth.trustLoopback,
            })
        } catch (err) {
            logger?.error?.('drive: verifier threw at the root — %s', err.message)
            return res.status(401)
                .set('WWW-Authenticate', `Basic realm="${auth.realm}", charset="UTF-8"`)
                .end()
        }

        if (!outcome.ok) {
            // Basic, because it is the only scheme Explorer and Finder speak,
            // and without the challenge a DAV client never prompts.
            if (outcome.status === 401) {
                return res.status(401)
                    .set('WWW-Authenticate', `Basic realm="${auth.realm}", charset="UTF-8"`)
                    .end()
            }
            return res.status(403).end()
        }

        // What this user may read. A `capability: null` entry is not
        // capability-scoped — no map configured, or a bare static token —
        // which passes, the same rule every other surface applies.
        const visible = entries.filter(entry =>
            !entry.capability || hasCapability(outcome.principal, entry.capability))

        // Depth 0 describes the collection itself; anything else lists the
        // children. Depth: infinity is answered as 1 rather than refused:
        // there is exactly one level here, so they are the same answer.
        const depth = String(req.get('depth') ?? 'infinity')
        const responses = [collection('/', rootName)]
        if (depth !== '0') {
            for (const entry of visible) {
                responses.push(collection(`/${entry.name}/`, entry.displayName))
            }
        }

        logger?.debug?.('drive: root listing for %j — %d of %d endpoint(s)',
            outcome.principal?.subject, visible.length, entries.length)

        res.status(207)
            .set('Content-Type', 'application/xml; charset=utf-8')
            .set('DAV', '1')
            .send(`<?xml version="1.0" encoding="utf-8"?>\n`
                + `<D:multistatus xmlns:D="DAV:">\n${responses.join('\n')}\n</D:multistatus>\n`)
    }
}
