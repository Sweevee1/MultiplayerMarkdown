import { setIcon, type App, type WorkspaceLeaf } from "obsidian";
import { colorForUsername, type ActiveRoom, type RoomManager } from "./room-manager.js";

const BADGE_CLASS = "mm-folder-badge";
const MAX_VISIBLE_DOTS = 4;

// y-protocols isn't a direct dependency of this package (only transitive, via
// @hocuspocus/provider) — pnpm's strict node_modules means importing its
// types directly isn't reliably resolvable, so this is a minimal structural
// type for just the awareness surface used here.
interface AwarenessLike {
  getStates(): Map<number, { user?: { name?: string; color?: string } }>;
  on(event: "change", cb: () => void): void;
  off(event: "change", cb: () => void): void;
}

// Obsidian's file-explorer "fileItems" map (path -> tree item) is an
// unofficial, undocumented internal — not part of the public Obsidian API —
// but it's the standard technique community plugins use to decorate the
// file tree, and it's written defensively (every access is optional) so a
// future Obsidian version that changes this shape just means badges quietly
// stop appearing, not a crash.
interface FileExplorerItem {
  el?: HTMLElement;
  selfEl?: HTMLElement;
  titleEl?: HTMLElement;
}

interface FileExplorerView {
  fileItems?: Record<string, FileExplorerItem>;
}

function getFileExplorerView(app: App): FileExplorerView | null {
  const leaf: WorkspaceLeaf | undefined = app.workspace.getLeavesOfType("file-explorer")[0];
  if (!leaf) return null;
  return (leaf.view as unknown as FileExplorerView) ?? null;
}

function badgeHost(item: FileExplorerItem | undefined): HTMLElement | undefined {
  return item?.titleEl ?? item?.selfEl ?? item?.el;
}

interface PresenceUser {
  name: string;
  color: string;
}

function presenceUsersFor(room: ActiveRoom): PresenceUser[] {
  const awareness = room.provider.awareness as unknown as AwarenessLike | null;
  if (!awareness) return [];
  const users: PresenceUser[] = [];
  awareness.getStates().forEach((state) => {
    const name = state?.user?.name;
    if (typeof name === "string" && name.length > 0) {
      // Same color as that person's CM6 cursor — state.user.color is the
      // literal value broadcast for the cursor, so this guarantees a match
      // rather than risking drift from recomputing it separately.
      users.push({ name, color: state.user?.color ?? colorForUsername(name) });
    }
  });
  return users;
}

function renderBadge(item: FileExplorerItem, users: PresenceUser[]): void {
  const host = badgeHost(item);
  if (!host) return;

  host.querySelector(`.${BADGE_CLASS}`)?.remove();

  const badge = host.createSpan({ cls: BADGE_CLASS });

  const sharedIcon = badge.createSpan({ cls: "mm-shared-icon" });
  setIcon(sharedIcon, "link");
  sharedIcon.setAttribute("title", "Shared room");

  for (const user of users.slice(0, MAX_VISIBLE_DOTS)) {
    const dot = badge.createSpan({ cls: "mm-presence-dot" });
    dot.style.backgroundColor = user.color;
    dot.setAttribute("title", user.name);
  }

  if (users.length > MAX_VISIBLE_DOTS) {
    badge.createSpan({ cls: "mm-presence-overflow", text: `+${users.length - MAX_VISIBLE_DOTS}` });
  }
}

function clearBadge(item: FileExplorerItem | undefined): void {
  badgeHost(item)?.querySelector(`.${BADGE_CLASS}`)?.remove();
}

/**
 * Decorates the file explorer: a subtle dot on every linked room's folder,
 * plus one small colored circle per currently-connected person (from that
 * room's Yjs awareness — already carries {name, color} since each provider
 * sets its local awareness "user" field on creation). Needs no server
 * changes: awareness is already shared room-wide, independent of which file
 * (if any) is currently open.
 */
export class FolderPresenceManager {
  private awarenessCleanup = new Map<string, () => void>(); // roomId -> unsubscribe
  private lastFolders = new Set<string>();

  constructor(
    private app: App,
    private roomManager: RoomManager
  ) {}

  /** Call after every RoomManager.syncToLinkedRooms() — rooms may have been added/removed. */
  refresh(): void {
    const active = this.roomManager.getActiveRooms();
    const activeIds = new Set(active.map((r) => r.roomId));

    for (const [roomId, cleanup] of this.awarenessCleanup) {
      if (!activeIds.has(roomId)) {
        cleanup();
        this.awarenessCleanup.delete(roomId);
      }
    }

    for (const room of active) {
      if (this.awarenessCleanup.has(room.roomId)) continue;
      const awareness = room.provider.awareness as unknown as AwarenessLike | null;
      if (!awareness) continue;
      const listener = () => this.renderAll();
      awareness.on("change", listener);
      this.awarenessCleanup.set(room.roomId, () => awareness.off("change", listener));
    }

    this.renderAll();
  }

  /** Re-renders every badge. Call on room/presence changes and when the file explorer view itself may have been recreated. */
  renderAll(): void {
    const view = getFileExplorerView(this.app);
    const active = this.roomManager.getActiveRooms();
    const currentFolders = new Set(active.map((r) => r.vaultFolder));

    if (view?.fileItems) {
      for (const folder of this.lastFolders) {
        if (!currentFolders.has(folder)) clearBadge(view.fileItems[folder]);
      }
    }
    this.lastFolders = currentFolders;

    if (!view?.fileItems) return;
    for (const room of active) {
      const item = view.fileItems[room.vaultFolder];
      if (item) renderBadge(item, presenceUsersFor(room));
    }
  }

  destroy(): void {
    for (const cleanup of this.awarenessCleanup.values()) cleanup();
    this.awarenessCleanup.clear();

    const view = getFileExplorerView(this.app);
    if (view?.fileItems) {
      for (const folder of this.lastFolders) clearBadge(view.fileItems[folder]);
    }
    this.lastFolders.clear();
  }
}
