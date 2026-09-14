// Real locks, without sidecar files.
//
// `locks: 'emulate'` kept the content folder clean by not storing locks at
// all: the adapter's readMetadataFile returns `{}` unless locks are
// 'meta-files', so `Lock.save()` writes nowhere and `getLocks()` answers `[]`
// the moment the response is sent. The token in the `Lock-Token` header is the
// only trace the lock ever existed.
//
// That is not a cosmetic gap. The Microsoft WebDAV redirector needs the
// `<activelock>` that RFC 4918 §9.10.1 requires in the LOCK body, and without
// it Windows cannot WRITE to the drive at all — it PUTs an empty file, LOCKs
// it, PROPFINDs it, sees no lock, and loops until it gives up with
// ERROR_INVALID_PARAMETER. Listing and reading work, so the share looks
// mounted and healthy while every save fails with "The parameter is
// incorrect". Captured on the wire against
// Microsoft-WebDAV-MiniRedir/10.0.22631.
//
// So locks are kept in memory instead. The whole lock lifecycle — save,
// delete, getLocks, and the lockdiscovery PROPFIND reads — goes through those
// two methods on the RESOURCE, which makes them the seam: route the `locks`
// half of the metadata through a Map and leave the `props` half exactly as it
// was.
//
// In memory is the right scope here rather than a compromise. One mikser
// instance owns a working folder — the engine enforces it, forwarding any
// second invocation over a unix socket rather than opening the folder twice —
// so there is no other process to share a lock with. What it does mean is that
// locks do not survive a restart, which is the same observable as every lock
// timing out at once, and is why they carry timeouts.

// path -> { token -> entry }, shared by every resource from one adapter.
// Keyed by absolute path because that is what identifies a resource across the
// several Resource objects a single request can produce.
const storeFor = new WeakMap()

function locksFor(adapter) {
    if (!storeFor.has(adapter)) storeFor.set(adapter, new Map())
    return storeFor.get(adapter)
}

// The lock methods themselves, not the metadata underneath them.
//
// Intercepting readMetadataFile looks like the smaller seam and does nothing:
// a Proxy binds methods to the TARGET, so when `getLocks()` runs it is the raw
// resource's `this.readMetadataFile()` that answers, and the interception is
// never reached. The same shape cost an afternoon on `displayname`, where
// PROPFIND reads through the by-user variants and those delegate to the plain
// ones on `this`.
//
// So the three methods that make up the lock lifecycle are replaced outright,
// and the metadata file is left alone.
function withEmulatedLocks(resource, locks) {
    const key = resource.absolutePath
    const held = () => locks.get(key) ?? {}

    // A Lock that saves to the store instead of to a sidecar. Built from the
    // adapter's own, so it is the adapter's Lock class with the adapter's
    // defaults — only the two persistence methods differ.
    const stored = (lock) => new Proxy(lock, {
        get(target, prop, receiver) {
            if (prop === 'save') {
                return async () => {
                    locks.set(key, {
                        ...held(),
                        [target.token]: {
                            username:    target.username,
                            date:        target.date.getTime(),
                            timeout:     target.timeout,
                            scope:       target.scope,
                            depth:       target.depth,
                            provisional: target.provisional,
                            owner:       target.owner,
                        },
                    })
                }
            }
            if (prop === 'delete') {
                return async () => {
                    const rest = { ...held() }
                    delete rest[target.token]
                    if (Object.keys(rest).length) locks.set(key, rest)
                    else locks.delete(key)
                }
            }
            const value = Reflect.get(target, prop, receiver)
            return typeof value === 'function' ? value.bind(target) : value
        },
    })

    const revive = async (token, entry) => {
        const lock = await resource.createLockForUser({ username: entry.username })
        lock.token       = token
        lock.date        = new Date(entry.date)
        lock.timeout     = entry.timeout
        lock.scope       = entry.scope
        lock.depth       = entry.depth
        lock.provisional = entry.provisional
        lock.owner       = entry.owner
        return stored(lock)
    }

    return new Proxy(resource, {
        get(target, prop, receiver) {
            if (prop === 'getLocks') {
                return async () => Promise.all(
                    Object.entries(held()).map(([token, entry]) => revive(token, entry)))
            }
            if (prop === 'getLocksByUser') {
                return async (user) => Promise.all(
                    Object.entries(held())
                        .filter(([, entry]) => entry.username === user?.username)
                        .map(([token, entry]) => revive(token, entry)))
            }
            if (prop === 'createLockForUser') {
                return async (user) => stored(await target.createLockForUser(user))
            }
            const value = Reflect.get(target, prop, receiver)
            return typeof value === 'function' ? value.bind(target) : value
        },
    })
}

/**
 * Give an adapter's resources a lock store that outlives the response.
 *
 * Same shape as withStagedWrites and withDisplayName, and composes with both:
 * each wraps the three methods that hand back a resource and passes the rest
 * through.
 *
 * @param {object} adapter a nephele adapter
 */
export function withEmulatedLockStore(adapter) {
    const locks = locksFor(adapter)
    const wrap = (method) => async (...args) => {
        const resource = await adapter[method](...args)
        return resource ? withEmulatedLocks(resource, locks) : resource
    }
    return new Proxy(adapter, {
        get(target, prop, receiver) {
            if (prop === 'getResource' || prop === 'newResource' || prop === 'newCollection') {
                return wrap(prop)
            }
            const value = Reflect.get(target, prop, receiver)
            return typeof value === 'function' ? value.bind(target) : value
        },
    })
}
