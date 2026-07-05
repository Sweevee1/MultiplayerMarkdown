import argon2 from "argon2";
import jwt from "jsonwebtoken";
import type Database from "better-sqlite3";
import type { onAuthenticatePayload } from "@hocuspocus/server";
import { roomIdFromDocumentName, ROOM_PREFIX } from "@multiplayer-markdown/sync-core";
import { getUserById, getMembership, type Role } from "./db.js";

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password);
}

export interface AppJwtPayload {
  sub: number;
  tokenVersion: number;
}

const ONE_DAY_SECONDS = 60 * 60 * 24;

export function signJwt(payload: AppJwtPayload, secret: string, expiresInSeconds = ONE_DAY_SECONDS): string {
  return jwt.sign(payload, secret, { expiresIn: expiresInSeconds });
}

export function verifyJwt(token: string, secret: string): AppJwtPayload {
  const decoded = jwt.verify(token, secret);
  if (typeof decoded !== "object" || decoded === null || !("sub" in decoded) || !("tokenVersion" in decoded)) {
    throw new Error("Malformed token payload");
  }
  return decoded as unknown as AppJwtPayload;
}

export interface AuthenticatedMembership {
  userId: number;
  username: string;
  role: Role;
}

/**
 * The single place ALL permission logic lives — shared by both the
 * WebSocket handshake (onAuthenticate) and the HTTP attachment routes
 * (Phase 5): verifies the JWT, checks token_version for instant revocation,
 * and looks up membership for the given room, throwing if any check fails.
 */
export function authenticateForRoom(
  db: Database.Database,
  jwtSecret: string,
  token: string,
  roomId: string
): AuthenticatedMembership {
  let payload: AppJwtPayload;
  try {
    payload = verifyJwt(token, jwtSecret);
  } catch {
    throw new Error("Invalid or expired token");
  }

  const user = getUserById(db, payload.sub);
  if (!user || user.token_version !== payload.tokenVersion) {
    throw new Error("Token has been revoked");
  }

  const membership = getMembership(db, roomId, user.id);
  if (!membership) {
    throw new Error(`User ${user.username} is not a member of room ${roomId}`);
  }

  return { userId: user.id, username: user.username, role: membership.role };
}

/**
 * Confirmed against Hocuspocus's actual source: setting
 * connectionConfig.readOnly = true here causes the server to silently drop
 * that connection's Yjs update messages without ever applying them to the
 * document — real server-side enforcement, not a client-side courtesy flag.
 */
export function createOnAuthenticate(db: Database.Database, jwtSecret: string) {
  return async ({ token, documentName, connectionConfig }: onAuthenticatePayload) => {
    if (!documentName.startsWith(ROOM_PREFIX)) {
      throw new Error("Not a room document");
    }

    const roomId = roomIdFromDocumentName(documentName);
    const membership = authenticateForRoom(db, jwtSecret, token, roomId);

    if (membership.role === "viewer") {
      connectionConfig.readOnly = true;
    }

    return membership;
  };
}
