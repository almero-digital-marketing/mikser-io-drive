# mikser-io-drive

> Your content folders, as a drive. Mount them and edit; the site rebuilds.
> Or let an agent put files there without giving it a route to your server.

## What you get

**Edit content the way you already work.** Mount an endpoint in Finder or
Explorer and the folder is just a folder — drag a photograph in, rename a
directory, open a document in whatever app you like. Every change is a content
change: the watcher sees it and the site rebuilds. No upload form, no admin UI
to learn, no second copy of your content to keep in step.

**Give an agent file access that costs almost nothing.** Four MCP tools carry
bytes over the connection an agent already has, so it works from a sandbox with
no network route to your host and from a desktop client with no shell. Ten
photographs land in one call and one rebuild, each coming back with the string
to paste into a page.

**Deletes and moves that know what they would break.** Removing a file that
three documents still point at is refused, and it names all three — entity and
field, including the one buried at `cta.cycle[6]`. Moving one can repoint them
for you. The alternative is a green build and three broken images nobody sees
until a customer does.

**Nothing disappears quietly.** An existing file is refused rather than
overwritten unless you say so. A delete moves to trash rather than unlinking, so
a wrong one is a move back. A batch that has one bad file in it writes none of
them, so you are never left guessing what landed.

**Everyone sees only their own folders.** Access is per endpoint and per
person: a reviewer reads `content` and cannot write it; an editor writes
`content` and cannot touch `layouts`. The same grants apply whether someone is
in Finder, a script, or an agent.

## Set it up

```js
import { drive } from 'mikser-io-drive'
import { auth }  from 'mikser-io-auth'

const identity = auth({
    capabilities: {
        editors:   ['drive:content', 'drive:content:write'],
        reviewers: ['drive:content'],          // read-only, by grant
    },
})

export default async () => ({
    plugins: [
        identity,
        drive({
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

Then **Finder → Go → Connect to Server →** `https://cms.example.com/drive/content`,
or point rclone or any DAV client at the same URL. Capabilities are derived from
the endpoint name — `drive:<name>` to read it, `drive:<name>:write` to write —
so the endpoint list above is the only place a folder is named.

## For an agent

```
mikser_drive_add({ endpoint, files: [{ name, base64, mime }], folder?, overwrite?, dryRun? })
mikser_drive_read({ path })
mikser_drive_move({ from, to, rewriteRefs?, dryRun? })
mikser_drive_delete({ path, force?, dryRun? })
```

`add` takes a whole batch so one build cycle picks it up, and returns for each
file the reference to paste into a document plus any derived variants a preset
produced. `read` gives back an image an agent can actually look at. `move` and
`delete` refuse while something still references the file.

Bytes cost roughly 1.4 tokens each, so a page of photographs is cheap and a
video is not: per file 2MB, per batch 8MB, above which they refuse and point at
a mount, where the same folders are reachable and the bytes cost nothing.

Page *text* stays on `mikser_update_entity` — it is checksum-guarded, previews
what an edit would invalidate, and returns the build report. These tools never
write documents.

## How it works

A [Nephele](https://github.com/sciactive/nephele) WebDAV server per endpoint,
mounted on mikser's Express app, serving directories from the working folder.
Because those directories are mikser *sources*, a `PUT` is a content change —
which is the whole point, and also where the sharp edges are.

One server per endpoint at `<base>/<name>`, the same shape as `api`/`mcp`/
`forms`. Nephele can multi-mount several adapters under one server with a
virtual root and the URLs come out identical, but a per-endpoint server keeps
each mount's auth, capabilities and read-only flag independent.

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
