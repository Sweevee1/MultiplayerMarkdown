import * as http from "node:http";
import type Database from "better-sqlite3";
import {
  getUserByUsername,
  listRoomsForUser,
  listUsers,
  createUser,
  bumpTokenVersion,
  deleteUser,
  listRooms,
  createRoom,
  getRoom,
  listMembersForRoom,
  grantRoomAccess,
  revokeRoomAccess,
} from "./db.js";
import {
  verifyPassword,
  signJwt,
  verifyJwt,
  authenticateForRoom,
  authenticateAdmin,
  hashPassword,
  type AuthenticatedAdmin,
} from "./auth.js";
import { attachmentExists, readAttachment, writeAttachment } from "./attachments.js";
import { ADMIN_HTML } from "./admin-ui.js";

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024; // 50MB — generous for note attachments, bounds memory use
const ATTACHMENT_ROUTE = /^\/api\/rooms\/([^/]+)\/attachments\/([0-9a-f]{64})$/;
const ADMIN_USER_REVOKE_ROUTE = /^\/api\/admin\/users\/([^/]+)\/revoke$/;
const ADMIN_USER_ROUTE = /^\/api\/admin\/users\/([^/]+)$/;
const ADMIN_ROOM_MEMBERS_ROUTE = /^\/api\/admin\/rooms\/([^/]+)\/members$/;
const ADMIN_ROOM_MEMBER_ROUTE = /^\/api\/admin\/rooms\/([^/]+)\/members\/([^/]+)$/;

const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

interface LoginAttemptState {
  failures: number;
  lockedUntil: number;
}

// In-memory only — resets on server restart, which is fine for a single-process
// self-hosted deployment. Keyed by client IP so brute-forcing /api/login from
// a public hostname (e.g. behind a Cloudflare Tunnel) gets locked out.
const loginAttempts = new Map<string, LoginAttemptState>();

function getClientKey(req: http.IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

function isLockedOut(key: string): boolean {
  const state = loginAttempts.get(key);
  if (!state?.lockedUntil) return false;
  if (state.lockedUntil <= Date.now()) {
    loginAttempts.delete(key);
    return false;
  }
  return true;
}

function recordLoginFailure(key: string): void {
  const state = loginAttempts.get(key) ?? { failures: 0, lockedUntil: 0 };
  state.failures += 1;
  if (state.failures >= MAX_LOGIN_ATTEMPTS) {
    state.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
  }
  loginAttempts.set(key, state);
}

function recordLoginSuccess(key: string): void {
  loginAttempts.delete(key);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

async function readJsonBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

async function readBinaryBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) {
      throw new Error(`Request body exceeds ${maxBytes} byte limit`);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function getBearerToken(req: http.IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

// Shared by all nine /api/admin/* action routes below — inlining
// authenticateAdmin's try/catch at each call site (as the single-use
// attachment route does with authenticateForRoom) would repeat the same
// 8 lines 9 times, so this one is worth extracting.
function requireAdmin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: Database.Database,
  jwtSecret: string
): AuthenticatedAdmin | null {
  const token = getBearerToken(req);
  if (!token) {
    sendJson(res, 401, { error: "Missing bearer token" });
    return null;
  }
  try {
    return authenticateAdmin(db, jwtSecret, token);
  } catch (err) {
    sendJson(res, 403, { error: err instanceof Error ? err.message : "Not authorized" });
    return null;
  }
}

export interface HttpApiOptions {
  db: Database.Database;
  jwtSecret: string;
  attachmentsRoot: string;
}

/**
 * Minimal REST API (no Express — plain node:http keeps the dependency
 * surface small): login, rooms, and attachment upload/download. Runs on its
 * own port, separate from the Hocuspocus WebSocket server — Hocuspocus's
 * onRequest hook exists but hijacking its response lifecycle to fully
 * replace HTTP responses risks double-writing the "Welcome to Hocuspocus"
 * default response or crashing via an unhandled rejection (confirmed by
 * reading its source); a second plain port is simpler and safer. Phase 6's
 * Caddy reverse proxy can expose both under one domain via path-based
 * routing regardless.
 */
export function createHttpApiServer({ db, jwtSecret, attachmentsRoot }: HttpApiOptions): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "POST" && url.pathname === "/api/login") {
        const clientKey = getClientKey(req);
        if (isLockedOut(clientKey)) {
          sendJson(res, 429, { error: "Too many failed login attempts. Try again later." });
          return;
        }

        const body = await readJsonBody(req);
        const username = typeof body.username === "string" ? body.username : "";
        const password = typeof body.password === "string" ? body.password : "";

        const user = getUserByUsername(db, username);
        if (!user || !(await verifyPassword(user.password_hash, password))) {
          recordLoginFailure(clientKey);
          sendJson(res, 401, { error: "Invalid username or password" });
          return;
        }

        recordLoginSuccess(clientKey);
        const token = signJwt({ sub: user.id, tokenVersion: user.token_version }, jwtSecret);
        sendJson(res, 200, { token, username: user.username });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/rooms") {
        const token = getBearerToken(req);
        if (!token) {
          sendJson(res, 401, { error: "Missing bearer token" });
          return;
        }

        let payload;
        try {
          payload = verifyJwt(token, jwtSecret);
        } catch {
          sendJson(res, 401, { error: "Invalid or expired token" });
          return;
        }

        const rooms = listRoomsForUser(db, payload.sub).map((room) => ({
          id: room.id,
          label: room.label,
          role: room.role,
        }));
        sendJson(res, 200, { rooms });
        return;
      }

      // The page itself has no secrets — it's static HTML/JS. Only the
      // /api/admin/* actions below are auth-gated (see requireAdmin).
      if (req.method === "GET" && url.pathname === "/api/admin") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(ADMIN_HTML);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/users") {
        if (!requireAdmin(req, res, db, jwtSecret)) return;
        const users = listUsers(db).map((u) => ({
          id: u.id,
          username: u.username,
          isAdmin: u.is_admin === 1,
          createdAt: u.created_at,
        }));
        sendJson(res, 200, { users });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/users") {
        if (!requireAdmin(req, res, db, jwtSecret)) return;
        const body = await readJsonBody(req);
        const username = typeof body.username === "string" ? body.username.trim() : "";
        const password = typeof body.password === "string" ? body.password : "";
        const isAdminFlag = body.isAdmin === true;
        if (!username || !password) {
          sendJson(res, 400, { error: "username and password are required" });
          return;
        }
        if (getUserByUsername(db, username)) {
          sendJson(res, 409, { error: `User ${username} already exists` });
          return;
        }
        const passwordHash = await hashPassword(password);
        const user = createUser(db, username, passwordHash, isAdminFlag);
        sendJson(res, 201, {
          id: user.id,
          username: user.username,
          isAdmin: user.is_admin === 1,
          createdAt: user.created_at,
        });
        return;
      }

      const revokeUserMatch = url.pathname.match(ADMIN_USER_REVOKE_ROUTE);
      if (revokeUserMatch && req.method === "POST") {
        if (!requireAdmin(req, res, db, jwtSecret)) return;
        const username = decodeURIComponent(revokeUserMatch[1]);
        const user = getUserByUsername(db, username);
        if (!user) {
          sendJson(res, 404, { error: `No such user: ${username}` });
          return;
        }
        bumpTokenVersion(db, user.id);
        sendJson(res, 200, { ok: true });
        return;
      }

      const userMatch = url.pathname.match(ADMIN_USER_ROUTE);
      if (userMatch && req.method === "DELETE") {
        if (!requireAdmin(req, res, db, jwtSecret)) return;
        const username = decodeURIComponent(userMatch[1]);
        const user = getUserByUsername(db, username);
        if (!user) {
          sendJson(res, 404, { error: `No such user: ${username}` });
          return;
        }
        deleteUser(db, user.id);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/rooms") {
        if (!requireAdmin(req, res, db, jwtSecret)) return;
        sendJson(res, 200, { rooms: listRooms(db) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/rooms") {
        if (!requireAdmin(req, res, db, jwtSecret)) return;
        const body = await readJsonBody(req);
        const roomId = typeof body.roomId === "string" ? body.roomId.trim() : "";
        const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : roomId;
        if (!roomId) {
          sendJson(res, 400, { error: "roomId is required" });
          return;
        }
        if (getRoom(db, roomId)) {
          sendJson(res, 409, { error: `Room ${roomId} already exists` });
          return;
        }
        const room = createRoom(db, roomId, label);
        sendJson(res, 201, room);
        return;
      }

      const roomMembersMatch = url.pathname.match(ADMIN_ROOM_MEMBERS_ROUTE);
      if (roomMembersMatch && req.method === "GET") {
        if (!requireAdmin(req, res, db, jwtSecret)) return;
        const roomId = decodeURIComponent(roomMembersMatch[1]);
        if (!getRoom(db, roomId)) {
          sendJson(res, 404, { error: `No such room: ${roomId}` });
          return;
        }
        sendJson(res, 200, { members: listMembersForRoom(db, roomId) });
        return;
      }

      if (roomMembersMatch && req.method === "POST") {
        if (!requireAdmin(req, res, db, jwtSecret)) return;
        const roomId = decodeURIComponent(roomMembersMatch[1]);
        const body = await readJsonBody(req);
        const username = typeof body.username === "string" ? body.username.trim() : "";
        const role = body.role;
        if (!username || (role !== "viewer" && role !== "editor")) {
          sendJson(res, 400, { error: "username and role ('viewer'|'editor') are required" });
          return;
        }
        // Order matches cli.ts's `room grant`: user existence checked before room existence.
        const user = getUserByUsername(db, username);
        if (!user) {
          sendJson(res, 404, { error: `No such user: ${username}` });
          return;
        }
        if (!getRoom(db, roomId)) {
          sendJson(res, 404, { error: `No such room: ${roomId}` });
          return;
        }
        grantRoomAccess(db, roomId, user.id, role);
        sendJson(res, 200, { ok: true });
        return;
      }

      const roomMemberMatch = url.pathname.match(ADMIN_ROOM_MEMBER_ROUTE);
      if (roomMemberMatch && req.method === "DELETE") {
        if (!requireAdmin(req, res, db, jwtSecret)) return;
        const roomId = decodeURIComponent(roomMemberMatch[1]);
        const username = decodeURIComponent(roomMemberMatch[2]);
        // Deliberately mirrors cli.ts's `room revoke`: does not validate the
        // room exists first, only the user — pre-existing minor inconsistency,
        // not fixed here since scope is CLI parity, not CLI improvement.
        const user = getUserByUsername(db, username);
        if (!user) {
          sendJson(res, 404, { error: `No such user: ${username}` });
          return;
        }
        revokeRoomAccess(db, roomId, user.id);
        sendJson(res, 200, { ok: true });
        return;
      }

      const attachmentMatch = url.pathname.match(ATTACHMENT_ROUTE);
      if (attachmentMatch && (req.method === "GET" || req.method === "HEAD" || req.method === "PUT")) {
        const [, roomId, hash] = attachmentMatch;
        const token = getBearerToken(req);
        if (!token) {
          sendJson(res, 401, { error: "Missing bearer token" });
          return;
        }

        let membership;
        try {
          membership = authenticateForRoom(db, jwtSecret, token, roomId);
        } catch (err) {
          sendJson(res, 403, { error: err instanceof Error ? err.message : "Not authorized for this room" });
          return;
        }

        if (req.method === "GET" || req.method === "HEAD") {
          const exists = await attachmentExists(attachmentsRoot, roomId, hash);
          if (!exists) {
            sendJson(res, 404, { error: "Attachment not found" });
            return;
          }
          if (req.method === "HEAD") {
            res.writeHead(200);
            res.end();
            return;
          }
          const data = await readAttachment(attachmentsRoot, roomId, hash);
          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Length": data.length,
          });
          res.end(data);
          return;
        }

        // PUT: upload — only editors may write, matching the same rule the
        // WebSocket path enforces for markdown files.
        if (membership.role !== "editor") {
          sendJson(res, 403, { error: "Only editors may upload attachments" });
          return;
        }
        let data: Buffer;
        try {
          data = await readBinaryBody(req, MAX_ATTACHMENT_BYTES);
        } catch (err) {
          sendJson(res, 413, { error: err instanceof Error ? err.message : "Payload too large" });
          return;
        }
        try {
          await writeAttachment(attachmentsRoot, roomId, hash, data);
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : "Hash mismatch" });
          return;
        }
        sendJson(res, 200, { hash, size: data.length });
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      console.error("[http-api] unhandled error", err);
      sendJson(res, 500, { error: "Internal server error" });
    }
  });
}
