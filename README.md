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

- **Sidecar meta-files are off by default**, and safe if you turn them on.
  Nephele defaults `properties` and `locks` to `'meta-files'`, which writes
  sidecars *into the folder being served*. The shape is not what it looks
  like: a collection's is `.nephelemeta` (dot-prefixed, already invisible to
  mikser), but a file's is `page.md.nephelemeta` — **not** dot-prefixed, and
  measurably imported as its own entity. The plugin declares
  `*.nephelemeta` to the engine via `registerJunk`, so either mode is safe.
  `'emulate'` stays the default for a plainer reason: a content folder people
  browse and commit should not fill up with sidecars.

- **Writes are staged and renamed.** The adapter opens the destination with
  `'w'` and streams into it, which was measured to expose a growing partial
  file *and* destroy the previous contents on an interrupted upload. Writes go
  to a sibling `.part` file and `rename(2)` on success. `atomicWrites: false`
  restores the adapter's behaviour.

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
- **File-manager litter is filtered by the engine**, from mikser-io 9.6.0.
  This was measured, and the earlier claim here was wrong in an instructive
  way: the macOS files (`.DS_Store`, `._*`) were already invisible, because
  globby defaults to `dot: false` and the watcher ignores leading dots. The
  **Windows** ones are not dotfiles — `Thumbs.db` and `desktop.ini` were both
  scanned *and* watched, and became entities. Core now filters a conservative
  OS/file-manager list on both paths; `junk: false` in config turns it off.
- **Upload size is bounded by the request timeout.** Node caps a request at 5
  minutes, which for uploads is a size limit expressed in seconds. Raise it
  with `server.requestTimeout` in `mikser.config.js` (mikser-io 9.5.0+).

## Client compliance, measured

Tested against [`webdav`](https://github.com/perry-mitchell/webdav-client), a
third-party client that builds its own PROPFIND bodies and parses its own
multistatus responses — so it disagrees where the implementation is wrong
rather than where the tests are.

Three protocol facts worth knowing, all asserted in `test/protocol.test.js`:

| | |
| --- | --- |
| default (`emulate`) | `DAV: 1, 3, 2` — **class 2**, which macOS requires for a read-write mount |
| `locks: 'disallow'` | drops class 2 and `LOCK` from `Allow`. **Finder will refuse a read-write mount.** A trap, because it is invisible until someone tries |
| `emulate` vs `meta-files` | both return a valid `Lock-Token` header; `emulate` returns an empty `<lockdiscovery/>` where `meta-files` returns the full `<activelock>` |

The last is the real cost of the default: clients read the header, so this is
survivable, but a client that parses the body for the token finds nothing.
Choose `meta-files` if you need real dead properties or real locking — with
persisted locks a second `LOCK` on a held resource correctly answers `423`.

One more, because it surprises people: **`LOCK` on a path that does not exist
creates an empty file** (RFC 4918 §9.10.4). A client that locks before writing
— Finder's Save As does — leaves an empty document behind even if the write
never arrives.

## litmus compliance

Scored with [litmus](https://github.com/tolsen/litmus) 0.13, the WebDAV
compliance suite from the neon project. Two endpoints, because the shipped
default deliberately does not store what it is asked to store:

| suite | `emulate` (default) | `meta-files` |
| --- | --- | --- |
| basic | **16/16** | **16/16** |
| copymove | 11/13 | 11/13 |
| props | 20/30 | **27/30** |
| locks | 9/13 | **37/41** |
| http | **4/4** | **4/4** |

The `emulate` column is the trade working as intended: it reports success for
dead properties and locks without storing them, so litmus reads them back and
finds nothing. Choose `meta-files` if compliance matters more than a clean
content folder.

The `meta-files` column is the fair measure of the dependency, and it has four
real gaps — all upstream in nephele, all pinned in `test/protocol.test.js` so
an upgrade that fixes them fails loudly rather than changing behaviour quietly:

- **`COPY`/`MOVE` with `Overwrite: F` returns `207`, not `412`** (RFC 4918
  §9.8.5). The safe half holds — the destination is *not* clobbered — but the
  client is told the operation succeeded. Measured with a real client:
  `copyFile(src, dst, { overwrite: false })` **resolves**, and the destination
  is unchanged. Scripts that copy-if-absent and then read the destination
  expecting the source's content will be wrong.
- **A malformed PROPFIND body answers `500`, not `400`.**
- **`propget` loses a dead property in a foreign namespace.**
- **`UNLOCK` accepts a bogus lock token**, so one client can release another's
  lock. DAV locks are advisory here anyway — mikser's renderer does not honour
  them — but it means locking is not a concurrency control you can lean on.

Two warnings litmus raises that are worth knowing rather than fixing: `DELETE`
with a fragment in the Request-URI removes the collection, and `COPY` into a
non-existent collection answers `404` where `409` is specified.

## Why writes are staged

Measured, not assumed. `@nephele/adapter-file-system` writes like this:

```js
const handle = await fsp.open(this.absolutePath, 'w')   // truncates NOW
input.pipe(handle.createWriteStream())
```

Against a 512KB upload delivered in eight slow chunks:

| | adapter as-is | staged |
| --- | --- | --- |
| sizes seen at the destination mid-upload | `65536, 131072, … 524288` | never exists |
| a 1600-byte file whose overwrite is interrupted | **196608 bytes of the new content** | 1600 bytes, unchanged |

The first matters because these folders are mikser sources — the watcher can
import a half-written file and render a truncated page. The second is data
loss: not the old file, not an error, a corrupted file and no indication.

Staging to a sibling `.part` file and renaming fixes both, because `rename(2)`
within a directory is atomic — the file appears complete or not at all, and a
failed upload never opens the original. A sibling rather than the OS temp
directory, because rename is only atomic within one filesystem and `/tmp` is
usually a different mount.

Both rows above are asserted in `test/atomic-writes.test.js`.

## Why Nephele, and not the alternative

The Node WebDAV server field is two live projects. Both were scored with the
same litmus suites, each on a fresh server:

| suite | Nephele `1.0.0-alpha.67` | webdav-server `2.6.3` |
| --- | --- | --- |
| basic | **16/16** | 15/16 |
| copymove | 11/13 | **12/13** |
| props | **27/30** | 7/30 |
| locks | **37/41** | 11/24 *(aborted)* |
| http | 4/4 | 4/4 |

`webdav-server` has more stars (282 vs 108), is Express-mountable, and has a
path-based privilege manager that would map neatly onto per-folder access. It
also woke up on 2026-08-04 after six and a half years of silence — dropping
v1, adding unit tests — so it is reviving rather than dead. And it gets the
`Overwrite: F` case right, which is Nephele's most client-visible gap.

But 7/30 on properties and a `locks` run that aborts partway is a different
class of problem from Nephele's four known gaps, and it carries 65 open issues
against Nephele's zero. Nephele is also Apache-2.0 and load-bearing for its
author's own product, which is the maintenance signal that matters most.

Staying on Nephele. If its gaps ever become the binding constraint, the
serious alternative is not another npm package — it is **Apache `mod_dav`**,
the implementation litmus was written to test, which reads `htpasswd` and
`htgroup` natively with `AuthUserFile` / `AuthGroupFile` / `Require group`.
That would cost the Express integration, the capability model, per-request
read-only, atomic staged writes and the route inventory — a separate process
serving the same folder, with its own idea of who may do what. Worth it only
if strict compliance outranks all of that.

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

## File access for an agent

One tool, `mikser_webdav_access`, and the argument decides what you get.

**No endpoint** — the map. Every endpoint, the folder behind it, and whether
your own capabilities let you write there. No credential, because there is
nothing to scope one to yet.

**An endpoint** — the same answer for it, plus a credential minted for that
endpoint alone:

- **read-only unless `write: true`**
- **300s by default, 900s maximum** — and that is how long you have to *start*
  a transfer, not how long it may run. Authorization happens once, when the
  request begins, so an upload that takes an hour completes fine on a token
  that expired in its first minute. Long transfers are bounded instead by
  `config.server.requestTimeout`.
- **never wider than you.** Scopes are the intersection with what you already
  hold; asking for more is refused with the missing scope named, and nothing
  is minted.
- **revokable** by `jti` before it expires, for a leak.
- the token appears **exactly once**; the examples reference
  `$MIKSER_DAV_TOKEN`.

Nothing transfers through the tool. It hands over a door and the bytes move
over HTTP, so a gigabyte costs the same few tokens as a thumbnail.

Write on the `content` endpoint needs `allowContentWrite: true` as well. A raw
PUT into `documents/` loses four things `mikser_update_entity` gives you — the
`ifChecksum` guard, the `dryRun` blast radius, the build report, and the
spec-locked advisory — so the second flag makes that a decision rather than an
accident.
