# Multiplayer Markdown

Self-hosted, real-time collaborative editing for [Obsidian](https://obsidian.md) vaults — with real per-folder permissions.

There are plenty of Obsidian sync/collab tools out there. None of them combine all of the following, which is why this exists:

- **Real Obsidian vaults.** Your notes stay as plain `.md` files on disk — no proprietary database, no lock-in.
- **True live co-editing**, not background sync. Multiple people can type in the same note at the same time (CRDT-based, via [Yjs](https://github.com/yjs/yjs)/[Hocuspocus](https://tiptap.dev/hocuspocus)), with live cursors.
- **Self-hosted**, on your own VPS or home server via Docker. No subscription, no per-user pricing, no artificial caps.
- **Real per-folder permissions.** Each top-level shared folder is its own "room" with its own viewer/editor member list — enforced server-side, not just hidden in the UI.
- **Simple admin-managed accounts.** An admin creates users and grants access via a CLI. No public signup.

## How it works

```
┌─────────────┐        WebSocket (CRDT)        ┌──────────────────────┐
│  Obsidian    │ ─────────────────────────────▶ │   Sync server        │
│  + plugin    │        HTTPS (login, files)     │  (Hocuspocus + auth) │
└─────────────┘ ◀───────────────────────────── └──────────┬───────────┘
                                                            │
                                                   persists to disk
                                                            │
                                                   ┌────────▼────────┐
                                                   │ .md files, SQLite│
                                                   │ (users/rooms/DB) │
                                                   └──────────────────┘
```

One [Yjs](https://github.com/yjs/yjs) document per shared folder ("room"). The server hydrates each room from real markdown files on disk, applies live edits, and persists changes back — so the files on the server are always plain, readable `.md`, never a proprietary blob. A small Obsidian plugin handles live co-editing for whichever note is open, plus create/rename/delete sync for everything else in a linked folder.

Full architecture and implementation notes are in [CLAUDE.md](./CLAUDE.md) if you want the details.

## Status

Core functionality is built and verified: accounts, per-room viewer/editor permissions (enforced server-side), live co-editing, folder sync, binary attachments, and Docker packaging. This is a young, self-built project — treat it as beta-quality. See the phase table in [CLAUDE.md](./CLAUDE.md#current-status-phases-0-6-done-and-verified) for exact status.

Known gap: JWTs are long-lived (24h) rather than using rotating refresh tokens — a UX nicety, not a security hole (see CLAUDE.md for why).

## Quick start (Docker Compose)

Requires Docker with Compose v2.

```bash
git clone https://github.com/Sweevee1/MultiplayerMarkdown.git
cd MultiplayerMarkdown
cp .env.example .env
```

Edit `.env`:
- `JWT_SECRET` — generate a real one: `openssl rand -hex 32`
- `DOMAIN` — a real domain name for a real deployment, or leave as `localhost` to try it out locally (Caddy will issue a self-signed cert automatically).

Then:

```bash
docker compose up --build -d
```

This starts two containers:
- `sync-server` — the Hocuspocus/auth/HTTP API server (not exposed directly; only reachable through Caddy)
- `caddy` — reverse proxy + automatic TLS, listening on ports 80/443

Create your first user:

```bash
docker compose exec sync-server node dist/cli.js user add <username> --password <password> --admin
```

Check it's up:

```bash
curl -k -X POST https://localhost/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"<username>","password":"<password>"}'
```

A `200` response with a JWT means the server, auth, and TLS proxy are all working end to end.

Looking to run this on Unraid instead of the command line? See [docs/unraid.md](./docs/unraid.md).

### Admin CLI

Run from inside the container (`docker compose exec sync-server node dist/cli.js ...`), or directly with `npx tsx src/cli.ts ...` if running the server from source:

```
user add <username> --password <pw> [--admin]
user list
user revoke <username>      # invalidates all of that user's sessions immediately
user delete <username>
room create <roomId> [--label <label>]
room list
room members <roomId>
room grant <roomId> <username> <viewer|editor>
room revoke <roomId> <username>
```

## Installing the Obsidian plugin

The plugin isn't (yet) in Obsidian's community plugin store, so it's a manual install:

1. Build it from source (see [Development](#development) below), or grab `main.js` + `manifest.json` from a [release](../../releases) if one is published.
2. In your vault, create the folder `.obsidian/plugins/multiplayer-markdown/` and copy `main.js` and `manifest.json` into it.
3. In Obsidian: **Settings → Community plugins** → enable community plugins → enable **Multiplayer Markdown**.
4. Open the plugin's settings tab and set **WebSocket URL** / **API URL** to point at your server (defaults are `ws://localhost:4444` / `http://localhost:4445` for local dev; for a real deployment behind Caddy/a reverse proxy, use `wss://<your-domain>` / `https://<your-domain>` — see [docs/unraid.md](./docs/unraid.md) if self-hosting on Unraid).
5. Log in with your username/password, then link a room to a local folder.

Repeat on each device/vault that should participate in a room. A viewer can read and see live edits but can't write; an editor gets full live co-editing.

## Development

```bash
pnpm install
pnpm --filter @multiplayer-markdown/server run dev     # ws://localhost:4444 + http://localhost:4445
pnpm --filter @multiplayer-markdown/plugin run build    # -> packages/plugin/main.js
```

See [CLAUDE.md](./CLAUDE.md) for the full architecture, dev workflow, verification scripts, and a running list of gotchas discovered along the way.

## License

[MIT](./LICENSE)
