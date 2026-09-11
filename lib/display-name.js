// The mount's own name, served as `displayname` on its root collection.
//
// A WebDAV client shows a folder label. WebDAV has a property for it —
// RFC 4918 §15.2, "a name for the resource suitable for presentation to a
// user" — and @nephele/adapter-file-system does not implement it: the name is
// commented out of its live-property list with a TODO, so a PROPFIND for it
// answers 404 and the client falls back to guessing from the URL.
//
// Guessing from the URL is not controllable. Express matches routes
// case-insensitively, so `/drive/SkinCheck`, `/drive/skincheck` and
// `/drive/SKINCHECK` all reach the same mount, and the casing a client ends up
// displaying is whichever one it happened to ask for first. An endpoint
// renamed to `SkinCheck` went on reading `skincheck` in Explorer.
//
// The name is already written down — it is the ENDPOINTS key, the URL segment
// and the mount log label — so the site can just answer the question instead.
//
// Applied to the root collection only. Every other resource is a real file or
// directory whose name the client reads from the path, and which the author
// did not choose in mikser's config.

// The root of a mount. `Resource.path` is relative to the adapter root with a
// trailing separator stripped, so the mount's own collection is the empty one.
const isMountRoot = (resource) => resource?.path === ''

// A Properties facade that answers one more question than the one it wraps.
//
// PROPFIND reaches properties through the BY-USER variants — listByUser,
// getAllByUser, getByUser — and the adapter's versions delegate to the plain
// ones on `this`. A Proxy binds methods to the TARGET, so wrapping only the
// plain three would leave PROPFIND reading straight past this. Both sets are
// wrapped, which is why the property actually appears.
function withDisplayNameProperty(properties, displayName) {
    const answer = (name, fallback) =>
        name === 'displayname' ? Promise.resolve(displayName) : fallback()
    const including = async (listing) => {
        const names = await listing()
        return names.includes('displayname') ? names : ['displayname', ...names]
    }

    return new Proxy(properties, {
        get(target, prop, receiver) {
            switch (prop) {
                case 'get':         return (name) => answer(name, () => target.get(name))
                case 'getByUser':   return (name, user) => answer(name, () => target.getByUser(name, user))
                case 'list':        return () => including(() => target.list())
                case 'listByUser':  return (user) => including(() => target.listByUser(user))
                case 'listLive':    return () => including(() => target.listLive())
                case 'listLiveByUser': return (user) => including(() => target.listLiveByUser(user))
                case 'getAll':      return async () => ({ ...(await target.getAll()), displayname: displayName })
                case 'getAllByUser': return async (user) => ({ ...(await target.getAllByUser(user)), displayname: displayName })
            }
            const value = Reflect.get(target, prop, receiver)
            return typeof value === 'function' ? value.bind(target) : value
        },
    })
}

function withDisplayNameResource(resource, displayName) {
    return new Proxy(resource, {
        get(target, prop, receiver) {
            if (prop === 'getProperties') {
                return async () => withDisplayNameProperty(await target.getProperties(), displayName)
            }
            const value = Reflect.get(target, prop, receiver)
            return typeof value === 'function' ? value.bind(target) : value
        },
    })
}

/**
 * Decorate an adapter so its root collection reports `displayName`.
 *
 * Same shape as withStagedWrites, and composes with it: both wrap the three
 * methods that hand back a resource, and each passes everything else through.
 *
 * @param {object} adapter      a nephele adapter
 * @param {string} displayName  what a client should call this mount
 */
export function withDisplayName(adapter, displayName) {
    if (!displayName) return adapter
    const wrap = (method) => async (...args) => {
        const resource = await adapter[method](...args)
        return isMountRoot(resource) ? withDisplayNameResource(resource, displayName) : resource
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
