import * as path from "node:path";
import { Server } from "@hocuspocus/server";
import { hydrateRoomFromDisk, writeRoomToDisk } from "./persistence.js";
import { openDb } from "./db.js";
import { createOnAuthenticate } from "./auth.js";
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
