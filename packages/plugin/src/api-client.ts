import { requestUrl } from "obsidian";
import type { Role } from "./settings.js";

export interface RoomInfo {
  id: string;
  label: string;
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
