import path from 'node:path'

import { registerRoute, resolveAuth, reachabilityOf, isLoopback } from 'mikser-io'
import { MikserAuthenticator } from './lib/authenticator.js'

export { MikserAuthenticator }

// Capability names are derived from the endpoint name, not configured:
//
//   webdav:<name>          may mount and read it
//   webdav:<name>:write    may also write to it
//
// so an endpoint declares nothing and the grant reads for itself:
//
//   capabilities: { editors: ['webdav:content', 'webdav:content:write'] }
//
// A group that holds the read capability and not the write one gets a
// read-only mount, which is the common case and needs no flag.
export const readCapability  = (name) => `webdav:${name}`
export const writeCapability = (name) => `webdav:${name}:write`

/**
 * WebDAV endpoints over working-folder directories (ADR-0012 for auth).
 *
 *     webdav({
 *         endpoints: {
 *             content: { folder: 'documents' },
 *             media:   { folder: 'files/media' },
 *             data:    { folder: 'data', readOnly: true },
 *         },
 *         auth: identity,
 *     })
 *
 * One Nephele server per endpoint, mounted at `<base>/<name>` — the same
 * shape as api/mcp/forms. Deliberately not Nephele's multi-mount with a
 * virtual root: identical URLs, but no virtual-adapter dependency, no
 * name-sync between a fake directory tree and the mount keys, and per-
 * endpoint auth stays plain instead of hanging off a shared root. What is
 * given up is browsing the endpoint list over DAV, which registerRoute
 * already answers better.
 *
 * `base` is NOT optional to drop: plugin routes match before the static
 * handler (server.js), so an endpoint at `/content` would silently shadow a
 * real page at /content/ in the built site.
 */
export function webdav(options = {}) {
    const {
        base      = '/webdav',
        endpoints = {},
        auth,
        realm     = 'mikser',
        // Nephele defaults both of these to 'meta-files', which writes
        // .nephelemeta sidecars INTO the folder being served. Those folders
        // are mikser sources, so every property a client sets would become a
        // phantom entity — and a rebuild that writes could trip the watcher
        // again. 'emulate' reports success without writing, which is what
        // keeps badly-behaved clients (Finder wants locks) working. Use
        // 'meta-files' only with an ignore rule for **/.nephelemeta.
        properties = 'emulate',
        locks      = 'emulate',
    } = options

    return ({ runtime, onLoaded, useLogger }) => {
        const names = Object.keys(endpoints)
        if (!names.length) return   // nothing configured → nothing mounted

        onLoaded(async () => {
            const logger = useLogger()
            const app = runtime.options.app
            if (!app) {
                throw new Error(
                    'webdav plugin requires runtime.options.app — run mikser with --server, ' +
                    'or pass { app: yourExpressInstance } to setup() before loading the plugin'
                )
            }

            const { default: nepheleServer } = await import('nephele')
            const { default: FileSystemAdapter } = await import('@nephele/adapter-file-system')
            const { default: ReadOnlyPlugin } = await import('@nephele/plugin-read-only')

            const workingFolder = runtime.options.workingFolder
            const resolve = (folder) =>
                path.isAbsolute(folder) ? folder : path.join(workingFolder, folder)

            // Basic auth sends the password in a header, base64 and nothing
            // more. Warn rather than refuse — a deployment behind a
            // TLS-terminating proxy looks like plain http from here, and
            // refusing to boot over a guess is the wrong trade.
            if (auth && runtime.options.url?.startsWith('http://') &&
                !/^http:\/\/(localhost|127\.|\[::1\])/.test(runtime.options.url)) {
                logger.warn(
                    'webdav: %s is plain http and WebDAV clients authenticate with Basic — ' +
                    'credentials travel base64-encoded, not encrypted. Serve over https, or ' +
                    'terminate TLS in front of mikser.', runtime.options.url)
            }

            for (const [name, ep] of Object.entries(endpoints)) {
                if (!ep.folder) {
                    throw new Error(`webdav: endpoint ${JSON.stringify(name)} declares no folder`)
                }
                const root = resolve(ep.folder)
                const mountPath = `${base}/${name}`

                // Same seam and the same one difference as api/mcp/forms: a
                // plain token keeps the trusted-local-host model, a real
                // verifier does not.
                const verifier      = resolveAuth(ep.auth ?? auth ?? ep.token)
                const trustLoopback = !(ep.auth ?? auth) && !!ep.token

                const readOnly = ep.readOnly === true

                const authenticator = new MikserAuthenticator({
                    verifier,
                    trustLoopback,
                    allowRemote: ep.allowRemote,
                    capability:  readCapability(name),
                    // A readOnly endpoint needs no per-user write check —
                    // ReadOnlyPlugin refuses every mutation regardless.
                    writeCapability: readOnly ? null : writeCapability(name),
                    realm,
                    logger,
                })

                app.use(mountPath, nepheleServer({
                    adapter: new FileSystemAdapter({
                        root,
                        properties: ep.properties ?? properties,
                        locks:      ep.locks      ?? locks,
                    }),
                    authenticator,
                    // `readOnly: true` is a hard cap — "nobody writes here",
                    // which is a different statement from "you may not write
                    // here". The per-user version of that question is answered
                    // in the authenticator, because Nephele resolves plugins
                    // BEFORE it authenticates and the hook cannot see the user.
                    plugins: readOnly ? [new ReadOnlyPlugin()] : [],
                }))

                registerRoute({
                    path:         mountPath,
                    plugin:       'webdav',
                    reachability: reachabilityOf({ auth: verifier, allowRemote: ep.allowRemote }),
                    // WebDAV GET/PUT stream file bodies, so a facade must not
                    // buffer this route.
                    streaming:    true,
                    label:        'WebDAV',
                    detail:       `(${ep.folder}${readOnly ? ', read-only' : ''})`,
                    authLabel:    verifier ? (verifier.name ?? 'auth')
                                           : (ep.allowRemote ? 'public, REMOTE OPEN' : 'loopback-only'),
                })
            }

            logger.info('WebDAV mounted at %s (%s)', base, names.join(', '))

            // Node's default request timeout is 5 minutes, which bounds how
            // large a file can be uploaded. The engine owns listen(), so this
            // plugin cannot reach the http.Server to raise it.
            logger.debug(
                'webdav: uploads are bounded by the server request timeout (node default 5m); ' +
                'raise it on the http.Server if large files matter')
        })
    }
}

export default webdav
