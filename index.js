import path from 'node:path'

import { registerRoute, resolveAuth, reachabilityOf, registerJunk } from 'mikser-io'
import { MikserAuthenticator } from './lib/authenticator.js'
import { registerWebdavMcp } from './lib/mcp.js'
import { withStagedWrites, stageWrites } from './lib/staged-writes.js'

export { MikserAuthenticator, withStagedWrites, stageWrites }

// Nephele's own sidecar files, declared to the engine so neither the scan nor
// the watcher imports them (mikser-io 9.7.0+).
//
// Measured, because the shape is not what it looks like. A collection's meta
// file is `<dir>/.nephelemeta` — dot-prefixed, so it was already invisible
// for the same accidental reason .DS_Store was. A file's is
// `<dir>/page.md.nephelemeta`, which is NOT dot-prefixed and was both scanned
// and watched: setting one dead property on one document produced a second
// entity for the sidecar.
//
// Registered unconditionally rather than only when `meta-files` is selected,
// so an operator who switches later is covered by the switch itself.
registerJunk({ ignore: ['**/*.nephelemeta'], match: /\.nephelemeta$/ })

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
        // Nephele defaults both to 'meta-files', which writes sidecars INTO
        // the folder being served. The sidecars are filtered out of the
        // catalog now (see registerJunk above), so the remaining reason to
        // default to 'emulate' is a plain one: a content folder that people
        // browse and commit should not fill up with page.md.nephelemeta
        // files.
        //
        // The cost is measurable and small: 'emulate' returns a valid
        // Lock-Token header but an EMPTY <lockdiscovery/> body, where
        // 'meta-files' returns the full <activelock>. Clients read the
        // header; one that parses the body for the token would not find it.
        // Choose 'meta-files' if you need real dead properties or real
        // locks, and accept the sidecars.
        //
        // Do NOT choose 'disallow' if macOS clients matter: it drops DAV
        // compliance class 2 from the OPTIONS response, and Finder refuses a
        // read-write mount without it.
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

                const fsAdapter = new FileSystemAdapter({
                    root,
                    properties: ep.properties ?? properties,
                    locks:      ep.locks      ?? locks,
                })

                app.use(mountPath, nepheleServer({
                    // Writes are staged to a sibling temp file and renamed.
                    // The adapter writes straight to the destination with
                    // open(path,'w'), which truncates immediately — so the
                    // watcher can import a half-written file, and an
                    // interrupted overwrite leaves the ORIGINAL destroyed.
                    // Both measured; see lib/staged-writes.js.
                    adapter: (ep.atomicWrites === false)
                        ? fsAdapter
                        : withStagedWrites(fsAdapter, {
                            onFailure: (err, file) => logger.warn(
                                'webdav: upload of %s failed, original left intact — %s',
                                path.basename(file), err.message),
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

            // An agent can already mount this with its bearer token; what it
            // could not do was discover the endpoints and which of them its own
            // capabilities let it write. Registered against the substrate
            // rather than imported by mcp — domain tools live with the domain
            // plugin, and this one knows things only this plugin knows.
            registerWebdavMcp({
                runtime, base, endpoints, logger,
                capabilityOf: readCapability,
                writeCapabilityOf: writeCapability,
            })

            // Node caps a single request at 5 minutes, which bounds how large a
            // file can be uploaded — 1GB needs better than 50 Mbps to fit.
            //
            // This plugin does not own listen(), but the engine exposes the
            // knob: `config.server.requestTimeout` (ms, or 0 to disable). The
            // note used to say the timeout could not be reached from here,
            // which sent an operator hunting for something that does not
            // exist instead of at a line of config.
            const requestTimeout = runtime.config?.server?.requestTimeout
            if (requestTimeout == null) {
                logger.debug(
                    'webdav: uploads are bounded by the server request timeout (node default 5m, so ~1GB at '
                    + '50 Mbps). Raise or disable it with config.server.requestTimeout if large files matter.')
            } else {
                logger.debug('webdav: server request timeout is %s, so uploads are bounded by that',
                    requestTimeout === 0 ? 'disabled' : `${requestTimeout}ms`)
            }
        })
    }
}

export default webdav
