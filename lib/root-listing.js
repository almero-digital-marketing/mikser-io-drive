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

import { authorize, hasCapability, basicChallenge } from 'mikser-io'

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
 * @param {boolean} [input.anonymousDiscovery]  answer OPTIONS without auth
 */
// The OPTIONS answer itself.
//
// `DAV: 1, 2, 3` — the same classes the endpoints advertise, and this is a
// deliberate compatibility choice against a literal reading of the spec, so
// it is worth being plain about.
//
// RFC 4918 §18 defines the classes per RESOURCE, not per server, so a root
// advertising less than its endpoints is not in itself incoherent. But §18.2
// is explicit that a class 2 resource MUST support LOCK, and this collection
// does not: its `Allow` below says OPTIONS and PROPFIND and means it. §18.3
// even spells out the honest header for exactly this resource — `DAV: 1, 3`,
// "all the requirements in this specification except possibly those that
// involve locking support".
//
// It advertises 2 anyway, because the clients this package exists to serve
// read capability at the ROOT and decide the whole mount from it: Finder
// refuses a read-write mount without class 2 (the same reason `locks:
// 'disallow'` carries a warning in index.js), and the redirector was
// observed treating the tree as the root described it. Understating here
// costs a working mount; overstating costs a 405 to a LOCK nothing sends,
// because clients lock the files they edit and those live under the
// endpoints, which support it for real.
//
// `Allow` stays truthful, so a client that asks what this resource permits
// gets the right answer.
function respondOptions(res) {
    res.set('DAV', '1, 2, 3')
    res.set('MS-Author-Via', 'DAV')
    res.set('Allow', 'OPTIONS, PROPFIND')
    // No caching of a discovery answer — the same rule as the mounts, and for
    // the same reason: a client that cached a refusal keeps it.
    res.set('Cache-Control', 'no-cache')
    return res.status(200).end()
}

export function rootListing({ entries, rootName, auth, logger, anonymousDiscovery = false }) {
    return async (req, res, next) => {
        // Only the root itself. Everything below is a real endpoint mount.
        if (req.path !== '/') return next()

        if (req.method !== 'OPTIONS' && req.method !== 'PROPFIND') return next()

        // Both methods authenticate, and OPTIONS doing so is the fix for a
        // Windows credential lifecycle, not a tightening for its own sake.
        //
        // The redirector establishes its session against the SERVER ROOT
        // before it touches the path — the reason this root exists at all.
        // Answering that OPTIONS with an anonymous 200 told it the session
        // needed nothing, so credentials were attached later and reactively,
        // when the PROPFIND 401'd. That attachment did not survive the
        // session: after a reboot, or after WebClient's idle teardown, the
        // redirector asked again, got the same clean 200, concluded the same
        // thing, and at the PROPFIND prompted a human instead of replaying
        // Credential Manager. Measured on a live Windows 11 client: the
        // credential was in cmdkey the whole time and never sent.
        //
        // Apache mod_dav with the DAV location inside `Require valid-user`
        // 401s on OPTIONS, and reconnects there are silent. That comparison
        // is what identified this.
        //
        // The disclosure argument the old comment made does not survive
        // contact: an anonymous 200 says "a WebDAV server is here", and a 401
        // says the same thing plus a realm. Neither says anything about the
        // contents, so nothing was being protected — while the cost was a
        // password prompt after every reboot.
        //
        // RFC 4918 does not forbid it. §8.1 points the other way if anything:
        // "Servers MUST return authorization errors in preference to other
        // errors." And no CORS preflight is at stake, which is the one case
        // where challenging OPTIONS would be wrong — the drive's routes are
        // registered `cors: false`.
        //
        // `anonymousDiscovery: true` restores the old behaviour for a
        // deployment that wants an unauthenticated probe at the root.
        if (req.method === 'OPTIONS' && anonymousDiscovery) return respondOptions(res)

        let outcome
        try {
            outcome = await authorize(req, auth.verifier, {
                allowRemote:   auth.allowRemote,
                trustLoopback: auth.trustLoopback,
            })
        } catch (err) {
            logger?.error?.('drive: verifier threw at the root — %s', err.message)
            return res.status(401)
                .set('WWW-Authenticate', basicChallenge({ realm: auth.realm, charset: auth.charset }))
                .end()
        }

        if (!outcome.ok) {
            // Basic, because it is the only scheme Explorer and Finder speak,
            // and without the challenge a DAV client never prompts.
            if (outcome.status === 401) {
                return res.status(401)
                    .set('WWW-Authenticate', basicChallenge({ realm: auth.realm, charset: auth.charset }))
                    .end()
            }
            // Authenticated and not permitted. NEVER 401 here: a client that
            // is told to authenticate again by credentials that already
            // worked prompts forever.
            return res.status(403).end()
        }

        if (req.method === 'OPTIONS') return respondOptions(res)

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
            .set('DAV', '1, 2, 3')
            .send(`<?xml version="1.0" encoding="utf-8"?>\n`
                + `<D:multistatus xmlns:D="DAV:">\n${responses.join('\n')}\n</D:multistatus>\n`)
    }
}
