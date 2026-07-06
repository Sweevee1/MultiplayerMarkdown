/**
 * Headless verification of the admin HTTP API. Proves:
 *   1. An admin can perform every user/room/membership operation over HTTP.
 *   2. A non-admin's otherwise-valid JWT gets 403 from every admin route —
 *      the concrete proof that "hide the button" is not the security model.
 *   3. No token / an invalid / revoked token is rejected from every route too.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { openDb, createUser, bumpTokenVersion } from "./db.js";
import { hashPassword, signJwt } from "./auth.js";
import { createHttpApiServer } from "./http-api.js";

const HTTP_PORT = 4496;
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
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "multiplayer-markdown-admin-test-db-"));
  const attachmentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "multiplayer-markdown-admin-test-blobs-"));
  const db = openDb(path.join(dbDir, "test.sqlite3"));

  const admin = createUser(db, "admin", await hashPassword("admin-pw"), true);
  const bob = createUser(db, "bob", await hashPassword("bob-pw")); // valid but non-admin

  const adminToken = signJwt({ sub: admin.id, tokenVersion: admin.token_version }, JWT_SECRET);
  const bobToken = signJwt({ sub: bob.id, tokenVersion: bob.token_version }, JWT_SECRET);
  const garbageToken = "not-a-real-jwt";

  const server = createHttpApiServer({ db, jwtSecret: JWT_SECRET, attachmentsRoot });
  await new Promise<void>((resolve) => server.listen(HTTP_PORT, resolve));
  console.log(`[verify] HTTP API listening on ${HTTP_PORT}`);
  const base = `http://127.0.0.1:${HTTP_PORT}`;

  // --- The page itself loads with no token — proving the page/action split ---
  const pageRes = await fetch(`${base}/api/admin`);
  assertEqual(pageRes.status, 200, "GET /api/admin loads with no auth at all");
  const pageBody = await pageRes.text();
  assertEqual(pageBody.includes("<html"), true, "admin page body looks like HTML");

  // --- Table-driven proof: every admin action route rejects no-token (401)
  //     and a valid non-admin token (403). ---
  const adminRoutes: Array<{ method: string; path: string }> = [
    { method: "GET", path: "/api/admin/users" },
    { method: "POST", path: "/api/admin/users" },
    { method: "POST", path: "/api/admin/users/bob/revoke" },
    { method: "DELETE", path: "/api/admin/users/bob" },
    { method: "GET", path: "/api/admin/rooms" },
    { method: "POST", path: "/api/admin/rooms" },
    { method: "GET", path: "/api/admin/rooms/some-room/members" },
    { method: "POST", path: "/api/admin/rooms/some-room/members" },
    { method: "DELETE", path: "/api/admin/rooms/some-room/members/bob" },
  ];

  for (const route of adminRoutes) {
    const noTokenRes = await fetch(base + route.path, { method: route.method });
    assertEqual(noTokenRes.status, 401, `${route.method} ${route.path} rejects a missing bearer token with 401`);

    const nonAdminRes = await fetch(base + route.path, {
      method: route.method,
      headers: { Authorization: `Bearer ${bobToken}` },
    });
    assertEqual(nonAdminRes.status, 403, `${route.method} ${route.path} rejects a valid non-admin token with 403`);

    const garbageRes = await fetch(base + route.path, {
      method: route.method,
      headers: { Authorization: `Bearer ${garbageToken}` },
    });
    assertEqual(garbageRes.status, 403, `${route.method} ${route.path} rejects a malformed/invalid token with 403`);
  }

  // --- Revoked admin token is rejected too (not just expiry) ---
  const revokable = createUser(db, "revokable-admin", await hashPassword("pw"), true);
  const revokableToken = signJwt({ sub: revokable.id, tokenVersion: revokable.token_version }, JWT_SECRET);
  bumpTokenVersion(db, revokable.id);
  const revokedRes = await fetch(`${base}/api/admin/users`, { headers: { Authorization: `Bearer ${revokableToken}` } });
  assertEqual(revokedRes.status, 403, "a revoked admin's stale token is rejected with 403, not honored");

  // --- Happy path: admin can perform the full user lifecycle over HTTP ---
  const createRes = await fetch(`${base}/api/admin/users`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "newuser", password: "newuser-pw", isAdmin: false }),
  });
  assertEqual(createRes.status, 201, "admin can create a new user");
  const created = await createRes.json();
  assertEqual(created.username, "newuser", "created user response has the right username");
  assertEqual("password_hash" in created, false, "created-user response never includes password_hash");

  const dupeRes = await fetch(`${base}/api/admin/users`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "newuser", password: "irrelevant" }),
  });
  assertEqual(dupeRes.status, 409, "creating a user with a taken username is rejected with 409");

  const listRes = await fetch(`${base}/api/admin/users`, { headers: { Authorization: `Bearer ${adminToken}` } });
  const listBody = await listRes.json();
  assertEqual(
    listBody.users.some((u: any) => "password_hash" in u),
    false,
    "user list response never includes password_hash for any user"
  );
  assertEqual(
    listBody.users.some((u: any) => u.username === "newuser"),
    true,
    "user list includes the newly created user"
  );

  const revokeRes = await fetch(`${base}/api/admin/users/newuser/revoke`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assertEqual(revokeRes.status, 200, "admin can revoke a user's sessions");

  const deleteRes = await fetch(`${base}/api/admin/users/newuser`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assertEqual(deleteRes.status, 200, "admin can delete a user");

  const listAfterDeleteRes = await fetch(`${base}/api/admin/users`, { headers: { Authorization: `Bearer ${adminToken}` } });
  const listAfterDeleteBody = await listAfterDeleteRes.json();
  assertEqual(
    listAfterDeleteBody.users.some((u: any) => u.username === "newuser"),
    false,
    "deleted user no longer appears in the user list"
  );

  const deleteUnknownRes = await fetch(`${base}/api/admin/users/nobody-here`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assertEqual(deleteUnknownRes.status, 404, "deleting an unknown username is rejected with 404");

  // --- Happy path: admin can perform the full room/membership lifecycle over HTTP ---
  const createRoomRes = await fetch(`${base}/api/admin/rooms`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ roomId: "test-room", label: "Test Room" }),
  });
  assertEqual(createRoomRes.status, 201, "admin can create a room");

  const dupeRoomRes = await fetch(`${base}/api/admin/rooms`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ roomId: "test-room", label: "irrelevant" }),
  });
  assertEqual(dupeRoomRes.status, 409, "creating a room with a taken id is rejected with 409");

  const listRoomsRes = await fetch(`${base}/api/admin/rooms`, { headers: { Authorization: `Bearer ${adminToken}` } });
  const listRoomsBody = await listRoomsRes.json();
  assertEqual(
    listRoomsBody.rooms.some((r: any) => r.id === "test-room"),
    true,
    "room list includes the newly created room"
  );

  const grantRes = await fetch(`${base}/api/admin/rooms/test-room/members`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "bob", role: "editor" }),
  });
  assertEqual(grantRes.status, 200, "admin can grant a user access to a room");

  const invalidRoleRes = await fetch(`${base}/api/admin/rooms/test-room/members`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "bob", role: "owner" }),
  });
  assertEqual(invalidRoleRes.status, 400, "granting an invalid role is rejected with 400");

  const grantUnknownUserRes = await fetch(`${base}/api/admin/rooms/test-room/members`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "nobody-here", role: "viewer" }),
  });
  assertEqual(grantUnknownUserRes.status, 404, "granting access to an unknown username is rejected with 404");

  const membersRes = await fetch(`${base}/api/admin/rooms/test-room/members`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const membersBody = await membersRes.json();
  assertEqual(
    membersBody.members.some((m: any) => m.username === "bob" && m.role === "editor"),
    true,
    "room members list shows bob as editor"
  );

  const revokeMemberRes = await fetch(`${base}/api/admin/rooms/test-room/members/bob`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assertEqual(revokeMemberRes.status, 200, "admin can revoke a user's room access");

  const membersAfterRevokeRes = await fetch(`${base}/api/admin/rooms/test-room/members`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const membersAfterRevokeBody = await membersAfterRevokeRes.json();
  assertEqual(
    membersAfterRevokeBody.members.some((m: any) => m.username === "bob"),
    false,
    "bob no longer appears in the room's members after revoke"
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
