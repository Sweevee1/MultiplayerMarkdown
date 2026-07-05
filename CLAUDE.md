# Multiplayer Markdown

Self-hosted, real-time collaborative sync for Obsidian vaults, with per-folder permissions — built from scratch because no existing tool (Relay, Peerdraft, YAOS, Team Relay, etc.) combines: real Obsidian/markdown files + true CRDT live co-editing + free/self-hosted/unlimited + reliable per-folder privacy + reasonable maturity. Full research trail is in the vault root: `../Self-Hosted Obsidian Multiplayer Research.md`.

**User's locked-in requirements/decisions (do not re-litigate):**
- Real Obsidian vault, plain markdown files on disk — not a proprietary format.
- True real-time simultaneous multi-user editing (live cursors, CRDT merge), not background sync.
- Self-hosted on a **VPS/Docker** (not serverless/Cloudflare Workers).
- Auth: **simple admin-managed accounts** (admin adds users via CLI, no self-service signup).
- Permissions: **per top-level shared folder** only (not arbitrary nested ACLs). Each folder = one "room" with its own viewer/editor member list.
- Free/self-hosted, no subscription, no artificial user caps.

Full architecture/build-phase plan: `C:\Users\lukes\.claude\plans\sunny-sprouting-volcano.md` (should still exist, but this file is self-contained enough to not strictly require it).

## Architecture

One Yjs `Y.Doc` per shared top-level folder ("room") — not one per vault (too coarse for ACLs) and not one per file (too much coordination overhead). A room's doc:

```
Y.Doc "room:<roomId>"
 ├── Y.Map "files"           // relativePath -> Y.Text (file content), relative to the room's folder root
 ├── Y.Map "attachmentsMeta" // relativePath -> { hash, size, mtime }  (Phase 5, not built yet)
 └── Y.Map "trash"           // soft-deleted path -> { deletedAt, snapshot }  (Phase 7, not built yet)
```

**Server**: `@hocuspocus/server` (Node/TS) on `PORT` (default 4444) for the WebSocket/CRDT protocol, plus a **separate plain `node:http` server on `HTTP_API_PORT`** (default 4445, no Express — only 2 routes) for `POST /api/login` and `GET /api/rooms`. `onAuthenticate` is the single place permission logic lives — JWT verification (with `token_version` for instant revocation), room-membership lookup, `connectionConfig.readOnly = true` for viewers (confirmed server-side: Hocuspocus drops that connection's Yjs update messages entirely, never applying them). `onLoadDocument`/`onStoreDocument` hydrate/persist each room to real `.md` files on disk under `/vaults/<roomId>/`. SQLite (`better-sqlite3`) holds `users`/`rooms`/`room_members`; passwords hashed with `argon2id`.

**Plugin**: standard Obsidian plugin (esbuild). Live CM6 co-editing via `y-codemirror.next` + `@hocuspocus/provider` for whichever file is currently open; a `FileSyncEngine` watches vault create/modify/delete/rename events for closed files and reconciles them via diff (not blind overwrite). A `RoomManager` owns one provider + one `FileSyncEngine` per linked room (a user can be a member of several rooms/folders at once); `CollabBinder` looks up which active room (if any) owns a given file path via `RoomManager.findRoomForPath` rather than a single hardcoded folder.

**Monorepo** (pnpm workspaces): `packages/sync-core` (shared Yjs helpers, used by both server and plugin — the one place file↔Y.Text logic lives), `packages/server`, `packages/plugin`.

## Current status (Phases 0-5 done and verified; Phase 6 written but not yet tested)

| Phase | Status |
|---|---|
| 0 — scaffold | ✅ done |
| 1 — live CRDT co-editing of one hardcoded note | ✅ done |
| 2 — folder-level sync (create/modify/delete/rename + diff reconciliation) | ✅ done |
| 3 — server-side disk persistence | ✅ done |
| 4 — auth + per-folder permissions (the core differentiator) | ✅ done |
| 5 — binary attachments (admin CLI was already built in Phase 4) | ✅ done |
| 6 — Docker packaging/deployment | ✅ done — `docker compose up --build` verified working locally (found + fixed a real bug, see Phase 6 section below) |
| 7 — polish (presence, trash, token revocation, tests, packaging) | not started |

**What works right now:** real accounts with real per-room permissions. An admin creates users and rooms via the CLI, grants viewer/editor roles per room, and users log into the plugin (username/password → JWT, stored in the plugin's own `data.json`) and link any room they're a member of to a local folder via the settings tab. Multiple rooms can be linked simultaneously — each gets its own live provider connection and `FileSyncEngine`. Editors get full real-time co-editing; viewers get read-only client-side (CM6 `EditorState.readOnly`) **and** the server actually enforces it independently (`onAuthenticate` sets `connectionConfig.readOnly`, which makes Hocuspocus silently drop that connection's write messages without ever touching the document). Non-members are refused the connection outright. Revoking a user (`user revoke`) invalidates their JWT immediately via `token_version`, without waiting for expiry.

**Verified two ways:**
1. Headless (`verify:auth`, 8 checks): editor writes succeed; viewer writes never reach the editor's copy of the document (proving server-side rejection, not client-side hiding); a non-member's connection never reaches `synced`; a revoked token is rejected immediately.
2. Real Obsidian, two accounts (alice=editor, bob=viewer) on the same room: alice creates a file → bob receives it; bob edits his local copy directly via the vault API (bypassing the UI entirely) → alice's copy and the server's persisted disk copy are both untouched — the tampering never left bob's machine; bob's CM6 editor state is `readOnly: true`, alice's is `false` and she can still type live.

**Known Phase 4 scope cut (deliberate, documented):** no refresh-token rotation — JWTs are just long-lived (24h). Re-implementing proper rotating refresh tokens is deferred to Phase 7 polish; it's a UX nicety (avoiding re-logins), not a security property — the actual security boundary (`onAuthenticate` + `token_version`) doesn't depend on it.

**Phase 4 files added:**
- Server: `db.ts` (SQLite schema/queries), `auth.ts` (argon2 hashing, JWT sign/verify, `createOnAuthenticate` — the entire security boundary lives in this one function), `http-api.ts` (plain `node:http`, no Express — `/api/login`, `/api/rooms`), `cli.ts` (admin commands, see below), `verify-auth.ts` (the 8-check headless test above, run via `pnpm --filter @multiplayer-markdown/server run verify:auth`).
- Plugin: `settings.ts` (types), `api-client.ts` (`login`/`fetchRooms` via Obsidian's `requestUrl`), `login-modal.ts`, `settings-tab.ts`, `room-manager.ts` (`RoomManager` — see architecture section above). `main.ts` rewritten to wire settings persistence + `RoomManager` instead of the old hardcoded single-room globals.

**Admin CLI usage** (run from `packages/server`, `DB_PATH` env var controls which SQLite file, defaults to `./data/db/collab.sqlite3`):
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
- For a real VPS, `DOMAIN` needs to be a real DNS name pointing at the VPS's public IP before Caddy can issue a real Let's Encrypt certificate — ports 80/443 need to be open/forwarded. Not yet tested against a real domain or over the public internet, and two real separate devices connecting to a deployed instance hasn't been tried — only same-machine `localhost` so far.

**Design decision: two ports, not one shared HTTP server.** The plan originally called for Express sharing Hocuspocus's HTTP server. Investigated `onRequest` (Hocuspocus's hook for the same underlying `http.Server`) as a way to avoid a second port, but its default request handler unconditionally writes a "Welcome to Hocuspocus" response after hooks run unless the hook throws — and throwing propagates as an unhandled rejection risk. Not worth the fragility for 2 routes. Went with a second plain `node:http` server (`HTTP_API_PORT`, default 4445) instead — no Express dependency needed. Phase 6's Caddy reverse proxy can still expose both under one public domain via path-based routing.

**Note found while building Phase 3 (unrelated pre-existing issue, now fixed):** `packages/server/src/verify-sync.ts` had a type error that only surfaced once `tsc` was run across the whole server package for the first time — `HocuspocusProviderConfiguration` doesn't actually allow `WebSocketPolyfill` alongside a plain `url`, only alongside `websocketProvider`. Tried switching to the "correct" `websocketProvider` shape and it broke the actual connection (client never synced) — so the fix was to keep the original working runtime shape (`url` + `WebSocketPolyfill`) and cast past the overly-strict published type, rather than "fixing" it into a shape that doesn't actually work. If you see this error again, don't restructure the provider construction — just cast.

## Key gotchas discovered (do not re-debug these from scratch)

1. **`registerEditorExtension` doesn't retroactively apply to already-open editors.** Obsidian restores the last-open file *after* plugin `onload()` returns, not before. Fix: `workspace.onLayoutReady()` — but also...
2. **`onLayoutReady()` can be slow or (in edge cases observed directly) never fire.** Never let plugin functionality depend on it without a timeout fallback.
3. **Never dispatch to a CM6 `EditorView` synchronously from inside a `ViewPlugin` constructor.** It runs mid-update; CM6 throws "Calls to EditorView.update are not allowed while an update is in progress" and silently drops the change. Defer with `queueMicrotask`.
4. **`Y.Map.observe()` is shallow — use `observeDeep()`.** A new file is two separate Yjs changes (key added with empty `Y.Text`, then content inserted into it). Shallow `observe()` only fires for the first; the content update needs `observeDeep()`, and the handler must use `event.path` to find nested changes (not just `event.keysChanged`).
5. **Creating a new `Y.Text` entry and inserting its content must be ONE atomic transaction**, or your own change-observer can fire twice (empty, then real) and the two async disk-writes can race and land out of order — this actually happened (a renamed file ended up empty on disk). Always use `setFileContent(doc, path, content)` from `sync-core`, never the raw `getOrCreateFileText` + `reconcileYTextWithContent` two-step.
6. **`onload()` must never block on network/layout conditions.** Obsidian appears to await each plugin's `onload()` during its own startup — an unresolved promise in there (e.g. waiting on an unreachable server with no timeout) hangs *all of Obsidian*, not just the plugin. This actually happened during development. Pattern: `onload()` does synchronous setup only, then kicks off `void this.initializeAfterLoad()` (not awaited) for anything that touches the network or `onLayoutReady`.

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
pnpm --filter @multiplayer-markdown/server run dev               # start dev server: ws://localhost:4444 (Hocuspocus) + http://localhost:4445 (login/rooms API)
pnpm --filter @multiplayer-markdown/plugin run build              # typecheck + esbuild bundle -> main.js
pnpm --filter @multiplayer-markdown/plugin run sync-test-vaults    # copies main.js/manifest.json into test-vaults/vault-a and vault-b
```

`test-vaults/vault-a` and `test-vaults/vault-b` are two throwaway Obsidian vaults (git-ignored territory in spirit, but not actually gitignored — check before committing) used for manual/automated verification. Both have the plugin pre-installed and a `Shared/` folder as the sync target. Open both as separate vaults in Obsidian (or drive them via CDP as described above) to test. `packages/server/data/` is where persisted room files land — gitignored, safe to delete between test runs for a clean slate.

## Next up: Phase 5 — attachments + admin CLI polish

Per the approved plan, Phase 5 covers:

- **Binary attachments** (images, PDFs, etc.) — Yjs isn't suited to large blobs, so these live entirely outside the CRDT layer: plain HTTP upload/download routes on the HTTP API server, content-addressed by hash, gated by the same room-membership check `onAuthenticate` uses (look up membership the same way, just over HTTP instead of the WS handshake). Only lightweight metadata (hash/size/mtime) goes in the room's `Y.Doc` (`attachmentsMeta` map, already reserved in the schema — see Architecture section — but unused so far), so clients know when to fetch an updated binary. The plugin's `FileSyncEngine` currently only handles `.md` files (`file.extension === "md"` filters) — extending it to attachments means detecting non-markdown files in a linked folder and routing them through the new HTTP upload/download path instead of `setFileContent`.
- **Admin CLI polish** — the CLI already exists and works (built in Phase 4, see usage above). "Polish" here likely means things like: better error messages, maybe a `--yes` flag or confirmation prompts for destructive actions (`user delete`), and possibly bundling it as an actual installed binary rather than `npx tsx src/cli.ts`. Re-read the original plan file if available for exact scope; this wasn't fully detailed in the phase-table description.

Things Phase 5 does NOT need to solve (already done in earlier phases): auth/permissions (Phase 4), disk persistence (Phase 3), folder-level markdown sync (Phase 2), live co-editing (Phase 1).
