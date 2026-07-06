# Unraid: bundled stacks (Compose Manager)

Both stacks below need the **Compose Manager** app first: **Apps tab** (Community Applications) → search **"Compose Manager"** (by dcflachs) → **Install**. A new **Compose Manager** tab then appears (usually under **Settings**).

Pick the section that matches how you're exposing the app. If you already followed the main [README](../README.md) and picked Option B or an existing reverse proxy, use the section for that; if you're on Cloudflare Tunnel, use that section instead.

## Option A: Cloudflare Tunnel bundled stack

This runs the app, an internal Caddy (splits traffic between the app's two internal ports), and `cloudflared` itself together on one Docker network — so they resolve each other by container name automatically, and Cloudflare only ever needs **one** rule pointed at one container. This avoids exposing any LAN ports and avoids a real Cloudflare dashboard bug that appears when you try to add a second path-based rule under the same tunnel hostname.

1. In **Compose Manager**, click **Add New Stack**, name it `multiplayer-markdown`.
2. Open the stack's compose editor and paste:

   ```yaml
   name: multiplayer-markdown

   services:
     sync-server:
       image: ghcr.io/sweevee1/multiplayer-markdown-sync-server:latest
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

     caddy-tunnel:
       image: caddy:2
       restart: unless-stopped
       volumes:
         - /mnt/user/appdata/multiplayer-markdown/Caddyfile.tunnel:/etc/caddy/Caddyfile:ro
         - /mnt/user/appdata/multiplayer-markdown/caddy-tunnel-data:/data
         - /mnt/user/appdata/multiplayer-markdown/caddy-tunnel-config:/config
       depends_on:
         - sync-server

     cloudflared:
       image: cloudflare/cloudflared:latest
       restart: unless-stopped
       command: tunnel run
       environment:
         - TUNNEL_TOKEN=${TUNNEL_TOKEN:?paste the token Cloudflare showed you}
       depends_on:
         - caddy-tunnel
   ```

3. This stack has its own `.env` editor (same GUI, no command line). Set:
   - `JWT_SECRET` — generate with `openssl rand -hex 32` from Unraid's built-in terminal (the `>_` icon top-right).
   - `TUNNEL_TOKEN` — go to the [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/) → **Networks → Tunnels → Create a tunnel** → pick **Docker** as the connector type, and copy the token shown (the long string after `--token` in the example command). You don't need to run that command anywhere — this stack runs `cloudflared` for you.
4. Create the file the stack needs at `/mnt/user/appdata/multiplayer-markdown/Caddyfile.tunnel`, with the exact contents of this repo's [`Caddyfile.tunnel`](../Caddyfile.tunnel).
5. Start the stack. Check the `sync-server` and `cloudflared` logs — `cloudflared` should say the connection registered successfully, and in the Zero Trust dashboard the tunnel's status should turn **Healthy**.
6. Back in the Zero Trust dashboard, add **one** Public Hostname to the tunnel: your domain, no path (catch-all), Service `HTTP`, URL `caddy-tunnel:8080`.

Once it's running, go back to the main [README](../README.md#step-2-create-your-account) to create your account and install the Obsidian plugin.

## Option B: your own `https://` address, bundled stack

This is for Unraid users who don't want to use Cloudflare Tunnel and don't already run a reverse proxy like Nginx Proxy Manager, SWAG, or Caddy. It deploys the same two-container setup as this repo's `docker-compose.yml` — the app itself, plus a helper that gives you automatic `https://`.

1. In **Compose Manager**, click **Add New Stack**, name it `multiplayer-markdown`.
2. Open the stack's compose editor and paste:

   ```yaml
   name: multiplayer-markdown

   services:
     sync-server:
       image: ghcr.io/sweevee1/multiplayer-markdown-sync-server:latest
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

3. This stack has its own `.env` editor (same GUI, no command line). Set:
   - `JWT_SECRET` — generate with `openssl rand -hex 32` from Unraid's built-in terminal (the `>_` icon top-right).
   - `DOMAIN` — your real domain name for a real deployment, or `localhost` to just try it out locally.
4. Create the file the stack needs at `/mnt/user/appdata/multiplayer-markdown/Caddyfile`, with the exact contents of this repo's [`Caddyfile`](../Caddyfile).
5. Start the stack. Check the `sync-server` log for a "running" message, and the `caddy` log for "certificate obtained successfully".
6. If you're using a real domain (not `localhost`): forward ports 80 and 443 on your router to your Unraid box, and point your domain's DNS at your home internet's public IP. Without this, Caddy can't get a real certificate — `localhost` skips this entirely and self-signs one automatically.

Once it's running, go back to the main [README](../README.md#step-2-create-your-account) to create your account and install the Obsidian plugin.
