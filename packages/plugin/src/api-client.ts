import { requestUrl } from "obsidian";
import type { Role } from "./settings.js";

export interface RoomInfo {
  id: string;
  label: string;
  role: Role;
}

export interface MemberInfo {
  username: string;
  role: Role;
}

export async function login(apiUrl: string, username: string, password: string): Promise<{ token: string; username: string }> {
  const res = await requestUrl({
    url: `${apiUrl}/api/login`,
    method: "POST",
    contentType: "application/json",
    body: JSON.stringify({ username, password }),
    throw: false,
  });

  if (res.status !== 200) {
    const message = typeof res.json?.error === "string" ? res.json.error : `Login failed (HTTP ${res.status})`;
    throw new Error(message);
  }

  return res.json as { token: string; username: string };
}

export async function fetchRooms(apiUrl: string, token: string): Promise<RoomInfo[]> {
  const res = await requestUrl({
    url: `${apiUrl}/api/rooms`,
    headers: { Authorization: `Bearer ${token}` },
    throw: false,
  });

  if (res.status !== 200) {
    const message = typeof res.json?.error === "string" ? res.json.error : `Failed to fetch rooms (HTTP ${res.status})`;
    throw new Error(message);
  }

  return (res.json as { rooms: RoomInfo[] }).rooms;
}

export async function createRoom(apiUrl: string, token: string, roomId: string, label: string): Promise<RoomInfo> {
  const res = await requestUrl({
    url: `${apiUrl}/api/rooms`,
    method: "POST",
    contentType: "application/json",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ roomId, label }),
    throw: false,
  });

  if (res.status !== 201) {
    const message = typeof res.json?.error === "string" ? res.json.error : `Failed to create room (HTTP ${res.status})`;
    throw new Error(message);
  }

  return res.json as RoomInfo;
}

export async function fetchRoomMembers(apiUrl: string, token: string, roomId: string): Promise<MemberInfo[]> {
  const res = await requestUrl({
    url: `${apiUrl}/api/rooms/${encodeURIComponent(roomId)}/members`,
    headers: { Authorization: `Bearer ${token}` },
    throw: false,
  });

  if (res.status !== 200) {
    const message = typeof res.json?.error === "string" ? res.json.error : `Failed to fetch members (HTTP ${res.status})`;
    throw new Error(message);
  }

  return (res.json as { members: MemberInfo[] }).members;
}

export async function inviteToRoom(apiUrl: string, token: string, roomId: string, username: string, role: Role): Promise<void> {
  const res = await requestUrl({
    url: `${apiUrl}/api/rooms/${encodeURIComponent(roomId)}/members`,
    method: "POST",
    contentType: "application/json",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ username, role }),
    throw: false,
  });

  if (res.status !== 200) {
    const message = typeof res.json?.error === "string" ? res.json.error : `Failed to invite ${username} (HTTP ${res.status})`;
    throw new Error(message);
  }
}

export async function removeFromRoom(apiUrl: string, token: string, roomId: string, username: string): Promise<void> {
  const res = await requestUrl({
    url: `${apiUrl}/api/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(username)}`,
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
    throw: false,
  });

  if (res.status !== 200) {
    const message = typeof res.json?.error === "string" ? res.json.error : `Failed to remove ${username} (HTTP ${res.status})`;
    throw new Error(message);
  }
}
