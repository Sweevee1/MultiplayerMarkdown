import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";

export type Role = "viewer" | "editor";

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  is_admin: number;
  token_version: number;
  created_at: string;
}

export interface RoomRow {
  id: string;
  label: string;
  created_at: string;
}

export interface RoomMemberRow {
  room_id: string;
  user_id: number;
  role: Role;
}

export type RoomWithRole = RoomRow & { role: Role };

export function openDb(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      token_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS room_members (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('viewer','editor')),
      PRIMARY KEY (room_id, user_id)
    );
  `);
  return db;
}

export function createUser(db: Database.Database, username: string, passwordHash: string, isAdmin = false): UserRow {
  const info = db
    .prepare("INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)")
    .run(username, passwordHash, isAdmin ? 1 : 0);
  return getUserById(db, Number(info.lastInsertRowid))!;
}

export function getUserByUsername(db: Database.Database, username: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username) as UserRow | undefined;
}

export function getUserById(db: Database.Database, id: number): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

export function listUsers(db: Database.Database): UserRow[] {
  return db.prepare("SELECT * FROM users ORDER BY username").all() as UserRow[];
}

export function bumpTokenVersion(db: Database.Database, userId: number): void {
  db.prepare("UPDATE users SET token_version = token_version + 1 WHERE id = ?").run(userId);
}

export function setPasswordHash(db: Database.Database, userId: number, passwordHash: string): void {
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, userId);
}

export function deleteUser(db: Database.Database, userId: number): void {
  db.prepare("DELETE FROM users WHERE id = ?").run(userId);
}

export function createRoom(db: Database.Database, id: string, label: string): RoomRow {
  db.prepare("INSERT INTO rooms (id, label) VALUES (?, ?)").run(id, label);
  return getRoom(db, id)!;
}

export function getRoom(db: Database.Database, id: string): RoomRow | undefined {
  return db.prepare("SELECT * FROM rooms WHERE id = ?").get(id) as RoomRow | undefined;
}

export function listRooms(db: Database.Database): RoomRow[] {
  return db.prepare("SELECT * FROM rooms ORDER BY id").all() as RoomRow[];
}

export function getMembership(db: Database.Database, roomId: string, userId: number): RoomMemberRow | undefined {
  return db
    .prepare("SELECT * FROM room_members WHERE room_id = ? AND user_id = ?")
    .get(roomId, userId) as RoomMemberRow | undefined;
}

export function listRoomsForUser(db: Database.Database, userId: number): RoomWithRole[] {
  return db
    .prepare(
      `SELECT rooms.*, room_members.role as role
       FROM room_members
       JOIN rooms ON rooms.id = room_members.room_id
       WHERE room_members.user_id = ?
       ORDER BY rooms.id`
    )
    .all(userId) as RoomWithRole[];
}

export function listMembersForRoom(
  db: Database.Database,
  roomId: string
): Array<{ username: string; role: Role }> {
  return db
    .prepare(
      `SELECT users.username as username, room_members.role as role
       FROM room_members
       JOIN users ON users.id = room_members.user_id
       WHERE room_members.room_id = ?
       ORDER BY users.username`
    )
    .all(roomId) as Array<{ username: string; role: Role }>;
}

export function grantRoomAccess(db: Database.Database, roomId: string, userId: number, role: Role): void {
  db.prepare(
    `INSERT INTO room_members (room_id, user_id, role) VALUES (?, ?, ?)
     ON CONFLICT(room_id, user_id) DO UPDATE SET role = excluded.role`
  ).run(roomId, userId, role);
}

export function revokeRoomAccess(db: Database.Database, roomId: string, userId: number): void {
  db.prepare("DELETE FROM room_members WHERE room_id = ? AND user_id = ?").run(roomId, userId);
}
