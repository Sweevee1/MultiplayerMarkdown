/**
 * Headless verification of the self-service room HTTP API. Proves:
 *   1. Any logged-in (non-admin) user can create a room and becomes its editor.
 *   2. Any editor of a room — not just its creator — can invite/remove members.
 *   3. A viewer of a room, and a non-member entirely, cannot invite/remove.
 *   4. No token / an invalid / revoked token is rejected from every new route.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { openDb, createUser, bumpTokenVersion } from "./db.js";
import { hashPassword, signJwt } from "./auth.js";
import { createHttpApiServer } from "./http-api.js";

const HTTP_PORT = 4497;
const JWT_SECRET = "test-secret-only-for-verification";

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    console.error(`[verify] FAIL: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    process.exitCode = 1;
  } else {
    console.log(`[verify] OK: ${label}`);
  }
}

async function main() {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "multiplayer-markdown-rooms-test-db-"));
  const attachmentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "multiplayer-markdown-rooms-test-blobs-"));
  const db = openDb(path.join(dbDir, "test.sqlite3"));

  const alice = createUser(db, "alice", await hashPassword("alice-pw")); // will create the room
  const bob = createUser(db, "bob", await hashPassword("bob-pw")); // will be invited as editor
  const carol = createUser(db, "carol", await hashPassword("carol-pw")); // will be invited as viewer
  const dave = createUser(db, "dave", await hashPassword("dave-pw")); // never a member
  const erin = createUser(db, "erin", await hashPassword("erin-pw")); // dedicated to the revocation check below, kept separate from dave so bumping her token_version doesn't taint the later "non-member" assertions

  const aliceToken = signJwt({ sub: alice.id, tokenVersion: alice.token_version }, JWT_SECRET);
  const bobToken = signJwt({ sub: bob.id, tokenVersion: bob.token_version }, JWT_SECRET);
  const carolToken = signJwt({ sub: carol.id, tokenVersion: carol.token_version }, JWT_SECRET);
  const daveToken = signJwt({ sub: dave.id, tokenVersion: dave.token_version }, JWT_SECRET);
  const garbageToken = "not-a-real-jwt";

  const server = createHttpApiServer({ db, jwtSecret: JWT_SECRET, attachmentsRoot });
  await new Promise<void>((resolve) => server.listen(HTTP_PORT, resolve));
  console.log(`[verify] HTTP API listening on ${HTTP_PORT}`);
  const base = `http://127.0.0.1:${HTTP_PORT}`;

  // --- No-token / invalid-token rejection across every new route ---
  const newRoutes: Array<{ method: string; path: string }> = [
    { method: "POST", path: "/api/rooms" },
    { method: "GET", path: "/api/rooms/some-room/members" },
    { method: "POST", path: "/api/rooms/some-room/members" },
    { method: "DELETE", path: "/api/rooms/some-room/members/bob" },
  ];
  for (const route of newRoutes) {
    const noTokenRes = await fetch(base + route.path, { method: route.method });
    assertEqual(noTokenRes.status, 401, `${route.method} ${route.path} rejects a missing bearer token with 401`);

    const garbageRes = await fetch(base + route.path, {
      method: route.method,
      headers: { Authorization: `Bearer ${garbageToken}` },
    });
    assertEqual(garbageRes.status, 403, `${route.method} ${route.path} rejects a malformed/invalid token with 403`);
  }

  // --- Revoked user's token is rejected too (not just expiry) ---
  const revokedErinToken = signJwt({ sub: erin.id, tokenVersion: erin.token_version }, JWT_SECRET); // stale tokenVersion, signed before the bump below
  bumpTokenVersion(db, erin.id);
  const revokedRes = await fetch(`${base}/api/rooms`, {
    method: "POST",
    headers: { Authorization: `Bearer ${revokedErinToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ roomId: "irrelevant", label: "irrelevant" }),
  });
  assertEqual(revokedRes.status, 403, "a revoked user's stale token is rejected with 403, not honored");

  // --- Happy path: any non-admin user can self-service create a room ---
  const createRes = await fetch(`${base}/api/rooms`, {
    method: "POST",
    headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ roomId: "team-notes", label: "Team Notes" }),
  });
  assertEqual(createRes.status, 201, "a regular user can create a room");
  const created = await createRes.json();
  assertEqual(created.role, "editor", "the creator is granted the editor role automatically");

  const dupeRes = await fetch(`${base}/api/rooms`, {
    method: "POST",
    headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ roomId: "team-notes", label: "irrelevant" }),
  });
  assertEqual(dupeRes.status, 409, "creating a room with a taken id is rejected with 409");

  const badIdRes = await fetch(`${base}/api/rooms`, {
    method: "POST",
    headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ roomId: "not a valid id!", label: "irrelevant" }),
  });
  assertEqual(badIdRes.status, 400, "a roomId with spaces/punctuation is rejected with 400");

  // --- alice (creator/editor) invites bob as editor and carol as viewer ---
  const inviteBobRes = await fetch(`${base}/api/rooms/team-notes/members`, {
    method: "POST",
    headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "bob", role: "editor" }),
  });
  assertEqual(inviteBobRes.status, 200, "the creator can invite another user as editor");

  const inviteCarolRes = await fetch(`${base}/api/rooms/team-notes/members`, {
    method: "POST",
    headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "carol", role: "viewer" }),
  });
  assertEqual(inviteCarolRes.status, 200, "the creator can invite another user as viewer");

  const inviteUnknownRes = await fetch(`${base}/api/rooms/team-notes/members`, {
    method: "POST",
    headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "nobody-here", role: "viewer" }),
  });
  assertEqual(inviteUnknownRes.status, 404, "inviting an unknown username is rejected with 404");

  // --- bob (invited editor, not the creator) can also invite/remove — no "owner" concept ---
  const bobInvitesRes = await fetch(`${base}/api/rooms/team-notes/members`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bobToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "dave", role: "viewer" }),
  });
  assertEqual(bobInvitesRes.status, 200, "any editor (not just the creator) can invite members");

  const bobRemovesRes = await fetch(`${base}/api/rooms/team-notes/members/dave`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${bobToken}` },
  });
  assertEqual(bobRemovesRes.status, 200, "any editor (not just the creator) can remove members");

  // --- carol (viewer) cannot invite or remove ---
  const carolInvitesRes = await fetch(`${base}/api/rooms/team-notes/members`, {
    method: "POST",
    headers: { Authorization: `Bearer ${carolToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "dave", role: "viewer" }),
  });
  assertEqual(carolInvitesRes.status, 403, "a viewer cannot invite members");

  const carolRemovesRes = await fetch(`${base}/api/rooms/team-notes/members/bob`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${carolToken}` },
  });
  assertEqual(carolRemovesRes.status, 403, "a viewer cannot remove members");

  // --- dave (not a member at all) cannot see members, invite, or remove ---
  const daveListRes = await fetch(`${base}/api/rooms/team-notes/members`, {
    headers: { Authorization: `Bearer ${daveToken}` },
  });
  assertEqual(daveListRes.status, 403, "a non-member cannot view the room's member list");

  const daveInvitesRes = await fetch(`${base}/api/rooms/team-notes/members`, {
    method: "POST",
    headers: { Authorization: `Bearer ${daveToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "dave", role: "viewer" }),
  });
  assertEqual(daveInvitesRes.status, 403, "a non-member cannot invite members");

  // --- Members list reflects reality ---
  const membersRes = await fetch(`${base}/api/rooms/team-notes/members`, {
    headers: { Authorization: `Bearer ${aliceToken}` },
  });
  const membersBody = await membersRes.json();
  assertEqual(
    membersBody.members.some((m: any) => m.username === "bob" && m.role === "editor"),
    true,
    "member list shows bob as editor"
  );
  assertEqual(
    membersBody.members.some((m: any) => m.username === "carol" && m.role === "viewer"),
    true,
    "member list shows carol as viewer"
  );
  assertEqual(
    membersBody.members.some((m: any) => m.username === "dave"),
    false,
    "dave (removed by bob earlier) no longer appears in the member list"
  );

  // --- Room shows up under the creator's and invitee's own /api/rooms list ---
  const aliceRoomsRes = await fetch(`${base}/api/rooms`, { headers: { Authorization: `Bearer ${aliceToken}` } });
  const aliceRoomsBody = await aliceRoomsRes.json();
  assertEqual(
    aliceRoomsBody.rooms.some((r: any) => r.id === "team-notes" && r.role === "editor"),
    true,
    "the room shows up under the creator's own room list as editor"
  );

  const bobRoomsRes = await fetch(`${base}/api/rooms`, { headers: { Authorization: `Bearer ${bobToken}` } });
  const bobRoomsBody = await bobRoomsRes.json();
  assertEqual(
    bobRoomsBody.rooms.some((r: any) => r.id === "team-notes" && r.role === "editor"),
    true,
    "the room shows up under the invited editor's own room list"
  );

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
