/**
 * Headless verification of the actual security boundary: onAuthenticate.
 * Creates two real users with different roles on the same room, connects
 * as each over a real WebSocket with a real signed JWT, and confirms:
 *   1. The editor's writes are applied to the shared document.
 *   2. The viewer's writes are silently rejected SERVER-SIDE (not just
 *      hidden client-side) — proven by checking the editor's copy of the
 *      document never receives the viewer's attempted edit.
 *   3. A user with no membership on the room is refused the connection
 *      outright (never reaches "synced").
 *   4. Revoking a user's token (bumping token_version) invalidates their
 *      existing JWT immediately, without needing to wait for it to expire.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Server } from "@hocuspocus/server";
import { HocuspocusProvider } from "@hocuspocus/provider";
import type { HocuspocusProviderConfiguration } from "@hocuspocus/provider";
import WebSocket from "ws";
import { roomDocumentName } from "@multiplayer-markdown/sync-core";
import { openDb, createUser, createRoom, grantRoomAccess, bumpTokenVersion } from "./db.js";
import { hashPassword, signJwt, createOnAuthenticate } from "./auth.js";

const PORT = 4498;
const JWT_SECRET = "test-secret-only-for-verification";
const ROOM_ID = "verify-auth-room";
const DOCUMENT_NAME = roomDocumentName(ROOM_ID);

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    console.error(`[verify] FAIL: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    process.exitCode = 1;
  } else {
    console.log(`[verify] OK: ${label}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeClient(token: string, onAuthFailed?: () => void): HocuspocusProvider {
  const options = {
    url: `ws://127.0.0.1:${PORT}`,
    name: DOCUMENT_NAME,
    token,
    WebSocketPolyfill: WebSocket as unknown,
    onAuthenticationFailed: onAuthFailed,
  } as unknown as HocuspocusProviderConfiguration;
  return new HocuspocusProvider(options);
}

function waitForSynced(provider: HocuspocusProvider, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    if (provider.isSynced) return resolve(true);
    const timer = setTimeout(() => resolve(false), timeoutMs);
    provider.on("synced", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function main() {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "multiplayer-markdown-auth-test-"));
  const db = openDb(path.join(dbDir, "test.sqlite3"));

  const alicePasswordHash = await hashPassword("alice-password");
  const bobPasswordHash = await hashPassword("bob-password");
  const eveHash = await hashPassword("eve-password");
  const alice = createUser(db, "alice", alicePasswordHash); // editor
  const bob = createUser(db, "bob", bobPasswordHash); // viewer
  const eve = createUser(db, "eve", eveHash); // NOT a member of the room at all

  createRoom(db, ROOM_ID, "Verify Auth Room");
  grantRoomAccess(db, ROOM_ID, alice.id, "editor");
  grantRoomAccess(db, ROOM_ID, bob.id, "viewer");

  const server = new Server({ port: PORT, onAuthenticate: createOnAuthenticate(db, JWT_SECRET) });
  await server.listen();
  console.log(`[verify] server listening on ${PORT}`);

  const aliceToken = signJwt({ sub: alice.id, tokenVersion: alice.token_version }, JWT_SECRET);
  const bobToken = signJwt({ sub: bob.id, tokenVersion: bob.token_version }, JWT_SECRET);
  const eveToken = signJwt({ sub: eve.id, tokenVersion: eve.token_version }, JWT_SECRET);

  // --- Test 1 & 2: editor writes succeed, viewer writes are dropped server-side ---
  const aliceClient = makeClient(aliceToken);
  const bobClient = makeClient(bobToken);

  await Promise.all([waitForSynced(aliceClient), waitForSynced(bobClient)]);
  assertEqual(aliceClient.isSynced, true, "editor (alice) connection is accepted and syncs");
  assertEqual(bobClient.isSynced, true, "viewer (bob) connection is accepted and syncs (can read)");

  const aliceText = aliceClient.document.getText("content");
  const bobText = bobClient.document.getText("content");

  aliceText.insert(0, "Written by editor alice. ");
  await sleep(500);
  assertEqual(bobText.toString(), "Written by editor alice. ", "viewer receives the editor's write");

  // Viewer attempts to write — this must be rejected server-side, not just
  // hidden in the UI. We check ALICE's copy (not bob's own) to prove the
  // rejection happened at the server, not merely that bob's client chose
  // not to display it.
  bobText.insert(bobText.length, "Written by viewer bob — should NOT appear for alice.");
  await sleep(500);
  assertEqual(
    aliceText.toString(),
    "Written by editor alice. ",
    "viewer's write never reaches the editor's document — rejected server-side"
  );

  // --- Test 3: non-member is refused the connection outright ---
  let eveAuthFailed = false;
  const eveClient = makeClient(eveToken, () => {
    eveAuthFailed = true;
  });
  const eveSynced = await waitForSynced(eveClient, 2000);
  assertEqual(eveSynced, false, "non-member (eve) never reaches synced state");
  assertEqual(eveAuthFailed, true, "non-member (eve) connection triggers onAuthenticationFailed");

  // --- Test 4: revoking a token invalidates it immediately ---
  bumpTokenVersion(db, alice.id);
  let revokedAuthFailed = false;
  const revokedAliceClient = makeClient(aliceToken, () => {
    revokedAuthFailed = true;
  }); // same (now-stale) token
  const revokedSynced = await waitForSynced(revokedAliceClient, 2000);
  assertEqual(revokedSynced, false, "revoked token is rejected even though it hasn't expired");
  assertEqual(revokedAuthFailed, true, "revoked token triggers onAuthenticationFailed");

  aliceClient.destroy();
  bobClient.destroy();
  eveClient.destroy();
  revokedAliceClient.destroy();
  await server.destroy();
  db.close(); // release the SQLite WAL files before deleting the directory
  await fs.rm(dbDir, { recursive: true, force: true });

  if (process.exitCode === 1) {
    console.error("[verify] SOME CHECKS FAILED");
    process.exit(1);
  } else {
    console.log("[verify] ALL CHECKS PASSED");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("[verify] ERROR", err);
  process.exit(1);
});
