# HTTP API Reference

Codeman's HTTP API is a **stable contract** as of 1.0 — see
[`versioning-policy.md`](versioning-policy.md) for the SemVer guarantee. This page
defines the response envelope, status codes, error codes, versioning, and the SSE
event channel.

## Versioning

- The stable, public surface is served under **`/api/v1/...`**. Pin external
  clients to this prefix.
- The unversioned **`/api/...`** paths are a permanent alias of the current
  version (what the bundled web UI uses). They are kept working, but new external
  integrations should use `/api/v1`.
- Breaking changes to the contract ship under a new prefix (`/api/v2`); `/api/v1`
  keeps its semantics. Additive changes (new endpoints, new optional fields, new
  error codes) are non-breaking and may appear in a minor release.
- The implementation rewrites `/api/v1/*` → `/api/*` at the server level
  (`rewriteApiV1Url` in `src/web/server.ts`).

## Response envelope

Every JSON response uses one uniform envelope, applied centrally by a
`preSerialization` hook (`src/web/server.ts`) — handlers return bare data and the
hook wraps it:

**Success** — HTTP `2xx`:

```json
{ "success": true, "data": <payload> }
```

`data` is the endpoint's payload (object, array, or value). Endpoints with no
payload return `{ "success": true, "data": {} }`.

**Error** — HTTP `4xx`/`5xx`:

```json
{ "success": false, "error": "human-readable message", "errorCode": "NOT_FOUND" }
```

`ApiResponse<T>` in `src/types/api.ts` is the canonical type.

> Non-JSON endpoints are exempt from the envelope: `GET /api/sessions/:id/file-raw`,
> `GET /api/sessions/:id/tail-file` (SSE), `GET /api/download`,
> `GET /api/screenshots/:name`, `GET /q/:code` (QR redirect),
> `GET /html-view/:cap/*` (a [rendered HTML file](#rendered-html-files) and its
> assets), and the `GET /ws/sessions/:id/terminal` WebSocket upgrade.
>
> **Deprecated:** `POST /api/screenshots`, `GET /api/screenshots` and
> `GET /api/screenshots/:name` keep working but log a one-time warning on first
> use. They are removed in a later MAJOR, after at least one MINOR release that
> carries this warning (see `docs/versioning-policy.md`). To hand
> a file to an agent, use `POST /api/sessions/:id/paste-image`, which saves it into
> that session's workspace.

> The [agent wait endpoints](#long-polling-agent-wait) use the normal envelope but
> are the only JSON endpoints that deliberately **hold the connection open**, for up
> to 600 s. Proxy operators and HTTP clients with a global read timeout need to know
> that before pointing them at Codeman.

⚠️ **A `401` is the one status that is not an envelope.** Authentication is rejected
in a request hook, before any handler runs, and it replies with the bare string
`Unauthorized` (`Unauthorized: hook secret required` on the hook path) plus
`WWW-Authenticate: Basic realm="Codeman"`. There is no `success`, no `error`, and no
`errorCode`, because the wrapping hook only wraps object payloads. So a client that
pipes every response straight into a JSON parser dies with a parse error rather than
reporting an auth failure, which is a confusing way to discover that a password is
set. Branch on the HTTP status **before** parsing.

## Error codes → HTTP status

The single source of truth is `ErrorStatus` / `httpStatusForErrorCode()` in
`src/types/api.ts`. Clients should branch on `errorCode` (stable) and may rely on
the HTTP status.

| `errorCode` | HTTP | Meaning |
|-------------|------|---------|
| `INVALID_INPUT` | 400 | Malformed request / failed validation |
| `UNAUTHORIZED` | 401 | Authentication required or failed |
| `FORBIDDEN` | 403 | Signed in, but not allowed (e.g. a non-admin calling an admin-only route in multi-user mode) |
| `PASSWORD_CHANGE_REQUIRED` | 403 | Multi-user: the user must change their password before anything else |
| `NOT_FOUND` | 404 | Resource does not exist |
| `USER_NOT_FOUND` | 404 | Multi-user: no user with that name |
| `SESSION_BUSY` | 409 | Session is busy |
| `CONFLICT` | 409 | Conflicts with current state (e.g. already running) |
| `ALREADY_EXISTS` | 409 | Resource already exists |
| `USER_EXISTS` | 409 | Multi-user: a user with that name already exists |
| `LAST_ADMIN` | 409 | Multi-user: refusing to demote, disable or delete the last enabled admin |
| `OPERATION_FAILED` | 422 | Well-formed but could not be completed |
| `RATE_LIMITED` | 429 | Too many requests |
| `INTERNAL_ERROR` | 500 | Unexpected server error |
