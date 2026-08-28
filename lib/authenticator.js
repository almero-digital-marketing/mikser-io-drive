import { UnauthorizedError, ForbiddenError } from 'nephele'
import { authorize } from 'mikser-io'

// Bridges Nephele's Authenticator contract onto the engine's verifier seam
// (ADR-0012), so WebDAV authenticates against the same htpasswd identity as
// every other surface — one users file, one groups file, one set of
// capabilities.
//
// Nephele's interface is two methods:
//
//   authenticate(request, response) → User   (throw to refuse)
//   cleanAuthentication(request, response)
//
// Deliberately NOT @nephele/authenticator-htpasswd, which would re-read the
// file itself: that loses the mtime reload, the timing-equalised unknown-user
// path, and — the real reason — any knowledge of groups, so capabilities
// could not gate anything.
//
// Deliberately NOT @nephele/authenticator-custom either. Its getUser/authBasic
// pair is Basic-only by construction, while a verifier already understands
// every credential the deployment accepts, Bearer included (rclone and curl
// can send one; Finder cannot). Going through the seam means WebDAV gains
// whatever the seam gains.
// The WebDAV methods that change something. COPY and MOVE mutate the
// destination (MOVE the source too), and LOCK exists in order to write.
export const WRITE_METHODS = new Set([
    'PUT', 'POST', 'DELETE', 'MKCOL', 'COPY', 'MOVE', 'PROPPATCH', 'LOCK', 'UNLOCK',
])

export class MikserAuthenticator {
    #verifier
    #trustLoopback
    #allowRemote
    #capability
    #writeCapability
    #realm
    #logger

    constructor({
        verifier, trustLoopback = false, allowRemote = false,
        capability, writeCapability, realm = 'mikser', logger,
    } = {}) {
        this.#verifier        = verifier
        this.#trustLoopback   = trustLoopback
        this.#allowRemote     = allowRemote
        this.#capability      = capability
        this.#writeCapability = writeCapability
        this.#realm           = realm
        this.#logger          = logger
    }

    async authenticate(request, response) {
        let outcome
        try {
            outcome = await authorize(request, this.#verifier, {
                allowRemote:   this.#allowRemote,
                trustLoopback: this.#trustLoopback,
            })
        } catch (err) {
            this.#logger?.error?.('drive: verifier threw — %s', err.message)
            throw new UnauthorizedError('Authentication failed.')
        }

        if (!outcome.ok) {
            // Nephele turns UnauthorizedError into a bare 401. A DAV client
            // will not prompt for credentials without being told how, so the
            // challenge has to be set here — and it must offer Basic, because
            // that is the only scheme Finder and Explorer speak.
            if (outcome.status === 401) {
                response.set('WWW-Authenticate', `Basic realm="${this.#realm}", charset="UTF-8"`)
                throw new UnauthorizedError(outcome.error)
            }
            // 403: the credential was never the problem — the caller's origin
            // was. Challenging would invite a retry that cannot help.
            throw new ForbiddenError(outcome.error)
        }

        const principal = outcome.principal

        // Capability gate for this endpoint. `capabilities: null` means the
        // credential is not capability-scoped (no map configured, or a bare
        // static token), which passes — same rule as every other surface.
        if (this.#capability && principal.capabilities != null &&
            !principal.capabilities.includes(this.#capability)) {
            this.#logger?.debug?.('drive: %j lacks %j', principal.subject, this.#capability)
            throw new ForbiddenError(`Your credential does not carry '${this.#capability}'.`)
        }

        // Write gating happens HERE rather than through Nephele's conditional-
        // plugins hook, because that hook cannot see the user: createServer
        // mounts loadPlugins before authenticate, so response.locals.user is
        // always undefined when the plugins function runs. (Nephele's own
        // README example tests `response.locals.user == null` there, which
        // therefore never means what it looks like it means.) The authenticator
        // is the earliest place that holds both the principal and the method.
        if (this.#writeCapability && WRITE_METHODS.has(request.method) &&
            principal.capabilities != null &&
            !principal.capabilities.includes(this.#writeCapability)) {
            this.#logger?.debug?.('drive: %j may not %s — lacks %j',
                principal.subject, request.method, this.#writeCapability)
            throw new ForbiddenError(`Your credential does not carry '${this.#writeCapability}'.`)
        }

        // Nephele only requires `username`. The principal rides along for
        // anything downstream that wants it.
        return { username: principal.subject ?? 'anonymous', principal }
    }

    async cleanAuthentication() {
        // Nothing to tear down: every request re-verifies, and there is no
        // session to invalidate. A revoked htgroup line takes effect on the
        // next request rather than needing anything torn down here.
    }
}

export default MikserAuthenticator
