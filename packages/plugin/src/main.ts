import { Plugin, editorInfoField, MarkdownView } from "obsidian";
import { EditorView, ViewPlugin, PluginValue } from "@codemirror/view";
import { EditorState, StateEffect, type Extension } from "@codemirror/state";
import { yCollab, yRemoteSelections } from "y-codemirror.next";
import { getOrCreateFileText, toRelativePath } from "@multiplayer-markdown/sync-core";
import { RoomManager } from "./room-manager.js";
import { CollabSettingTab } from "./settings-tab.js";
import { FolderPresenceManager } from "./folder-presence.js";
import { hardenedRemoteSelections } from "./remote-selections.js";
import { DEFAULT_SETTINGS, type CollabSettings } from "./settings.js";

let activeRoomManager: RoomManager | null = null;
const boundViews = new WeakSet<EditorView>();

function bindIfTarget(view: EditorView): void {
  if (boundViews.has(view) || !activeRoomManager) return;

  const info = view.state.field(editorInfoField, false);
  const file = info?.file;
  if (!file || !file.path.endsWith(".md")) return;

  const room = activeRoomManager.findRoomForPath(file.path);
  if (!room) return;

  boundViews.add(view);
  activeRoomManager.markLiveBound(file.path);
  console.log(`[multiplayer-markdown] binding yCollab to ${file.path} (room ${room.roomId}, role ${room.role})`);

  const relative = toRelativePath(file.path, room.vaultFolder);
  const ytext = getOrCreateFileText(room.provider.document, relative);
  const awareness = room.provider.awareness ?? null;
  const readOnly = room.role === "viewer";

  // Must defer: dispatching synchronously here runs while CM6 is still
  // mid-update (this fires from a ViewPlugin constructor), which throws
  // "Calls to EditorView.update are not allowed while an update is in
  // progress" and silently drops the reconfigure. Confirmed via direct
  // console capture during Phase 1 debugging.
  queueMicrotask(() => {
    // yCollab's own remote-selections plugin can throw and get permanently
    // destroyed by CM6 under a real race (see remote-selections.ts) — swap
    // it for a hardened equivalent that can't take the rest of the room's
    // cursors down with it. yCollab's declared return type is the opaque
    // `Extension`, but it's actually always a flat array at runtime (see its
    // own source) — safe to treat it as one here to filter a specific entry out.
    const collabExtensions = (yCollab(ytext, awareness) as unknown as Extension[]).filter((ext) => ext !== yRemoteSelections);
    if (awareness) collabExtensions.push(hardenedRemoteSelections);
    const effects = [StateEffect.appendConfig.of(collabExtensions)];
    if (readOnly) {
      // Client-side only, for UX (avoid the awkward "type but nothing
      // happens" feel). The server's onAuthenticate already enforces this
      // for real — dropping this line wouldn't be a security hole.
      effects.push(StateEffect.appendConfig.of(EditorState.readOnly.of(true)));
    }
    view.dispatch({ effects });
  });
}

class CollabBinder implements PluginValue {
  private path: string | undefined;

  constructor(view: EditorView) {
    this.path = view.state.field(editorInfoField, false)?.file?.path;
    bindIfTarget(view);
  }

  destroy() {
    if (this.path) activeRoomManager?.unmarkLiveBound(this.path);
  }
}

const collabBinderExtension = ViewPlugin.fromClass(CollabBinder);

function onLayoutReady(app: Plugin["app"], timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    app.workspace.onLayoutReady(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export default class CollabPlugin extends Plugin {
  settings: CollabSettings = DEFAULT_SETTINGS;
  roomManager!: RoomManager;
  folderPresenceManager!: FolderPresenceManager;

  async onload() {
    await this.loadSettingsData();

    this.roomManager = new RoomManager(
      this.app,
      this.settings.wsUrl,
      this.settings.apiUrl,
      () => this.settings.token,
      () => this.settings.username
    );
    activeRoomManager = this.roomManager;
    this.folderPresenceManager = new FolderPresenceManager(this.app, this.roomManager);

    // The file explorer view can be recreated independently of this plugin
    // (e.g. on vault reload) — re-render badges whenever that might have happened.
    this.registerEvent(this.app.workspace.on("layout-change", () => this.folderPresenceManager.renderAll()));

    this.registerEditorExtension(collabBinderExtension);
    this.app.workspace.updateOptions();

    this.addSettingTab(new CollabSettingTab(this.app, this));

    this.registerEvent(
      this.app.vault.on("create", (f) => this.roomManager.findRoomForPath(f.path)?.syncEngine.handleLocalCreate(f.path))
    );
    this.registerEvent(
      this.app.vault.on("modify", (f) => this.roomManager.findRoomForPath(f.path)?.syncEngine.handleLocalModify(f.path))
    );
    this.registerEvent(
      this.app.vault.on("delete", (f) => this.roomManager.findRoomForPath(f.path)?.syncEngine.handleLocalDelete(f.path))
    );
    this.registerEvent(
      this.app.vault.on("rename", (f, oldPath) => {
        const room = this.roomManager.findRoomForPath(f.path) ?? this.roomManager.findRoomForPath(oldPath);
        room?.syncEngine.handleLocalRename(f.path, oldPath);
      })
    );

    // onload() itself must return quickly no matter what: Obsidian appears
    // to await each plugin's onload() during its own startup, so any
    // unresolved promise in here (e.g. waiting on a server that's down)
    // blocks Obsidian's entire startup, not just this plugin. Confirmed
    // directly — a missing/unreachable dev server hung the whole app.
    void this.initializeAfterLoad();
  }

  private async initializeAfterLoad(): Promise<void> {
    try {
      await onLayoutReady(this.app);
      if (this.settings.token) {
        await this.roomManager.syncToLinkedRooms(this.settings.linkedRooms);
        this.folderPresenceManager.refresh();
        this.applyToOpenMarkdownEditors();
      }
    } catch (err) {
      console.error("[multiplayer-markdown] initialization failed", err);
    }
  }

  private applyToOpenMarkdownEditors(): void {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      const cm = (view.editor as unknown as { cm?: EditorView }).cm;
      if (cm) bindIfTarget(cm);
    }
  }

  async loadSettingsData(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettingsData(): Promise<void> {
    await this.saveData(this.settings);
  }

  onunload() {
    this.folderPresenceManager?.destroy();
    this.roomManager?.destroyAll();
    activeRoomManager = null;
    console.log("[multiplayer-markdown] plugin unloaded");
  }
}
