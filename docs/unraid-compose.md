# Unraid: bundled stack for your own HTTPS domain (Compose Manager)

If you're using Cloudflare Tunnel, you don't need this page or Compose Manager at all — see the main [README](../README.md)'s Option A, which is a single container you add directly through Unraid's Docker tab.

This page is for Unraid users who want their own real `https://` domain (own cert, own DNS) without Cloudflare Tunnel and without already running a reverse proxy like Nginx Proxy Manager, SWAG, or Caddy.

## Bundled stack

This needs the **Compose Manager** app first: **Apps tab** (Community Applications) → search **"Compose Manager"** (by dcflachs) → **Install**. A new **Compose Manager** tab then appears (usually under **Settings**).

It deploys the same two-container setup as this repo's `docker-compose.yml` — the app itself, plus a helper that gives you automatic `https://`.

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
