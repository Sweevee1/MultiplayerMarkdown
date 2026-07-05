# Installing on Unraid (via the GUI)

There's no Community Applications entry for this app (it's not published there), so it isn't a one-click install — but everything below is done through Unraid's web GUI, no SSH required. There are two ways to do it, depending on whether you already run a reverse proxy on your Unraid box.

**Every image is prebuilt and published automatically to GitHub Container Registry** (`ghcr.io/<your-username>/multiplayer-markdown-sync-server`) whenever this repo's `main` branch changes — Unraid just pulls it, it never needs to build anything itself.

## Method A — single container + your existing reverse proxy (recommended)

Most Unraid users already run a reverse proxy container for TLS/domains (Nginx Proxy Manager, SWAG, or Caddy). If that's you, this is the simplest path: one native container, no plugins needed.

1. **Docker tab → Add Container.**
2. Fill in the template manually:
   - **Name:** `multiplayer-markdown`
   - **Repository:** `ghcr.io/<your-username>/multiplayer-markdown-sync-server:latest`
   - **Network Type:** `bridge`
   - **Port mappings** (container → host, pick any free host ports):
     - `4444` → `4444` (WebSocket / CRDT protocol)
     - `4445` → `4445` (HTTP login/rooms/attachments API)
   - **Path mappings** (container → host — use your appdata share):
     - `/data/db` → `/mnt/user/appdata/multiplayer-markdown/db`
     - `/data/vaults` → `/mnt/user/appdata/multiplayer-markdown/vaults`
     - `/data/attachments` → `/mnt/user/appdata/multiplayer-markdown/attachments`
   - **Environment variables:**
     - `JWT_SECRET` → a long random value. Generate one with Unraid's built-in web terminal (the `>_` icon top-right of the GUI): `openssl rand -hex 32`.
     - (Optional, defaults shown) `PORT=4444`, `HTTP_API_PORT=4445`, `DB_PATH=/data/db/collab.sqlite3`, `VAULTS_ROOT=/data/vaults`, `ATTACHMENTS_ROOT=/data/attachments`.
3. **Apply**, and confirm the container starts (Docker tab → check its log icon — you should see `Hocuspocus ... running` and `HTTP API listening`).
4. In your reverse proxy, add two routes to `multiplayer-markdown` (or the Unraid box's IP) on the ports above, matching this repo's [`Caddyfile`](../Caddyfile):
   - `/api/*` → port `4445` (plain HTTP proxy, no websocket needed)
   - everything else (`/`) → port `4444`, **with WebSocket support enabled** — this is the CRDT protocol; it must stay a persistent connection, not be buffered/cached.

   In Nginx Proxy Manager specifically: create a proxy host for your domain, forward to the catch-all rule (port 4444) with "Websockets Support" toggled on, then add a custom Nginx location block for `/api/` pointing at port 4445.

## Method B — full stack (bundles Caddy for automatic TLS)

If you don't already have a reverse proxy and would rather deploy the exact same two-container stack as the repo's `docker-compose.yml` (sync-server + Caddy with automatic HTTPS), install the **Compose Manager** plugin first:

1. **Apps tab** (Community Applications) → search **"Compose Manager"** (by dcflachs) → **Install**.
2. A new **Compose Manager** tab appears (usually under **Settings**, or its own top-level tab). Click **Add New Stack**, name it `multiplayer-markdown`.
3. Open the stack's compose editor and paste:

   ```yaml
   name: multiplayer-markdown

   services:
     sync-server:
       image: ghcr.io/<your-username>/multiplayer-markdown-sync-server:latest
       restart: unless-stopped
       environment:
         - JWT_SECRET=${JWT_SECRET:?set JWT_SECRET in this stack's .env}
         - PORT=4444
         - HTTP_API_PORT=4445
         - VAULTS_ROOT=/data/vaults
         - DB_PATH=/data/db/collab.sqlite3
         - ATTACHMENTS_ROOT=/data/attachments
       volumes:
         - /mnt/user/appdata/multiplayer-markdown/db:/data/db
         - /mnt/user/appdata/multiplayer-markdown/vaults:/data/vaults
         - /mnt/user/appdata/multiplayer-markdown/attachments:/data/attachments
       expose:
         - "4444"
         - "4445"

     caddy:
       image: caddy:2
       restart: unless-stopped
       ports:
         - "80:80"
         - "443:443"
       environment:
         - DOMAIN=${DOMAIN:-localhost}
       volumes:
         - /mnt/user/appdata/multiplayer-markdown/Caddyfile:/etc/caddy/Caddyfile:ro
         - /mnt/user/appdata/multiplayer-markdown/caddy-data:/data
         - /mnt/user/appdata/multiplayer-markdown/caddy-config:/config
       depends_on:
         - sync-server
   ```

4. Set the stack's environment variables (Compose Manager has a `.env` editor per stack — same GUI, no SSH): `JWT_SECRET` (generate with `openssl rand -hex 32` from Unraid's built-in web terminal) and `DOMAIN` (your real domain for a real deployment, or `localhost` to test locally).
5. Create the Caddyfile Compose Manager will mount: in the stack's file manager (each stack has a small file-editor view for files alongside its compose.yml), create `/mnt/user/appdata/multiplayer-markdown/Caddyfile` with the exact contents of this repo's [`Caddyfile`](../Caddyfile).
6. Start the stack. Same log check as Method A, plus confirm the `caddy` container logs show `certificate obtained successfully`.
7. Port-forward 80/443 on your router to the Unraid box, and point `DOMAIN`'s DNS A record at your public IP, before Caddy can issue a real Let's Encrypt certificate. For local-only testing, leave `DOMAIN=localhost` — Caddy self-signs automatically.

## Creating your first user (both methods)

This one step is a CLI command, but it's run entirely through Unraid's GUI — no SSH:

1. **Docker tab** → click the `multiplayer-markdown` (or `sync-server`) container's icon → **Console**. This opens a web-based terminal directly inside the running container.
2. Run:
   ```
   node dist/cli.js user add <username> --password <password> --admin
   ```
3. See the main [README](../README.md#admin-cli) for the rest of the CLI (creating rooms, granting viewer/editor access, revoking users).

Then install the Obsidian plugin on each device as described in the [README](../README.md#installing-the-obsidian-plugin). In the plugin's settings tab, set:
- **WebSocket URL** → `wss://<your-domain>` (Method A: your reverse proxy's WS-enabled route; Method B: Caddy's domain)
- **API URL** → `https://<your-domain>` (same domain — the plugin appends `/api/...` itself; Method A's `/api/*` proxy rule handles the routing)
