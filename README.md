<p align="center">
  <img src="./assets/icon.png" width="120" alt="Multiplayer Markdown icon">
</p>

# Multiplayer Markdown

Live, Google-Docs-style co-editing for [Obsidian](https://obsidian.md) notes, minus the subscription and the vendor lock-in. Your notes stay as plain `.md` files on a machine you control, not trapped in someone else's database.

A few people can type in the same note at once and watch each other's cursors move in real time. It runs on hardware you own (a home server, a NAS, a cheap VPS), so there's no subscription and no company reading your notes. Folder-level permissions decide who can view versus edit, and there's no public sign-up page: an admin adds every account through a simple web page.

This guide assumes you've never set up a self-hosted app before. If you get stuck on a step, that's a bug in the guide, not you. The deeper technical background (how it's built, why certain decisions were made) lives in [CLAUDE.md](./CLAUDE.md), kept separate so it doesn't clutter this page.

## What you'll need

- A computer that can stay on and be reachable — a home server, a NAS (e.g. Unraid), or a rented VPS.
- [Docker](https://www.docker.com/) installed on that computer.
- Obsidian installed on every device that will edit notes.

Below, you'll set up two pieces: the server, which runs once on your always-on machine, and the Obsidian plugin, which each person installs on their own device.

## Step 1: Set up the server

Pick the section that matches your setup. If you're not sure, go with **Option A** — it's the easiest for most home setups, and it needs no port forwarding on your router at all.

### Option A — Cloudflare Tunnel (recommended: no port forwarding, no certificates to manage)

This option assumes you already have Cloudflare's tunnel connector (`cloudflared`) running as its own thing — for example, Unraid's "Cloudflare Network Tunnel" app from Community Apps, or a `cloudflared` container you set up separately. This project doesn't run `cloudflared` for you; it just needs to give your tunnel exactly one address to point at.

The app itself needs two internal ports (a websocket port and a separate HTTP API port — see [CLAUDE.md](./CLAUDE.md) if you're curious why), so this repo publishes a single all-in-one image with a small internal Caddy already baked in to merge both into one port. Your tunnel only ever needs one route pointed at one address — no juggling two ports, no risk of the "two rules under one hostname" bug some Cloudflare dashboard flows have.

**If you're on Unraid**, use the web interface directly — no Docker Compose needed:
1. Go to the **Docker** tab → **Add Container**, and fill in:
   - **Name:** `Multiplayer Markdown`
   - **Repository:** `ghcr.io/sweevee1/multiplayer-markdown:latest`
   - **Network Type:** `bridge`
   - **Port mappings:** one — container `8080` → any free port on your Unraid box
   - **Path mappings:**
     - `/data/db` → `/mnt/user/appdata/multiplayer-markdown/db`
     - `/data/vaults` → `/mnt/user/appdata/multiplayer-markdown/vaults`
     - `/data/attachments` → `/mnt/user/appdata/multiplayer-markdown/attachments`
   - **Environment variables:**
     - `JWT_SECRET` — a random value used internally for security. Open Unraid's built-in terminal (the `>_` icon top-right), run `openssl rand -hex 32`, and paste the result in.
     - `ADMIN_USERNAME` and `ADMIN_PASSWORD` — pick a username and password for your own account now. The server creates it as an admin the first time it starts — no terminal needed to create your account.
2. **Apply**, then check the container's log — you should see both the server and Caddy start up.
3. In your Cloudflare Tunnel app (Zero Trust dashboard → your tunnel → **Routes** → **Add route → Published application**), set: your domain, no path (catch-all), Service `HTTP`, URL `http://<your-unraid-LAN-IP>:<the port you mapped>`.
4. That's it — one container, one port, one route. Move on to Step 2.

**If you're on any other Docker host**, run the same image directly:
```bash
docker run -d --name multiplayer-markdown --restart unless-stopped \
  -p 8080:8080 \
  -e JWT_SECRET=$(openssl rand -hex 32) \
  -e ADMIN_USERNAME=youruser \
  -e ADMIN_PASSWORD=your-password \
  -v ./data/db:/data/db \
  -v ./data/vaults:/data/vaults \
  -v ./data/attachments:/data/attachments \
  ghcr.io/sweevee1/multiplayer-markdown:latest
```
Then point your tunnel's route at `http://<this-machine's-LAN-IP>:8080`. Move on to Step 2.

### Option B — Docker Compose with a built-in address helper (any Linux/Mac/Windows machine with Docker)

Use this if you'd rather skip Cloudflare. It gets you a working `https://` address on its own, but you'll need to forward ports 80 and 443 to this machine on your router if you want it reachable outside your home network.

1. Get the project files onto your server:
   ```bash
   git clone https://github.com/Sweevee1/MultiplayerMarkdown.git
   cd MultiplayerMarkdown
   ```
2. Copy the example settings file so you can edit it:
   ```bash
   cp .env.example .env
   ```
3. Open `.env` in a text editor and fill in:
   - `JWT_SECRET` — a random value used internally for security. Generate one by running `openssl rand -hex 32` and pasting the result in.
   - `DOMAIN` — the web address people will use to reach this (e.g. `notes.example.com`). If you're just trying it out on your own computer, leave this as `localhost`.
   - `ADMIN_USERNAME` / `ADMIN_PASSWORD` — pick a username and password for your own account. The server creates it as an admin the first time it starts, so you don't need to run any command to create your first account.
4. Start everything:
   ```bash
   docker compose up --build -d
   ```
   This starts two things: the server itself, and a helper that handles the `https://` lock icon automatically.
5. Check that it worked:
   ```bash
   curl -k -X POST https://localhost/api/login -H "Content-Type: application/json" -d '{"username":"test","password":"test"}'
   ```
   You don't have an account yet, so this should say your login is wrong, not that it can't connect at all. That means the server is up. Move on to Step 2.

### Option C — Unraid (using only the web interface, no command line)

There's no one-click app for this yet, so you'll fill in a container by hand. Takes about five minutes.

1. Go to the **Docker** tab in Unraid, and click **Add Container**.
2. Fill in the form:
   - **Name:** `multiplayer-markdown`
   - **Repository:** `ghcr.io/sweevee1/multiplayer-markdown-sync-server:latest`
   - **Network Type:** `bridge`
   - **Port mappings** — add two, container port on the left, any free port on your Unraid box on the right (skip this entirely if you're using Cloudflare Tunnel — see step 4 below, that path doesn't use this standalone container at all):
     - `4444` → `4444`
     - `4445` → `4445`
   - **Path mappings** — add three, so your data is saved to Unraid's disk instead of disappearing if the container restarts:
     - `/data/db` → `/mnt/user/appdata/multiplayer-markdown/db`
     - `/data/vaults` → `/mnt/user/appdata/multiplayer-markdown/vaults`
     - `/data/attachments` → `/mnt/user/appdata/multiplayer-markdown/attachments`
   - **Environment variables:**
     - `JWT_SECRET` — a random value used internally for security. Open Unraid's built-in terminal (the `>_` icon top-right), run `openssl rand -hex 32`, and paste the result in here.
     - `ADMIN_USERNAME` / `ADMIN_PASSWORD` — pick a username and password for your own account now, and the server creates it as an admin the first time it starts.
3. Click **Apply**, then check the container's log (click its icon in the Docker tab). It should say it's running.
4. Now make it reachable from outside your network. Pick one:
   - **Cloudflare Tunnel** (recommended, no port forwarding): don't use this standalone container for this path — delete it and follow **Option A** above instead. That option uses a different, single-port image purpose-built for Cloudflare Tunnel, so there's only one port to map and one route to configure.
   - **An existing reverse proxy** (Nginx Proxy Manager, SWAG, Caddy, etc.): point it at this container with two rules — addresses starting with `/api/` go to port `4445`, everything else goes to port `4444`, with "websocket support" turned on (this is what makes the live typing work; without it, the app connects but edits never sync). In Nginx Proxy Manager: create a proxy host for your domain pointing at port `4444` with "Websockets Support" switched on, then add a custom location block for `/api/` pointing at port `4445`.
   - **Neither of the above yet**: install the **Compose Manager** app from Unraid's Apps tab, and see [docs/unraid-compose.md](./docs/unraid-compose.md#option-b-your-own-https-address-bundled-stack) for a copy-paste stack that bundles its own `https://` helper.
5. If you set `ADMIN_USERNAME`/`ADMIN_PASSWORD` above, that's your account — skip ahead to Step 2. Otherwise, create your first account by opening a console inside the container: **Docker tab → click the container's icon → Console**, then run the command from Step 2 below.

## Step 2: Create your account and a room

If you set `ADMIN_USERNAME`/`ADMIN_PASSWORD` in Step 1, that account already exists — no commands to run. Go to `https://<your-domain>/api/admin` (or `http://localhost:4445/api/admin` for local testing) and log in.

From that page, use the **Add user** form to create accounts for everyone else, and the **Create room** form to make a shared folder, then use **Manage members** on that room to grant people `viewer` or `editor` access. Everything from here on — adding people, creating rooms, granting/revoking access — happens on this page; nobody needs a terminal.

**If you didn't set `ADMIN_USERNAME`/`ADMIN_PASSWORD`**, you'll need to create your first account once via the CLI (in Docker Compose, prefix commands with `docker compose exec sync-server`; in Unraid, run them in the container's Console), then use the web UI for everything after that:
```
node dist/cli.js user add <your-username> --password <a-strong-password> --admin
```
The [full CLI command list](#every-admin-command) below still works too, if you'd rather script things than click through the UI.

## Step 3: Install the Obsidian plugin

The plugin isn't in Obsidian's official plugin store yet. The easiest way to install it (and get automatic updates) is **BRAT**, a community plugin made for exactly this:

1. In Obsidian: **Settings → Community plugins → Browse**, search for **BRAT** (full name "Obsidian42 - BRAT"), install it, and enable it.
2. Open BRAT's settings (or run the command **BRAT: Add a beta plugin for testing** from the command palette).
3. Paste in this repo's address: `Sweevee1/MultiplayerMarkdown`, and confirm.
4. BRAT downloads and installs the plugin automatically. Go to **Settings → Community plugins** and enable **Multiplayer Markdown**.
5. From here on, BRAT checks for new releases and can update the plugin for you — no manual re-downloading.

**If you'd rather not use BRAT**, you can install it by hand instead: download `main.js` and `manifest.json` from a [release](../../releases) (or build them yourself — see [CLAUDE.md](./CLAUDE.md)), create a folder at `.obsidian/plugins/multiplayer-markdown/` in your vault, and put both files in it. Then enable it the same way in **Settings → Community plugins**.

Either way, once it's enabled:
1. Open the plugin's settings and fill in:
   - **WebSocket URL** — `wss://<your-domain>` (or `ws://localhost:4444` if you're just testing on your own machine)
   - **API URL** — `https://<your-domain>` (or `http://localhost:4445` for local testing)
2. Log in with the username and password from Step 2.
3. Link your room to a local folder in the vault: pick the room you created, pick a folder, and you're live.

Repeat Step 3 on every device or vault you want in on the action. Viewers can read and watch edits happen live but can't type; editors get full co-editing.

## Every admin command

Run these the same way you ran the commands in Step 2, inside the server or container.

```
user add <username> --password <pw> [--admin]     # create an account
user list                                          # list all accounts
user revoke <username>                             # instantly log this user out everywhere
user delete <username>                             # delete an account
room create <roomId> [--label <label>]             # create a shared folder
room list                                          # list all shared folders
room members <roomId>                              # see who has access to a room
room grant <roomId> <username> <viewer|editor>     # give someone access
room revoke <roomId> <username>                    # remove someone's access
```

## Something not working?

- **Nothing loads at all**: check the server's logs for errors. If you're using Cloudflare Tunnel, also check the tunnel's status in the Zero Trust dashboard, which should say "Healthy." On a reverse proxy, make sure the ports you mapped are actually reachable and not blocked by a firewall.
- **Your domain redirects somewhere unexpected instead of reaching the app** (e.g. to a URL shortener or a "domain for sale" page): this usually isn't anything in this project — it's a leftover redirect from before the domain pointed at Cloudflare, often set by your registrar. In the Cloudflare dashboard, check **Rules → Redirect Rules** *and* **Rules → Bulk Redirects** *and* **Page Rules** — these are three separate features and it's easy to only check one.
- **You linked a room to a folder but nothing syncs, with no error anywhere**: double check the folder field in the plugin's settings — it needs to be the folder's path *relative to your vault* (e.g. `Shared` or `Notes/Team`), not a full path copied from your file explorer (e.g. not `C:\Users\you\Documents\MyVault\Shared`). Retype it by hand if you're not sure, then click away from the field to save.
- **You can connect and log in, but edits don't show up for the other person**: this is almost always a websocket setting on whatever sits in front of the app. On a reverse proxy, make sure "websocket support" is switched on. On Cloudflare Tunnel (Option A's all-in-one image), check the container's logs for both a `node` startup line and a Caddy startup line — if only one shows up, the other process failed to start.
- **Rooms and users disappear after a while, but your admin account keeps coming back**: this was a real bug in images built before this note was added — the app defaulted to writing its database and files inside the container itself instead of the mounted `/data/...` volumes, so anything not recreated by `ADMIN_USERNAME`/`ADMIN_PASSWORD` on boot was lost the next time the container got recreated (e.g. an image update). Pull the latest image to get the fix. If you already lost data this way, it isn't recoverable from the old container — just recreate the affected users and rooms once on the fixed image.
- Still stuck, or curious *why* something is built the way it is? See [CLAUDE.md](./CLAUDE.md).

## License

[MIT](./LICENSE)
