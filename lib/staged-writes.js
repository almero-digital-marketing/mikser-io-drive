import { rename, unlink, open } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

// Make a PUT atomic from the filesystem's point of view.
//
// @nephele/adapter-file-system writes straight to the destination:
//
//     const handle = await fsp.open(this.absolutePath, 'w')   // truncates NOW
//     input.pipe(handle.createWriteStream())
//
// Measured against a trickling 512KB upload, that has two consequences, and
// the second is data loss:
//
//   1. The file is visible while it grows — 65536, 131072, … 524288 bytes.
//      These folders are mikser sources, so the watcher can import a
//      half-written file and render a truncated page.
//   2. An interrupted overwrite DESTROYS what was there. `'w'` truncates at
//      open, so a 1600-byte file whose upload died after 196608 bytes was
//      left as 196608 bytes of the new content. Not the old file, not an
//      error — a corrupted file, silently.
//
// Both go away by writing to a sibling temp file and renaming on success.
// rename(2) within a directory is atomic: the watcher sees the file appear
// complete or not at all, and a failed upload leaves the original untouched
// because it was never opened for writing.
//
// A sibling rather than the OS temp dir, because rename is only atomic within
// one filesystem and /tmp is frequently another mount.
export function stageWrites(resource, { onFailure } = {}) {
    if (typeof resource?.setStream !== 'function') return resource

    return new Proxy(resource, {
        get(target, prop, receiver) {
            if (prop !== 'setStream') {
                const value = Reflect.get(target, prop, receiver)
                return typeof value === 'function' ? value.bind(target) : value
            }

            return async function setStream(input, user, ...rest) {
                const finalPath = target.absolutePath
                // No path to stage next to — a virtual or non-filesystem
                // resource. Fall through rather than guess.
                if (!finalPath) return target.setStream(input, user, ...rest)

                const tempPath = path.join(
                    path.dirname(finalPath),
                    `.${path.basename(finalPath)}.${randomBytes(6).toString('hex')}.part`,
                )

                let handle
                try {
                    handle = await open(tempPath, 'wx')
                    await new Promise((resolve, reject) => {
                        const stream = handle.createWriteStream()
                        stream.on('error', reject)
                        stream.on('close', resolve)
                        input.on('error', (err) => { stream.destroy(); reject(err) })
                        input.pipe(stream)
                    })
                    await handle.close()
                    handle = null

                    // The atomic moment. Everything before this is invisible
                    // to the watcher because the temp name is dot-prefixed
                    // and suffixed .part; everything after is a complete file.
                    await rename(tempPath, finalPath)

                    // The adapter caches these off the old file.
                    target.etag = undefined
                    target.stats = undefined
                } catch (err) {
                    await handle?.close().catch(() => {})
                    await unlink(tempPath).catch(() => {})
                    onFailure?.(err, finalPath)
                    throw err
                }
            }
        },
    })
}

// Wrap an adapter so every resource it hands out stages its writes.
export function withStagedWrites(adapter, options = {}) {
    const wrap = (method) => async (...args) => stageWrites(await adapter[method](...args), options)
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
