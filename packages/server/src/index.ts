import * as path from "node:path";
import type Database from "better-sqlite3";
import { Server } from "@hocuspocus/server";
import { hydrateRoomFromDisk, writeRoomToDisk } from "./persistence.js";
import { openDb, getUserByUsername, createUser } from "./db.js";
import { createOnAuthenticate, hashPassword } from "./auth.js";
import { createHttpApiServer } from "./http-api.js";

const port = Number(process.env.PORT ?? 4444);
const httpApiPort = Number(process.env.HTTP_API_PORT ?? 4445);
const vaultsRoot = path.resolve(process.env.VAULTS_ROOT ?? "./data/vaults");
const dbPath = path.resolve(process.env.DB_PATH ?? "./data/db/collab.sqlite3");
const attachmentsRoot = path.resolve(process.env.ATTACHMENTS_ROOT ?? "./data/attachments");

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  console.warn(
    "[server] WARNING: JWT_SECRET is not set. Using an insecure development-only default. " +
      "Set JWT_SECRET in production — anyone who knows the default can forge tokens for any user."
  );
}
const resolvedJwtSecret = jwtSecret ?? "insecure-development-only-secret-do-not-use-in-production";

const db = openDb(dbPath);

/**
 * Optional zero-terminal bootstrap: if ADMIN_USERNAME/ADMIN_PASSWORD are set
 * (e.g. as Docker env vars in Unraid's Add Container form), create that
 * admin account on startup — but only if it doesn't already exist, so it's
 * safe to leave these set permanently across restarts without silently
 * resetting the password each time. The CLI (`user add ... --admin`)
 * remains available for anyone who prefers it.
 */
async function bootstrapAdminFromEnv(db: Database.Database): Promise<void> {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) return;

  if (getUserByUsername(db, username)) {
    console.log(`[server] ADMIN_USERNAME "${username}" already exists — leaving the existing account untouched`);
    return;
  }

  const passwordHash = await hashPassword(password);
  createUser(db, username, passwordHash, true);
  console.log(`[server] Created admin user "${username}" from ADMIN_USERNAME/ADMIN_PASSWORD`);
}

await bootstrapAdminFromEnv(db);

const server = new Server({
  port,
  onAuthenticate: createOnAuthenticate(db, resolvedJwtSecret),
  async onConnect() {
    console.log("[server] client connected");
  },
  async onDisconnect() {
    console.log("[server] client disconnected");
  },
  async onLoadDocument({ documentName, document }) {
    await hydrateRoomFromDisk(documentName, document, vaultsRoot);
  },
  async onStoreDocument({ documentName, document }) {
    await writeRoomToDisk(documentName, document, vaultsRoot);
  },
});

server.listen().then(() => {
  console.log(`[server] Hocuspocus listening on ws://localhost:${port}`);
  console.log(`[server] persisting rooms under ${vaultsRoot}`);
  console.log(`[server] database at ${dbPath}`);
});

createHttpApiServer({ db, jwtSecret: resolvedJwtSecret, attachmentsRoot }).listen(httpApiPort, () => {
  console.log(`[server] HTTP API listening on http://localhost:${httpApiPort}`);
  console.log(`[server] storing attachments under ${attachmentsRoot}`);
});
