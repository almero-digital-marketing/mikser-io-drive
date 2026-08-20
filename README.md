# mikser-io-webdav

> WebDAV over the working folder, authenticated through
> [`mikser-io-auth`](https://github.com/almero-digital-marketing/mikser-io-auth).
> Edit content from Finder, Explorer or any DAV client; the build picks the
> change up.

## What it is

A [Nephele](https://github.com/sciactive/nephele) WebDAV server per endpoint,
mounted on mikser's Express app, serving directories from the working folder.
Because those directories are mikser *sources*, a `PUT` is a content change —
the watcher sees it and the site rebuilds. That is the whole point, and also
where the sharp edges are (see **Working-folder hazards**).

**Design choices, and why:**

- **One server per endpoint, at `<base>/<name>`.** The same shape as
  `api`/`mcp`/`forms`. Nephele can multi-mount several adapters under one
  server with a virtual root, and the URLs come out identical — but that
  needs `@nephele/adapter-virtual`, keeps a fake directory tree in sync with
  the mount keys, and puts per-endpoint auth behind a shared root. What is
  given up is browsing the endpoint list over DAV, which `registerRoute`
  already answers better.

- **`base` is not optional.** Plugin routes match before mikser's static
  handler, so an endpoint at `/content` would silently shadow a real
  `/content/` page in the built site.

- **Capabilities are derived from the endpoint name**, not configured.
  `webdav:<name>` to mount and read it, `webdav:<name>:write` to write. A
  group holding the first and not the second gets a read-only mount with no
  flag involved.

- **Sidecar meta-files are off by default.** Nephele defaults `properties`
  and `locks` to `'meta-files'`, which writes `.nephelemeta` *into the folder
  being served* — a mikser source, so every property a client set would
  become a phantom entity. `'emulate'` reports success without writing, which
  is also what keeps badly-behaved clients working (Finder wants locks).

- **Basic auth only, so HTTPS.** WebDAV clients speak Basic or Digest, and
  Digest needs the plaintext password — impossible against bcrypt hashes. The
  plugin warns when the configured URL is plain `http` and not loopback.

## Use

```js
import { webdav } from 'mikser-io-webdav'
import { auth }   from 'mikser-io-auth'

const identity = auth({
    capabilities: {
        editors:   ['webdav:content', 'webdav:content:write'],
        reviewers: ['webdav:content'],          // read-only, by grant
    },
})

export default async () => ({
    plugins: [
        identity,
        webdav({
            endpoints: {
                content: { folder: 'documents' },
                media:   { folder: 'files/media' },
                data:    { folder: 'data', readOnly: true },
            },
            auth: identity,
        }),
    ],
})
```

Mount `https://cms.example.com/webdav/content` in your file manager.

With no `capabilities` map at all, an authenticated user is unscoped and every
endpoint is fully writable — the ADR-0012 default, the same as a static token.
Capabilities only start refusing things once you have said what they mean.

### Endpoint options

| | |
| --- | --- |
| `folder` | required; relative to the working folder, or absolute |
| `readOnly` | hard cap — nobody writes here, whatever they hold |
| `auth` / `token` | per-endpoint override of the plugin-level `auth` |
| `allowRemote` | reachable without a credential (see the engine's rule) |
| `properties` / `locks` | `'emulate'` (default), `'disallow'`, `'meta-files'` |

`readOnly: true` and "you lack `webdav:<name>:write`" are different
statements. The first is about the folder — a directory a build step owns, say
— and the second is about the person.

## Working-folder hazards

These are properties of exposing live sources over a network filesystem, not
bugs, but they will bite if nobody said them out loud.

- **Expose sources, never the output folder.** DAV locks are advisory and
  mikser does not honour them, so a locked file the renderer rewrites makes
  the lock a lie.
- **Partial uploads are visible.** Nephele writes to the target path, so the
  watcher can see a half-written large file. Test a big `PUT` against your own
  watch settings before trusting it.
- **File managers leave litter.** macOS creates `.DS_Store` and `._*`
  resource forks in any folder it browses; each becomes an entity unless
  ignored.
- **Upload size is bounded by the request timeout.** Node defaults to 5
  minutes. The engine owns `listen()`, so this plugin cannot raise it.

## Nephele is pre-1.0

`nephele@1.0.0-alpha.67`. It implements RFC 4918 fully, but the version is
what it says, so the dependency is pinned exactly. This is precisely the
cadence argument in mikser's ADR-0006 for shipping as a plugin rather than in
the engine.

One thing worth knowing if you extend this: Nephele's conditional-plugins hook
**cannot see the authenticated user.** `createServer` mounts `loadPlugins`
before `authenticate`, so `response.locals.user` is always `undefined` there —
including in the README example that tests it. Per-user decisions have to
happen in the authenticator, which is where the write gate lives.
