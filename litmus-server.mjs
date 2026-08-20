// Target for an external WebDAV compliance run.
//
//     node litmus-server.mjs                  # boots on :8399
//     TESTS=props litmus http://127.0.0.1:8399/webdav/compliant/ litmus litmus-pw
//
// litmus (the neon project's suite) is not a dependency — install it from your
// distro. Scores are recorded in the README; this file is what produced them,
// kept so they can be reproduced rather than taken on faith.
//
// Boots the WebDAV server on a fixed port for an external compliance run.
// Two endpoints, because they should NOT score the same:
//
//   /webdav/default    properties+locks 'emulate' — the shipped default
//   /webdav/compliant  properties+locks 'meta-files' — full storage
//
// litmus's `props` suite sets a dead property and reads it back. 'emulate'
// reports success without storing, so it is expected to fail those — that is
// the documented trade, and a compliance suite is exactly the thing that
// should say so out loud.
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import bcrypt from 'bcryptjs'
import { runtime } from 'mikser-io'
import { auth } from 'mikser-io-auth'
import { webdav } from './index.js'

const PORT = Number(process.env.PORT ?? 8399)

const dir = await mkdtemp(path.join(tmpdir(), 'litmus-'))
// A folder PER endpoint. Sharing one made the two suites contaminate each
// other's leftover /litmus/ collection, which showed up as a suite aborting
// at `begin` — a harness bug that looked like a server bug.
await mkdir(path.join(dir, 'default'), { recursive: true })
await mkdir(path.join(dir, 'compliant'), { recursive: true })
await mkdir(path.join(dir, 'runtime'), { recursive: true })
await writeFile(path.join(dir, 'users.htpasswd'), `litmus:${bcrypt.hashSync('litmus-pw', 10)}\n`)

const { default: express } = await import('express')
const app = express()
runtime.options = { ...runtime.options, app, workingFolder: dir, runtimeFolder: path.join(dir, 'runtime') }
runtime.config = {}
runtime.engine = { logger: { info(){}, warn(){}, error(){}, debug(){}, trace(){}, fatal(){} } }

const identity = auth({})   // no capability map → authenticated users unscoped
const plugin = webdav({
    endpoints: {
        default:   { folder: 'default' },
        compliant: { folder: 'compliant', properties: 'meta-files', locks: 'meta-files' },
    },
    auth: identity,
})

const load = [], loaded = []
const core = {
    runtime,
    onLoad: (c) => load.push(c),
    onLoaded: (c) => loaded.push(c),
    useLogger: () => ({ info(){}, warn(){}, error(){}, debug(){}, trace(){} }),
}
identity(core)
plugin(core)
for (const c of load) await c()
for (const c of loaded) await c()

const server = app.listen(PORT, () => {
    console.log(`litmus target ready on http://127.0.0.1:${PORT}`)
    console.log(`  working folder: ${dir}`)
    console.log(`  credentials:    litmus / litmus-pw`)
    console.log(`  endpoints:      /webdav/default  /webdav/compliant`)
})
// litmus uploads and holds connections; do not let node's 5-minute cap
// truncate a suite mid-run.
server.requestTimeout = 30 * 60 * 1000
