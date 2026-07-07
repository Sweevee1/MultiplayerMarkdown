import * as path from "node:path";
import {
  openDb,
  createUser,
  getUserByUsername,
  listUsers,
  bumpTokenVersion,
  setPasswordHash,
  deleteUser,
  createRoom,
  getRoom,
  listRooms,
  listMembersForRoom,
  grantRoomAccess,
  revokeRoomAccess,
  type Role,
} from "./db.js";
import { hashPassword } from "./auth.js";

const DB_PATH = path.resolve(process.env.DB_PATH ?? "./data/db/collab.sqlite3");

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function usage(): void {
  console.log(`Usage:
  user add <username> --password <password> [--admin]
  user list
  user revoke <username>          # bumps token_version, invalidates all sessions
  user set-password <username> --password <password>
  user delete <username>

  room create <roomId> [--label <label>]
  room list
  room members <roomId>
  room grant <roomId> <username> <viewer|editor>
  room revoke <roomId> <username>
`);
}

async function main(): Promise<void> {
  const [resource, action, ...rest] = process.argv.slice(2);
  const db = openDb(DB_PATH);

  if (resource === "user" && action === "add") {
    const username = rest[0];
    const password = getFlag(rest, "--password");
    if (!username || !password) return usage();
    if (getUserByUsername(db, username)) {
      console.error(`User ${username} already exists`);
      process.exitCode = 1;
      return;
    }
    const isAdmin = rest.includes("--admin");
    const passwordHash = await hashPassword(password);
    createUser(db, username, passwordHash, isAdmin);
    console.log(`Created user ${username}${isAdmin ? " (admin)" : ""}`);
    return;
  }

  if (resource === "user" && action === "list") {
    for (const user of listUsers(db)) {
      console.log(`${user.username}${user.is_admin ? " (admin)" : ""} — created ${user.created_at}`);
    }
    return;
  }

  if (resource === "user" && action === "revoke") {
    const username = rest[0];
    const user = username ? getUserByUsername(db, username) : undefined;
    if (!user) {
      console.error(`No such user: ${username ?? "(none given)"}`);
      process.exitCode = 1;
      return;
    }
    bumpTokenVersion(db, user.id);
    console.log(`Revoked all sessions for ${username} — they must log in again`);
    return;
  }

  if (resource === "user" && action === "set-password") {
    const username = rest[0];
    const password = getFlag(rest, "--password");
    const user = username ? getUserByUsername(db, username) : undefined;
    if (!user || !password) {
      console.error(!user ? `No such user: ${username ?? "(none given)"}` : "Missing --password");
      process.exitCode = 1;
      return;
    }
    setPasswordHash(db, user.id, await hashPassword(password));
    bumpTokenVersion(db, user.id);
    console.log(`Password updated for ${username} — existing sessions invalidated`);
    return;
  }

  if (resource === "user" && action === "delete") {
    const username = rest[0];
    const user = username ? getUserByUsername(db, username) : undefined;
    if (!user) {
      console.error(`No such user: ${username ?? "(none given)"}`);
      process.exitCode = 1;
      return;
    }
    deleteUser(db, user.id);
    console.log(`Deleted user ${username} (and their room memberships)`);
    return;
  }

  if (resource === "room" && action === "create") {
    const roomId = rest[0];
    if (!roomId) return usage();
    const label = getFlag(rest, "--label") ?? roomId;
    if (getRoom(db, roomId)) {
      console.error(`Room ${roomId} already exists`);
      process.exitCode = 1;
      return;
    }
    createRoom(db, roomId, label);
    console.log(`Created room ${roomId} ("${label}")`);
    return;
  }

  if (resource === "room" && action === "list") {
    for (const room of listRooms(db)) {
      console.log(`${room.id} — "${room.label}" — created ${room.created_at}`);
    }
    return;
  }

  if (resource === "room" && action === "members") {
    const roomId = rest[0];
    if (!roomId) return usage();
    for (const member of listMembersForRoom(db, roomId)) {
      console.log(`${member.username}: ${member.role}`);
    }
    return;
  }

  if (resource === "room" && action === "grant") {
    const [roomId, username, role] = rest;
    if (!roomId || !username || (role !== "viewer" && role !== "editor")) return usage();
    const user = getUserByUsername(db, username);
    if (!user) {
      console.error(`No such user: ${username}`);
      process.exitCode = 1;
      return;
    }
    if (!getRoom(db, roomId)) {
      console.error(`No such room: ${roomId}`);
      process.exitCode = 1;
      return;
    }
    grantRoomAccess(db, roomId, user.id, role as Role);
    console.log(`Granted ${username} ${role} access to ${roomId}`);
    return;
  }

  if (resource === "room" && action === "revoke") {
    const [roomId, username] = rest;
    if (!roomId || !username) return usage();
    const user = getUserByUsername(db, username);
    if (!user) {
      console.error(`No such user: ${username}`);
      process.exitCode = 1;
      return;
    }
    revokeRoomAccess(db, roomId, user.id);
    console.log(`Revoked ${username}'s access to ${roomId}`);
    return;
  }

  usage();
  process.exitCode = 1;
}

main();
