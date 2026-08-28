import path from 'node:path'

import { registerRoute, resolveAuth, reachabilityOf, registerJunk } from 'mikser-io'
import { MikserAuthenticator } from './lib/authenticator.js'
import { registerFileTools } from './lib/files.js'
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
//   drive:<name>          may mount and read it
//   drive:<name>:write    may also write to it
//
// so an endpoint declares nothing and the grant reads for itself:
//
//   capabilities: { editors: ['drive:content', 'drive:content:write'] }
//
// A group that holds the read capability and not the write one gets a
// read-only mount, which is the common case and needs no flag.
export const readCapability  = (name) => `drive:${name}`
export const writeCapability = (name) => `drive:${name}:write`

/**
 * WebDAV endpoints over working-folder directories (ADR-0012 for auth).
 *
 *     drive({
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
export function drive(options = {}) {
    const {
        base      = '/drive',
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
                    'drive plugin requires runtime.options.app — run mikser with --server, ' +
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
                    'drive: %s is plain http and WebDAV clients authenticate with Basic — ' +
                    'credentials travel base64-encoded, not encrypted. Serve over https, or ' +
                    'terminate TLS in front of mikser.', runtime.options.url)
            }

            for (const [name, ep] of Object.entries(endpoints)) {
                if (!ep.folder) {
                    throw new Error(`drive: endpoint ${JSON.stringify(name)} declares no folder`)
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
                                'drive: upload of %s failed, original left intact — %s',
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
                    plugin:       'drive',
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

            // File operations over MCP, for an agent with no route to the
            // host — a sandbox with no egress, a desktop client with no shell.
            // Bytes ride the MCP connection that already works.
            registerFileTools({
                runtime, endpoints, logger,
                capabilityOf: readCapability,
                writeCapabilityOf: writeCapability,
            })

            // Uploads are bounded by the server request timeout. The engine
            // raises it automatically because this registers streaming routes
            // (see registerRoute above) — Node's 5-minute default is an upload
            // size limit expressed in seconds, and a large file over a slow
            // link is indistinguishable from a stalled request.
            const configured = runtime.config?.server?.requestTimeout
            logger.debug('drive: uploads bounded by the server request timeout — %s',
                configured == null
                    ? 'raised automatically for these streaming routes; override with config.server.requestTimeout'
                    : configured === 0 ? 'disabled by config.server.requestTimeout'
                    : `${configured}ms from config.server.requestTimeout`)
        })
    }
}

export default drive
