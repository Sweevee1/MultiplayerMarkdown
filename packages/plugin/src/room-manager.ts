import type { App } from "obsidian";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { roomDocumentName, isUnderFolder } from "@multiplayer-markdown/sync-core";
import { FileSyncEngine } from "./file-sync-engine.js";
import type { LinkedRoom, Role } from "./settings.js";

export interface ActiveRoom {
  roomId: string;
  vaultFolder: string;
  role: Role;
  provider: HocuspocusProvider;
  syncEngine: FileSyncEngine;
}

function waitForSynced(provider: HocuspocusProvider, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    if (provider.isSynced) return resolve();
    const timer = setTimeout(resolve, timeoutMs);
    provider.on("synced", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Deterministic per-username hue so the same person looks the same across
 * sessions/devices. Restricted to cyan/blue/purple/magenta (~185-330) and
 * deliberately never red, orange, yellow, or green: those hues already carry
 * UI meaning elsewhere (error/warning/success) and a person's color getting
 * misread as a status color would be worse than a smaller palette.
 */
function hueForUsername(username: string): number {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = (hash << 5) - hash + username.charCodeAt(i);
    hash |= 0;
  }
  return 185 + (Math.abs(hash) % 145);
}

/** Used for CM6 remote cursors/carets — needs enough contrast to read clearly against editor text. */
export function colorForUsername(username: string): string {
  return `hsl(${hueForUsername(username)}, 70%, 45%)`;
}

/** Same per-person hue as colorForUsername, softened for the file-explorer presence pills. */
export function pastelColorForUsername(username: string): string {
  return `hsl(${hueForUsername(username)}, 60%, 78%)`;
}

/**
 * Owns one HocuspocusProvider + FileSyncEngine per linked room (a room = one
 * shared top-level folder). Replaces the single hardcoded provider/folder
 * from Phases 1-3 now that real accounts can be members of multiple rooms.
 */
export class RoomManager {
  private active = new Map<string, ActiveRoom>();
  private liveBoundPaths = new Set<string>();

  constructor(
    private app: App,
    private wsUrl: string,
    private apiUrl: string,
    private getToken: () => string | null,
    private getUsername: () => string | null
  ) {}

  isPathLiveBound(vaultPath: string): boolean {
    return this.liveBoundPaths.has(vaultPath);
  }

  markLiveBound(vaultPath: string): void {
    this.liveBoundPaths.add(vaultPath);
  }

  unmarkLiveBound(vaultPath: string): void {
    this.liveBoundPaths.delete(vaultPath);
  }

  /** Finds which active room (if any) owns this vault-absolute path. */
  findRoomForPath(vaultPath: string): ActiveRoom | undefined {
    for (const room of this.active.values()) {
      if (isUnderFolder(vaultPath, room.vaultFolder)) return room;
    }
    return undefined;
  }

  getActiveRooms(): ActiveRoom[] {
    return Array.from(this.active.values());
  }

  /**
   * Reconciles active connections against the desired linked-room list:
   * stops rooms no longer linked, starts newly linked ones (connect, wait
   * for sync, run the initial folder scan).
   */
  async syncToLinkedRooms(linkedRooms: LinkedRoom[]): Promise<void> {
    const wanted = new Map(linkedRooms.map((r) => [r.roomId, r]));

    for (const [roomId, room] of this.active) {
      if (!wanted.has(roomId)) {
        room.syncEngine.stop();
        room.provider.destroy();
        this.active.delete(roomId);
      }
    }

    const token = this.getToken();
    if (!token) return;

    for (const linked of linkedRooms) {
      const existing = this.active.get(linked.roomId);
      if (existing) {
        // Folder mapping or role may have changed even if still linked.
        existing.vaultFolder = linked.vaultFolder;
        existing.role = linked.role;
        continue;
      }

      const provider = new HocuspocusProvider({
        url: this.wsUrl,
        name: roomDocumentName(linked.roomId),
        token,
        onAuthenticationFailed: ({ reason }) => {
          console.error(`[multiplayer-markdown] auth failed for room ${linked.roomId}: ${reason}`);
        },
      });

      const username = this.getUsername();
      if (username) {
        provider.awareness?.setLocalStateField("user", { name: username, color: colorForUsername(username) });
      }

      const syncEngine = new FileSyncEngine({
        app: this.app,
        doc: provider.document,
        targetFolder: linked.vaultFolder,
        apiUrl: this.apiUrl,
        roomId: linked.roomId,
        getToken: this.getToken,
        isPathLiveBound: (path) => this.isPathLiveBound(path),
      });
      syncEngine.start();

      const activeRoom: ActiveRoom = {
        roomId: linked.roomId,
        vaultFolder: linked.vaultFolder,
        role: linked.role,
        provider,
        syncEngine,
      };
      this.active.set(linked.roomId, activeRoom);

      await waitForSynced(provider);
      await syncEngine.initialScan();
    }
  }

  destroyAll(): void {
    for (const room of this.active.values()) {
      room.syncEngine.stop();
      room.provider.destroy();
    }
    this.active.clear();
    this.liveBoundPaths.clear();
  }
}
