import * as http from "node:http";
import type Database from "better-sqlite3";
import { getUserByUsername, listRoomsForUser } from "./db.js";
import { verifyPassword, signJwt, verifyJwt, authenticateForRoom } from "./auth.js";
import { attachmentExists, readAttachment, writeAttachment } from "./attachments.js";

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024; // 50MB — generous for note attachments, bounds memory use
const ATTACHMENT_ROUTE = /^\/api\/rooms\/([^/]+)\/attachments\/([0-9a-f]{64})$/;

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
