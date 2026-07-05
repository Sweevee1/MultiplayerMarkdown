/**
 * Headless verification of the attachment HTTP routes: upload as editor,
 * download as viewer, confirm a non-member is refused, confirm a viewer
 * cannot upload, and confirm a client can't poison the content-addressed
 * store by uploading bytes that don't match the claimed hash.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { openDb, createUser, createRoom, grantRoomAccess } from "./db.js";
import { hashPassword, signJwt } from "./auth.js";
import { createHttpApiServer } from "./http-api.js";

const HTTP_PORT = 4497;
const JWT_SECRET = "test-secret-only-for-verification";
const ROOM_ID = "verify-attachments-room";

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    console.error(`[verify] FAIL: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    process.exitCode = 1;
  } else {
    console.log(`[verify] OK: ${label}`);
  }
}

function sha256Hex(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

async function main() {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "multiplayer-markdown-attach-test-db-"));
  const attachmentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "multiplayer-markdown-attach-test-blobs-"));
  const db = openDb(path.join(dbDir, "test.sqlite3"));

  const alice = createUser(db, "alice", await hashPassword("alice-pw")); // editor
  const bob = createUser(db, "bob", await hashPassword("bob-pw")); // viewer
  const eve = createUser(db, "eve", await hashPassword("eve-pw")); // not a member
  createRoom(db, ROOM_ID, "Verify Attachments Room");
  grantRoomAccess(db, ROOM_ID, alice.id, "editor");
  grantRoomAccess(db, ROOM_ID, bob.id, "viewer");

  const aliceToken = signJwt({ sub: alice.id, tokenVersion: alice.token_version }, JWT_SECRET);
  const bobToken = signJwt({ sub: bob.id, tokenVersion: bob.token_version }, JWT_SECRET);
  const eveToken = signJwt({ sub: eve.id, tokenVersion: eve.token_version }, JWT_SECRET);

  const server = createHttpApiServer({ db, jwtSecret: JWT_SECRET, attachmentsRoot });
  await new Promise<void>((resolve) => server.listen(HTTP_PORT, resolve));
  console.log(`[verify] HTTP API listening on ${HTTP_PORT}`);

  const imageBytes = Buffer.from("pretend this is PNG bytes: " + "x".repeat(200));
  const hash = sha256Hex(imageBytes);
  const url = (h: string) => `http://127.0.0.1:${HTTP_PORT}/api/rooms/${ROOM_ID}/attachments/${h}`;

  // --- viewer cannot upload ---
  const bobUpload = await fetch(url(hash), {
    method: "PUT",
    headers: { Authorization: `Bearer ${bobToken}` },
    body: imageBytes,
  });
  assertEqual(bobUpload.status, 403, "viewer (bob) is refused permission to upload an attachment");

  // --- editor can upload ---
  const aliceUpload = await fetch(url(hash), {
    method: "PUT",
    headers: { Authorization: `Bearer ${aliceToken}` },
    body: imageBytes,
  });
  assertEqual(aliceUpload.status, 200, "editor (alice) can upload an attachment");

  // --- viewer can download what the editor uploaded ---
  const bobDownload = await fetch(url(hash), { headers: { Authorization: `Bearer ${bobToken}` } });
  assertEqual(bobDownload.status, 200, "viewer (bob) can download the attachment");
  const downloaded = Buffer.from(await bobDownload.arrayBuffer());
  assertEqual(downloaded.equals(imageBytes), true, "downloaded bytes match exactly what was uploaded");

  // --- non-member is refused entirely ---
  const eveDownload = await fetch(url(hash), { headers: { Authorization: `Bearer ${eveToken}` } });
  assertEqual(eveDownload.status, 403, "non-member (eve) is refused access to the room's attachments");

  // --- uploading content that doesn't match the claimed hash is rejected ---
  const wrongBytes = Buffer.from("this is not the content the hash claims it is");
  const tamperUpload = await fetch(url(hash), {
    method: "PUT",
    headers: { Authorization: `Bearer ${aliceToken}` },
    body: wrongBytes,
  });
  assertEqual(tamperUpload.status, 400, "upload with mismatched hash is rejected, not silently stored");

  // and the original content must still be intact after the rejected attempt
  const recheck = await fetch(url(hash), { headers: { Authorization: `Bearer ${bobToken}` } });
  const recheckBytes = Buffer.from(await recheck.arrayBuffer());
  assertEqual(recheckBytes.equals(imageBytes), true, "original content is untouched after a rejected mismatched upload");

  // --- unknown hash is a clean 404, not an error ---
  const missing = await fetch(url("0".repeat(64)), { headers: { Authorization: `Bearer ${aliceToken}` } });
  assertEqual(missing.status, 404, "requesting an attachment that was never uploaded returns 404");

  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  await fs.rm(dbDir, { recursive: true, force: true });
  await fs.rm(attachmentsRoot, { recursive: true, force: true });

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
