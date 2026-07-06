# Multiplayer Markdown

Self-hosted, real-time collaborative sync for Obsidian vaults, with per-folder permissions — built from scratch because no existing tool (Relay, Peerdraft, YAOS, Team Relay, etc.) combines: real Obsidian/markdown files + true CRDT live co-editing + free/self-hosted/unlimited + reliable per-folder privacy + reasonable maturity. Full research trail is in the vault root: `../Self-Hosted Obsidian Multiplayer Research.md`.

**User's locked-in requirements/decisions (do not re-litigate):**
- Real Obsidian vault, plain markdown files on disk — not a proprietary format.
- True real-time simultaneous multi-user editing (live cursors, CRDT merge), not background sync.
- Self-hosted on a **VPS/Docker** (not serverless/Cloudflare Workers).
- Auth: **simple admin-managed accounts** (admin adds users via the CLI or the `/api/admin` web UI, no self-service signup).
- Permissions: **per top-level shared folder** only (not arbitrary nested ACLs). Each folder = one "room" with its own viewer/editor member list.
- Free/self-hosted, no subscription, no artificial user caps.

Full architecture/build-phase plan: `C:\Users\lukes\.claude\plans\sunny-sprouting-volcano.md` (should still exist, but this file is self-contained enough to not strictly require it).

## Architecture

One Yjs `Y.Doc` per shared top-level folder ("room") — not one per vault (too coarse for ACLs) and not one per file (too much coordination overhead). A room's doc:

```
Y.Doc "room:<roomId>"
 ├── Y.Map "files"           // relativePath -> Y.Text (file content), relative to the room's folder root
 ├── Y.Map "attachmentsMeta" // relativePath -> { hash, size, mtime }  (Phase 5, built)
 └── Y.Map "trash"           // soft-deleted path -> { deletedAt, snapshot }  (Phase 7, not built yet)
```

**Server**: `@hocuspocus/server` (Node/TS) on `PORT` (default 4444) for the WebSocket/CRDT protocol, plus a **separate plain `node:http` server on `HTTP_API_PORT`** (default 4445, no Express) for `POST /api/login`, `GET /api/rooms`, attachment routes, and (Phase 7) a full `/api/admin/*` REST surface plus a self-contained `GET /api/admin` web UI for managing users/rooms without the CLI. `onAuthenticate` is the single place room-permission logic lives — JWT verification (with `token_version` for instant revocation), room-membership lookup, `connectionConfig.readOnly = true` for viewers (confirmed server-side: Hocuspocus drops that connection's Yjs update messages entirely, never applying them). Admin routes are gated separately by `authenticateAdmin` (same JWT/`token_version` re-check, but checking `is_admin` instead of room membership — JWTs carry no admin claim, so this is a fresh DB lookup on every request, not a cached/client-trusted flag). `onLoadDocument`/`onStoreDocument` hydrate/persist each room to real `.md` files on disk under `/vaults/<roomId>/`. SQLite (`better-sqlite3`) holds `users`/`rooms`/`room_members`; passwords hashed with `argon2id`. An optional `ADMIN_USERNAME`/`ADMIN_PASSWORD` env-var pair bootstraps the first admin account on startup (idempotent — skipped once that username exists, never resets a password), so a fresh deployment needs zero terminal access to become usable.

**Plugin**: standard Obsidian plugin (esbuild). Live CM6 co-editing via `y-codemirror.next` + `@hocuspocus/provider` for whichever file is currently open; a `FileSyncEngine` watches vault create/modify/delete/rename events for closed files and reconciles them via diff (not blind overwrite). A `RoomManager` owns one provider + one `FileSyncEngine` per linked room (a user can be a member of several rooms/folders at once); `CollabBinder` looks up which active room (if any) owns a given file path via `RoomManager.findRoomForPath` rather than a single hardcoded folder.

**Monorepo** (pnpm workspaces): `packages/sync-core` (shared Yjs helpers, used by both server and plugin — the one place file↔Y.Text logic lives), `packages/server`, `packages/plugin`.

## Current status (Phases 0-6 done and verified; Phase 7 in progress)

| Phase | Status |
|---|---|
| 0 — scaffold | ✅ done |
| 1 — live CRDT co-editing of one hardcoded note | ✅ done |
| 2 — folder-level sync (create/modify/delete/rename + diff reconciliation) | ✅ done |
| 3 — server-side disk persistence | ✅ done |
| 4 — auth + per-folder permissions (the core differentiator) | ✅ done |
| 5 — binary attachments (admin CLI was already built in Phase 4) | ✅ done |
| 6 — Docker packaging/deployment | ✅ done — both the VPS/own-domain compose stack and a separate single-container all-in-one image (for Cloudflare Tunnel/Unraid) verified working against a real deployment, not just locally (see Phase 6 section below) |
| 7 — polish (presence, trash, token revocation, tests, packaging) | 🔶 in progress — admin web UI, env-var admin bootstrap, and BRAT-based plugin releases done (see their own sections below); presence indicators, trash/soft-delete, refresh-token rotation, and broader automated test coverage still open |

**What works right now:** real accounts with real per-room permissions. An admin creates users and rooms through the `/api/admin` web UI (or the CLI, which still works identically — both operate on the same SQLite rows), grants viewer/editor roles per room, and users log into the plugin (username/password → JWT, stored in the plugin's own `data.json`) and link any room they're a member of to a local folder via the settings tab. That "local folder" field must be a vault-relative path (e.g. `Shared`), not an OS filesystem path — see gotcha #7 below, found from a real "nothing is syncing" report. Multiple rooms can be linked simultaneously — each gets its own live provider connection and `FileSyncEngine`. Editors get full real-time co-editing; viewers get read-only client-side (CM6 `EditorState.readOnly`) **and** the server actually enforces it independently (`onAuthenticate` sets `connectionConfig.readOnly`, which makes Hocuspocus silently drop that connection's write messages without ever touching the document). Non-members are refused the connection outright. Revoking a user (`user revoke`) invalidates their JWT immediately via `token_version`, without waiting for expiry.

**Verified two ways:**
1. Headless (`verify:auth`, 8 checks): editor writes succeed; viewer writes never reach the editor's copy of the document (proving server-side rejection, not client-side hiding); a non-member's connection never reaches `synced`; a revoked token is rejected immediately.
2. Real Obsidian, two accounts (alice=editor, bob=viewer) on the same room: alice creates a file → bob receives it; bob edits his local copy directly via the vault API (bypassing the UI entirely) → alice's copy and the server's persisted disk copy are both untouched — the tampering never left bob's machine; bob's CM6 editor state is `readOnly: true`, alice's is `false` and she can still type live.

**Known Phase 4 scope cut (deliberate, documented):** no refresh-token rotation — JWTs are just long-lived (24h). Re-implementing proper rotating refresh tokens is deferred to Phase 7 polish; it's a UX nicety (avoiding re-logins), not a security property — the actual security boundary (`onAuthenticate` + `token_version`) doesn't depend on it.

**Phase 4 files added:**
- Server: `db.ts` (SQLite schema/queries), `auth.ts` (argon2 hashing, JWT sign/verify, `createOnAuthenticate` — the entire security boundary lives in this one function), `http-api.ts` (plain `node:http`, no Express — `/api/login`, `/api/rooms`), `cli.ts` (admin commands, see below), `verify-auth.ts` (the 8-check headless test above, run via `pnpm --filter @multiplayer-markdown/server run verify:auth`).
- Plugin: `settings.ts` (types), `api-client.ts` (`login`/`fetchRooms` via Obsidian's `requestUrl`), `login-modal.ts`, `settings-tab.ts`, `room-manager.ts` (`RoomManager` — see architecture section above). `main.ts` rewritten to wire settings persistence + `RoomManager` instead of the old hardcoded single-room globals.

**Admin CLI usage** — now optional (the `/api/admin` web UI, see Phase 7 section, does everything below through a browser instead) but still fully supported and operates on the exact same SQLite rows. Run from `packages/server`, `DB_PATH` env var controls which SQLite file, defaults to `./data/db/collab.sqlite3`:
```
npx tsx src/cli.ts user add <username> --password <pw> [--admin]
npx tsx src/cli.ts user list
npx tsx src/cli.ts user revoke <username>      # bumps token_version, invalidates all sessions immediately
npx tsx src/cli.ts user delete <username>
npx tsx src/cli.ts room create <roomId> [--label <label>]
npx tsx src/cli.ts room list
npx tsx src/cli.ts room members <roomId>
npx tsx src/cli.ts room grant <roomId> <username> <viewer|editor>
npx tsx src/cli.ts room revoke <roomId> <username>
```
Note: `pnpm run cli -- <args>` does NOT work reliably in this shell (pnpm passes a literal `"--"` through to the script on this setup) — always invoke `npx tsx src/cli.ts <args>` directly.

## Phase 5 — binary attachments (done)

Yjs isn't suited to large blobs, so attachments (images, PDFs, etc.) live entirely outside the CRDT layer, exactly as planned:

- **Server**: `attachments.ts` (`sha256Hex`, `attachmentExists`/`readAttachment`/`writeAttachment` — content-addressed, one store per room at `data/attachments/<roomId>/<hash>`; `writeAttachment` re-hashes the uploaded bytes and refuses to store them if they don't match the claimed hash, so a client can't poison the content-addressed store). Three new routes on the existing HTTP API (`http-api.ts`): `GET`/`HEAD`/`PUT /api/rooms/:roomId/attachments/:hash`, all gated by `authenticateForRoom` (the same membership-check helper `onAuthenticate` uses, extracted out during this phase so both paths share one implementation) — `PUT` additionally requires the `editor` role, matching the same read-only rule enforced over WebSocket.
- **sync-core**: `attachmentsMeta` Y.Map helpers (`getAttachmentMeta`/`setAttachmentMeta`/`deleteAttachmentMeta`/`listAttachmentPaths`) — stores only `{hash, size, mtime}` per relative path, not the bytes.
- **Plugin**: `attachment-client.ts` (`sha256Hex` via Node's `crypto` — available in Obsidian's renderer since Obsidian has nodeIntegration; `uploadAttachment`/`downloadAttachment`/`attachmentExistsRemotely` via `requestUrl`). `FileSyncEngine` now branches on file extension: `.md` files use the existing text-sync path, everything else routes through `syncLocalAttachmentToRemote`/`materializeAttachment` — hash-compare before uploading/downloading (skip if content unchanged or already present), separate shallow `observe()` on the attachments map (not `observeDeep` — attachment metadata is one atomic value per `.set()` call, unlike the two-phase markdown file case that needed `observeDeep`).

**Verified end-to-end in real Obsidian** (alice=editor, bob=viewer, same setup as Phase 4): alice creates a 300-byte binary file → bob receives it byte-for-byte identical; confirmed the actual blob lands on the server's disk at the expected content-addressed path; bob (viewer) attempts to overwrite the file locally → upload correctly rejected server-side (403), alice's copy and the room's official `attachmentsMeta` hash are both completely untouched by bob's tampering; alice deletes the file → it disappears on bob's side too.

## Phase 6 — Docker packaging/deployment (✅ done, verified working locally)

Docker was installed on the dev machine and `docker compose up --build` was actually run (not just inspected) — this caught a **second** real bug beyond the `pnpm deploy` one found earlier:

- **Build bug found and fixed:** the Dockerfile's `build` stage only `COPY`'d `pnpm-workspace.yaml package.json pnpm-lock.yaml` before running `pnpm install`/`tsc`, never the repo-root `tsconfig.base.json` that `packages/sync-core/tsconfig.json` (and server's) `extends`. Inside the container this failed as `TS5083: Cannot read file '/app/tsconfig.base.json'` — and, since the base config is where `esModuleInterop: true` lives, losing it also surfaced a second, seemingly unrelated error (`fast-diff` default-import complaint under `TS1259`) that was really the same root cause. Fix: added `tsconfig.base.json` to the first `COPY` line in `packages/server/Dockerfile`. One-line fix, but would have been a confusing two-error red herring without knowing the base config was the missing piece.
- Earlier (pre-Docker-install) verification already caught and fixed the `pnpm --prod deploy` issue: plain `pnpm --filter @multiplayer-markdown/server --prod deploy` fails on pnpm v11 with `ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE` unless `--legacy` is passed (already fixed in the Dockerfile from that earlier pass).
- **Full verification actually performed** (from repo root, `docker compose up --build -d`):
  - Both images build clean; `sync-server` and `caddy` containers start and stay up.
  - `docker compose exec sync-server node dist/cli.js user add alice --password ... --admin` works against the compiled `dist/cli.js` (not `tsx src/cli.ts`) — confirms the compiled CLI entry point inside the container is correct.
  - `POST https://localhost/api/login` through **Caddy's actual TLS reverse proxy** (self-signed cert for `DOMAIN=localhost`, auto-issued and auto-installed by Caddy) returned `200` with a real JWT — confirms Caddy's `handle` block path-routing to the HTTP API port works, not just that the YAML parses.
  - Bind-mounted volumes (`data/db`, `data/vaults`, `data/attachments`) correctly reflect container writes on the host filesystem — the SQLite file the CLI wrote `alice` into is the same file already used by local (non-Docker) dev, confirming the volume mapping is correct, not a container-local copy.
- Native module compilation (`better-sqlite3`, `argon2`) inside `node:22-slim` worked with no extra build-tool packages needed — the earlier documented risk (missing `python3`/`make`/`g++`) didn't materialize on this pnpm/Node version combo.
- Caddy's `handle` block routing is now confirmed correct by an actual successful proxied request, not just Caddyfile syntax inspection.

**Files added:**
- `packages/server/Dockerfile` — multi-stage build. Build context must be the **repo root** (`multiplayer-markdown/`), not `packages/server/`, because the server depends on `@multiplayer-markdown/sync-core` via the pnpm workspace and needs the whole monorepo visible. Uses `pnpm --filter @multiplayer-markdown/server --prod deploy /prod/server --legacy` (see verification note above) rather than hand-rolling a copy of dist+node_modules. Native modules (`better-sqlite3`, `argon2`) are compiled inside the container during `pnpm install` in the build stage — never copy node_modules built on the Windows host into the image.
- `docker-compose.yml` (repo root) — two services: `sync-server` (built from the Dockerfile above, volumes for `data/db`, `data/vaults`, `data/attachments`, requires `JWT_SECRET` from `.env` via the `${JWT_SECRET:?...}` syntax — compose refuses to start rather than silently falling back to the insecure dev default) and `caddy` (official `caddy:2` image, ports 80/443, mounts the repo-root `Caddyfile`).
- `Caddyfile` (repo root) — path-based routing on one domain: `/api/*` → `sync-server:4445` (HTTP API), everything else → `sync-server:4444` (Hocuspocus WebSocket). Uses `handle` blocks (not bare `reverse_proxy` directives) because those are needed for mutually-exclusive path routing in Caddy — two unguarded `reverse_proxy` directives would both try to handle every request.
- `.env.example` (repo root) — template for `JWT_SECRET` (generate with `openssl rand -hex 32`) and `DOMAIN` (use `localhost` for local testing — Caddy auto-issues a self-signed cert for that case). Copy to `.env` (gitignored) and fill in real values before running.
- `.dockerignore` (repo root) — excludes `node_modules`, `dist`, `data`, `test-vaults`, `.git` from the build context.

**How to test this yourself** (from the repo root):
```
cp .env.example .env
# edit .env: set a real JWT_SECRET (openssl rand -hex 32), leave DOMAIN=localhost for now
docker compose up --build
```
Then from another terminal: `curl -k -X POST https://localhost/api/login -H "Content-Type: application/json" -d '{"username":"...","password":"..."}'` — use `https://` (Caddy auto-redirects plain `http://localhost` to HTTPS rather than serving both) and `-k`/accept-the-warning since it's a locally-issued self-signed cert. Confirmed working: this returns `200` with a real JWT. You'll need to create a user first: `docker compose exec sync-server node dist/cli.js user add ... --admin` (compiled output, not `tsx src/cli.ts`, since the container only has the built `dist/`) — confirmed this writes to the same bind-mounted SQLite file visible from the host at `./data/db/collab.sqlite3`.

**Resolved during first real `docker compose up --build` run:**
1. ~~`pnpm --prod deploy --legacy`~~ — confirmed working, no further issues.
2. Native module compilation (`better-sqlite3`, `argon2`) inside `node:22-slim` — worked with zero extra system packages needed; the `python3`/`make`/`g++`-missing risk didn't materialize.
3. Caddy's `handle` block routing — confirmed correct via an actual successful proxied `/api/login` request through the container, not just Caddyfile syntax inspection.
4. Compiled CLI entry point (`dist/cli.js`) — confirmed this is what's present and runnable inside the container; `tsx src/cli.ts` is dev-only and not present in the runtime image.

**Still open / only relevant for a real deployment (not local `localhost` testing):**
- For a real VPS, `DOMAIN` needs to be a real DNS name pointing at the VPS's public IP before Caddy can issue a real Let's Encrypt certificate — ports 80/443 need to be open/forwarded. This specific path (Option B, direct Let's Encrypt via the VPS's own public IP) is still only tested against `localhost` — not yet tried against a real domain/public internet. (Option A, the Cloudflare Tunnel + all-in-one image path, *has* since been verified against a real domain and real public internet traffic — see Phase 6b below — just not this VPS-direct-cert path.)

**Design decision: two ports, not one shared HTTP server.** The plan originally called for Express sharing Hocuspocus's HTTP server. Investigated `onRequest` (Hocuspocus's hook for the same underlying `http.Server`) as a way to avoid a second port, but its default request handler unconditionally writes a "Welcome to Hocuspocus" response after hooks run unless the hook throws — and throwing propagates as an unhandled rejection risk. Not worth the fragility for 2 routes. Went with a second plain `node:http` server (`HTTP_API_PORT`, default 4445) instead — no Express dependency needed. Phase 6's Caddy reverse proxy can still expose both under one public domain via path-based routing.

**Note found while building Phase 3 (unrelated pre-existing issue, now fixed):** `packages/server/src/verify-sync.ts` had a type error that only surfaced once `tsc` was run across the whole server package for the first time — `HocuspocusProviderConfiguration` doesn't actually allow `WebSocketPolyfill` alongside a plain `url`, only alongside `websocketProvider`. Tried switching to the "correct" `websocketProvider` shape and it broke the actual connection (client never synced) — so the fix was to keep the original working runtime shape (`url` + `WebSocketPolyfill`) and cast past the overly-strict published type, rather than "fixing" it into a shape that doesn't actually work. If you see this error again, don't restructure the provider construction — just cast.

## Phase 6b — Cloudflare Tunnel / Unraid: single all-in-one image (✅ done, verified against a real live deployment)

Option A (Cloudflare Tunnel) went through three real designs before landing on the current one — each earlier one was tried against an actual user deployment and rejected for a concrete reason, not just theorized away:

1. **Two Cloudflare Public Hostname rules, two ports** (`/api/*` → HTTP API port, catch-all → WebSocket port), both pointed at the same tunnel. This reliably trips a real Cloudflare **dashboard** bug: adding the second rule under one tunnel hostname throws "A, AAAA, or CNAME record with that host already exists," because the dashboard tries to (re)create a DNS record the first rule already created. Workaround exists (delete the DNS record, then re-save) but it's a real, repeatable rough edge for anyone following this path.
2. **A 3-container Docker Compose stack** (`sync-server` + a plain-HTTP `caddy-tunnel` + `cloudflared` itself, all sharing one Compose network so they resolve each other by container name) — worked, avoided the dashboard bug entirely, but the user explicitly rejected running multiple containers: "I don't want to have multiple containers, I want a single container."
3. **Final design — one image, two Dockerfile targets:** `packages/server/Dockerfile` now has a second final stage, `allinone` (alongside the original `server` stage, which Option B still uses unchanged). It bundles the `caddy` binary (`COPY --from=caddy:2 /usr/bin/caddy /usr/bin/caddy`) and a baked-in `packages/server/docker/Caddyfile` into the same image as the Node server, run together by `packages/server/docker/entrypoint.sh` — a ~15-line bash script that backgrounds both processes, traps `SIGTERM`/`SIGINT` to forward to both, and uses `wait -n` so if *either* process dies the whole container exits (letting Docker's restart policy relaunch both together, never leaving one alive without the other). Since Caddy and Node share one network namespace in this design, the baked-in Caddyfile talks to plain `localhost:4444`/`localhost:4445` — no env var indirection, no bind-mounted config, nothing for the user to hand-create. Cloudflare's tunnel (run entirely separately by the user — this project never runs `cloudflared` itself) only ever needs **one** Published Application route pointed at **one** port.

**CI** (`.github/workflows/docker-publish.yml`) builds and pushes *two* images from that one Dockerfile in the same job, via `target: server` and `target: allinone` respectively — `ghcr.io/.../multiplayer-markdown-sync-server` (Option B, unchanged) and `ghcr.io/.../multiplayer-markdown` (Option A, the new all-in-one). Docker defaults to the *last* stage in a Dockerfile when no `--target` is given, so appending `allinone` after `server` required adding an explicit `target: server` to the pre-existing build step — without it, that step would have silently started building the wrong image.

`docker-compose.yml`'s earlier `caddy-tunnel`/`cloudflared` services (design #2 above) and the root-level `Caddyfile.tunnel` were deleted entirely once design #3 landed — Option A no longer touches `docker-compose.yml` at all, it's a plain `docker run` or a single Unraid "Add Container" entry. `docs/unraid-compose.md` no longer covers Cloudflare Tunnel for the same reason; it's Option-B-only now (bundled Caddy + a real Let's Encrypt cert, via Compose Manager).

**Real routing gotcha found while designing the admin UI (Phase 7) on top of this:** both Caddy configs — the root `Caddyfile` (Option B) and `packages/server/docker/Caddyfile` (Option A) — only forward the `/api/*` path prefix to the HTTP API port; everything else (the catch-all) goes to the Hocuspocus WebSocket port instead. Any new HTTP route, page or API, **must** live under `/api/*` or it silently gets routed to the wrong port in both deployment modes. This is why `/api/admin` (the web UI page itself, not just its JSON endpoints) lives under `/api/`, even though it's serving an HTML page rather than JSON.

**Real unrelated bug hit during actual deployment (worth remembering if it comes up again):** a domain that had previously been parked/forwarded (via the registrar, Porkbun in this case) can leave a stale redirect — such as a Cloudflare **Bulk Redirect** or legacy **Page Rule** — that intercepts traffic before it ever reaches the tunnel, even after nameservers are correctly pointed at Cloudflare and DNS records look right. It presented as a `302` to a `<domain-with-dashes>.l.ink` URL with `Server: cloudflare` but an `openresty`-branded HTML body — the giveaway that it wasn't this project's Caddy or Cloudflare Tunnel at all, but something upstream in the account's own Rules configuration. **Rules → Redirect Rules** alone isn't enough to check — **Bulk Redirects** and **Page Rules** are separate features in Cloudflare's dashboard and are easy to miss.

**Verified live** (not just headlessly): real Cloudflare Tunnel connector (the user's own, run as a separate Unraid app), real Unraid container from the published `ghcr.io/.../multiplayer-markdown` image, real domain. Confirmed via `curl` that `/api/login` returns the correct `401` JSON through the full chain (Cloudflare → tunnel → container's internal Caddy → Node HTTP API), visible in the `Via: 1.1 Caddy` response header.

## Phase 7 — Admin web UI (✅ done)

Replaces the CLI-only admin workflow with a single self-contained page, so non-technical self-hosters never need a terminal to create accounts or rooms.

- **`packages/server/src/admin-ui.ts`** (new) — exports one `ADMIN_HTML` template-string constant: login form, users table + add-user form, rooms table + create-room form, and a per-room members panel (grant/revoke, viewer/editor). No new dependency, no bundler, no build step — the whole page (inline `<style>`/`<script>`) is just TS source compiled like everything else. Deliberately renders all user-supplied strings (usernames, labels) via `textContent`/DOM APIs rather than raw HTML interpolation.
- **`packages/server/src/auth.ts`** — new `authenticateAdmin`, same verification chain as `authenticateForRoom` (verify JWT → re-check `token_version` against the DB for instant revocation) but checking `user.is_admin === 1` instead of room membership. JWTs never carry an admin claim, so this is a fresh DB lookup every call — revoking someone's admin status takes effect on their very next request, not just their next login.
- **`packages/server/src/http-api.ts`** — 9 new routes under `/api/admin/*` (user add/list/revoke/delete, room create/list/members/grant/revoke — exact parity with `cli.ts`, nothing more) plus the unauthenticated `GET /api/admin` page route, all gated through one `requireAdmin` helper (missing token → `401`; invalid/expired/revoked/not-admin → `403`, matching the precedent already set by the attachment routes' `authenticateForRoom` handling rather than inventing a finer-grained scheme).
- **`packages/server/src/index.ts`** — optional `ADMIN_USERNAME`/`ADMIN_PASSWORD` env-var bootstrap, idempotent (create-if-username-doesn't-exist, otherwise a no-op) so it's safe to leave set permanently across restarts without ever resetting the password.
- **`packages/server/src/verify-admin-api.ts`** (new, `pnpm run verify:admin`) — 47 headless checks. The security-critical ones: every one of the 9 admin routes rejects a missing token (`401`), a valid *non-admin* token (`403`), a malformed token (`403`), and a revoked admin's stale-but-unexpired token (`403`) — the concrete proof that "hide the button" isn't the security model here.
- **Verified live**: created a real user + room + membership grant through the actual API (not just headless), confirmed the CLI (`user list`/`room list`/`room members`) sees the identical state (same SQLite rows, not a parallel system), then logged in as that real non-admin account and confirmed a genuine `403` from the browser-facing flow, not just the test suite.

## BRAT-compatible plugin releases (✅ done)

The plugin isn't in Obsidian's official Community Plugins store, but it installs and auto-updates via **BRAT** (Obsidian42 - BRAT), which works by pulling `manifest.json` and `main.js` off a GitHub Release's attached assets — not from files sitting in the repo.

- **`.github/workflows/plugin-release.yml`** (new) — triggers on a bare-semver tag push (e.g. `0.1.0`, no `v` prefix — matches Obsidian's own plugin template convention, and deliberately never collides with `docker-publish.yml`'s `v*`-prefixed server-image tags). Builds `sync-core` then the plugin, **fails the build if the pushed tag doesn't match `manifest.json`'s `version` field** (catches releasing without bumping it first — a mismatch here would silently confuse BRAT's update detection), then attaches the built `main.js` and `manifest.json` to a GitHub Release via `softprops/action-gh-release`.
- **Gotcha found**: `pnpm/action-setup@v4` fails with "No pnpm version is specified" if the repo has no `packageManager` field and the action isn't given an explicit `version` input. Fixed by adding `"packageManager": "pnpm@11.10.0"` to the repo-root `package.json`.
- First real release cut and verified: tag `0.0.1`, confirmed via `gh release view 0.0.1` that both `main.js` and `manifest.json` are attached. Any future release is just: bump `packages/plugin/manifest.json`'s `version`, tag with that exact same bare version string, push the tag.
- `manifest.json`'s `author`/`authorUrl` were fixed from placeholder values (`"you"`) to real ones, since a BRAT-installed plugin makes these genuinely user-visible for the first time.

## Key gotchas discovered (do not re-debug these from scratch)

1. **`registerEditorExtension` doesn't retroactively apply to already-open editors.** Obsidian restores the last-open file *after* plugin `onload()` returns, not before. Fix: `workspace.onLayoutReady()` — but also...
2. **`onLayoutReady()` can be slow or (in edge cases observed directly) never fire.** Never let plugin functionality depend on it without a timeout fallback.
3. **Never dispatch to a CM6 `EditorView` synchronously from inside a `ViewPlugin` constructor.** It runs mid-update; CM6 throws "Calls to EditorView.update are not allowed while an update is in progress" and silently drops the change. Defer with `queueMicrotask`.
4. **`Y.Map.observe()` is shallow — use `observeDeep()`.** A new file is two separate Yjs changes (key added with empty `Y.Text`, then content inserted into it). Shallow `observe()` only fires for the first; the content update needs `observeDeep()`, and the handler must use `event.path` to find nested changes (not just `event.keysChanged`).
5. **Creating a new `Y.Text` entry and inserting its content must be ONE atomic transaction**, or your own change-observer can fire twice (empty, then real) and the two async disk-writes can race and land out of order — this actually happened (a renamed file ended up empty on disk). Always use `setFileContent(doc, path, content)` from `sync-core`, never the raw `getOrCreateFileText` + `reconcileYTextWithContent` two-step.
6. **`onload()` must never block on network/layout conditions.** Obsidian appears to await each plugin's `onload()` during its own startup — an unresolved promise in there (e.g. waiting on an unreachable server with no timeout) hangs *all of Obsidian*, not just the plugin. This actually happened during development. Pattern: `onload()` does synchronous setup only, then kicks off `void this.initializeAfterLoad()` (not awaited) for anything that touches the network or `onLayoutReady`.
7. **A linked room's "local folder" setting (`vaultFolder`) must be a vault-relative path, never an OS filesystem path.** Obsidian's own `TFile.path` values are always relative to the vault root (e.g. `Test Folder/test.md`); `isUnderFolder`/`FileSyncEngine` compare directly against that, with no normalization. Pasting a real absolute path (e.g. copied straight from File Explorer, `A:\Coding\...\Test Folder`) into the settings-tab text field silently breaks sync — no error surfaces anywhere, the plugin just believes there are zero local files under the target and never syncs anything. This was the actual root cause of a real "I linked a room but nothing is syncing" report. Fix is the bare relative folder name only (e.g. `Test Folder`). Editing `data.json` directly also works, but a currently-running Obsidian instance holds settings in memory and won't notice the on-disk change until the vault/plugin is reloaded.

### Testing methodology gotchas (only relevant if automating Obsidian via Chrome DevTools Protocol like this session did)

Obsidian is Electron, so it can be launched with `--remote-debugging-port=<port> --user-data-dir=<isolated dir>` and driven via CDP (`ws://localhost:<port>/json` for targets, then `Runtime.evaluate` over the target's websocket) — this is how every Phase 1/2 test in this project was actually verified end-to-end without the user needing to click anything. Gotchas specific to this approach, not to Obsidian itself:
- A fresh isolated profile needs `app.plugins.setEnable(true)` called once via CDP (community plugins are off by default; `community-plugins.json` alone isn't enough).
- A fresh/automated launch can leave `app.vault.getFiles()` returning `[]` and vault events never firing, even though the adapter can see real files on disk (`app.vault.adapter.list('')` works fine) — fix is calling `app.vault.load()` once via CDP. This is an artifact of the automated launch path, not a real bug.
- Prefer a full process relaunch over `location.reload()` when testing vault-event-dependent behavior — reload can leave `workspace.layoutReady` stuck `false` and vault events dead, seemingly tied to corrupted profile/workspace state from repeated in-page reloads.
- Use `require('electron').remote.app.quit()` via CDP to cleanly quit an isolated instance (confirm via `Get-CimInstance Win32_Process` filtered to the custom `--user-data-dir` before assuming it's gone — Electron spawns several child processes per instance).

## Dev workflow

```
pnpm install                                    # from multiplayer-markdown/
pnpm --filter @multiplayer-markdown/sync-core run verify        # headless unit tests (18 checks, run these after any sync-core change)
pnpm --filter @multiplayer-markdown/server run verify:sync        # headless two-client CRDT convergence test
pnpm --filter @multiplayer-markdown/server run verify:persistence  # headless disk-persistence test (write, simulate restart, hydrate)
pnpm --filter @multiplayer-markdown/server run verify:auth         # headless auth/permission test (8 checks — see Phase 4 section)
pnpm --filter @multiplayer-markdown/server run verify:attachments  # headless attachment upload/download/permission test (see Phase 5 section)
pnpm --filter @multiplayer-markdown/server run verify:admin        # headless admin-API test (47 checks — see Phase 7 section)
pnpm --filter @multiplayer-markdown/server run dev               # start dev server: ws://localhost:4444 (Hocuspocus) + http://localhost:4445 (login/rooms API, admin UI at /api/admin)
pnpm --filter @multiplayer-markdown/plugin run build              # typecheck + esbuild bundle -> main.js
pnpm --filter @multiplayer-markdown/plugin run sync-test-vaults    # copies main.js/manifest.json into test-vaults/vault-a and vault-b
```

`test-vaults/vault-a` and `test-vaults/vault-b` are two throwaway Obsidian vaults (git-ignored territory in spirit, but not actually gitignored — check before committing) used for manual/automated verification. Both have the plugin pre-installed and a `Shared/` folder as the sync target. Open both as separate vaults in Obsidian (or drive them via CDP as described above) to test. `packages/server/data/` is where persisted room files land — gitignored, safe to delete between test runs for a clean slate.

## Next up: rest of Phase 7

What's already done in Phase 7 (admin web UI, env-var admin bootstrap, BRAT plugin releases) has its own sections above. Still open:

- **Presence** — showing who else is currently viewing/editing a room (live cursors already work per-open-file via CM6/Yjs awareness; a room-level "who's here" indicator is a separate, not-yet-built UI piece).
- **Trash/soft-delete** — the schema already reserves a `Y.Map "trash"` (see Architecture section) but nothing writes to or reads from it yet; deletes are currently permanent.
- **Refresh-token rotation** — documented Phase 4 scope cut, still true: JWTs are long-lived (24h) rather than short-lived + rotated. UX nicety, not a security gap (the real boundary is `onAuthenticate`/`authenticateForRoom`/`authenticateAdmin` + `token_version`, none of which depend on token lifetime).
- **Broader automated test coverage** — the `verify:*` scripts are solid for what they cover (auth, attachments, admin API, sync, persistence) but there's no coverage yet for the plugin side (`FileSyncEngine`, `RoomManager`) beyond manual/CDP-driven testing.
- **Obsidian Community Plugin store submission** — now that a real BRAT-compatible release pipeline exists (tagged GitHub Releases with `manifest.json`+`main.js`), submitting to the official store is much closer than before, but hasn't been attempted (needs a `README`/plugin listing review, and Obsidian's own submission process).
