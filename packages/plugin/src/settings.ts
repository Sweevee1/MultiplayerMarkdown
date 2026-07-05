export type Role = "viewer" | "editor";

export interface LinkedRoom {
  roomId: string;
  label: string;
  role: Role;
  /** Vault-relative folder path this room syncs to, e.g. "Shared". */
  vaultFolder: string;
}

export interface CollabSettings {
  wsUrl: string;
  apiUrl: string;
  username: string | null;
  token: string | null;
  linkedRooms: LinkedRoom[];
}

export const DEFAULT_SETTINGS: CollabSettings = {
  wsUrl: "ws://localhost:4444",
  apiUrl: "http://localhost:4445",
  username: null,
  token: null,
  linkedRooms: [],
};
