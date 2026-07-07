import type { App } from "obsidian";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { IndexeddbPersistence } from "y-indexeddb";
import { roomDocumentName, isUnderFolder } from "@multiplayer-markdown/sync-core";
import { FileSyncEngine } from "./file-sync-engine.js";
import type { LinkedRoom, Role } from "./settings.js";

export interface ActiveRoom {
  roomId: string;
  vaultFolder: string;
  role: Role;
  provider: HocuspocusProvider;
  syncEngine: FileSyncEngine;
  indexeddbPersistence: IndexeddbPersistence;
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
 * Deterministic per-username color so the same person looks the same across
 * sessions/devices — used for both CM6 remote cursors and file-explorer
 * presence pills (same color in both places). Hue is restricted to
 * cyan/blue/purple/magenta (~185-330) and deliberately never red, orange,
 * yellow, or green: those hues already carry UI meaning elsewhere
 * (error/warning/success) and a person's color getting misread as a status
 * color would be worse than a smaller palette.
 */
export function colorForUsername(username: string): string {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = (hash << 5) - hash + username.charCodeAt(i);
    hash |= 0;
  }
  const hue = 185 + (Math.abs(hash) % 145);
  return `hsl(${hue}, 70%, 45%)`;
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
        void room.indexeddbPersistence.destroy();
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

      // Loads this room's last-known state from IndexedDB into the doc
      // *before* anything else touches it. Without this, a fresh Y.Doc
      // created after an app restart has no idea a given file's Y.Text
      // already exists on the server — initialScan()'s setFileContent then
      // calls getOrCreateFileText, which (finding no local key) creates a
      // brand-new Y.Text for that path. Two independently-created Y.Text
      // objects assigned to the same Y.Map key don't merge on sync: Yjs's
      // last-writer-wins conflict resolution for a Y.Map key keeps exactly
      // one of them and silently discards the other's entire content —
      // confirmed directly (a client's offline edits vanished completely
      // after reconnecting). Hydrating from IndexedDB first means the doc
      // already has the real Y.Text for every previously-synced file, so
      // offline edits land in reconcileYTextWithContent's diff-merge against
      // the *same* object instead of colliding with it.
      const indexeddbPersistence = new IndexeddbPersistence(
        `multiplayer-markdown:${this.app.vault.getName()}:${linked.roomId}`,
        provider.document
      );
      await indexeddbPersistence.whenSynced;

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
        indexeddbPersistence,
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
      void room.indexeddbPersistence.destroy();
    }
    this.active.clear();
    this.liveBoundPaths.clear();
  }
}
