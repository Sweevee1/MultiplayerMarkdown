import { App, TFile } from "obsidian";
import * as Y from "yjs";
import {
  getFileText,
  listFilePaths,
  deleteFilePath,
  setFileContent,
  getFilesMap,
  getAttachmentsMetaMap,
  getAttachmentMeta,
  setAttachmentMeta,
  deleteAttachmentMeta,
  listAttachmentPaths,
  type AttachmentMeta,
  isUnderFolder,
  toRelativePath,
  toVaultPath,
} from "@multiplayer-markdown/sync-core";
import { sha256Hex, attachmentExistsRemotely, uploadAttachment, downloadAttachment } from "./attachment-client.js";

export interface FileSyncEngineOptions {
  app: App;
  doc: Y.Doc;
  targetFolder: string;
  apiUrl: string;
  roomId: string;
  getToken: () => string | null;
  /** True if `vaultPath` currently has a live CM6/yCollab binding — the
   * live editor already owns that file's content, so the engine must not
   * also write to disk for it (would race with Obsidian's own autosave). */
  isPathLiveBound: (vaultPath: string) => boolean;
}

/**
 * Keeps a vault folder in sync with a room's Y.Doc. Markdown files sync
 * their text content directly through the CRDT (files map); everything
 * else is treated as a binary attachment — content-addressed by hash,
 * uploaded/downloaded over HTTP, with only the lightweight
 * {hash,size,mtime} metadata synced through the CRDT (attachmentsMeta map).
 * Every local write this engine makes to reflect a remote change is tracked
 * in a "suppress next event" set so it doesn't re-trigger itself as if a
 * human had edited the file.
 */
export class FileSyncEngine {
  private app: App;
  private doc: Y.Doc;
  private targetFolder: string;
  private apiUrl: string;
  private roomId: string;
  private getToken: () => string | null;
  private isPathLiveBound: (vaultPath: string) => boolean;
  private filesMap: Y.Map<Y.Text>;
  private attachmentsMap: Y.Map<AttachmentMeta>;
  private suppressNextEvent = new Set<string>();
  private filesObserver = (events: Y.YEvent<any>[]) => this.handleRemoteFilesChange(events);
  private attachmentsObserver = (event: Y.YMapEvent<AttachmentMeta>) => this.handleRemoteAttachmentsChange(event);

  constructor(options: FileSyncEngineOptions) {
    this.app = options.app;
    this.doc = options.doc;
    this.targetFolder = options.targetFolder;
    this.apiUrl = options.apiUrl;
    this.roomId = options.roomId;
    this.getToken = options.getToken;
    this.isPathLiveBound = options.isPathLiveBound;
    this.filesMap = getFilesMap(this.doc);
    this.attachmentsMap = getAttachmentsMetaMap(this.doc);
  }

  start(): void {
    // Must be deep, not shallow: a new file is two separate Yjs changes —
    // (1) the key added to filesMap with an empty Y.Text, then (2) content
    // inserted into that Y.Text. A shallow observe() only fires for (1);
    // the actual content never arrives without observeDeep. Confirmed via
    // direct testing — vault-b received an empty file, not the content.
    this.filesMap.observeDeep(this.filesObserver);
    // Attachment metadata is a plain value object set atomically in one
    // .set() call (no nested create-then-fill step), so a shallow observe
    // is correct and sufficient here.
    this.attachmentsMap.observe(this.attachmentsObserver);
  }

  stop(): void {
    this.filesMap.unobserveDeep(this.filesObserver);
    this.attachmentsMap.unobserve(this.attachmentsObserver);
  }

  isUnderTarget(vaultPath: string): boolean {
    return isUnderFolder(vaultPath, this.targetFolder);
  }

  private toRelative(vaultPath: string): string {
    return toRelativePath(vaultPath, this.targetFolder);
  }

  private toVaultPath(relativePath: string): string {
    return toVaultPath(relativePath, this.targetFolder);
  }

  /** Run once at startup, after the workspace layout and provider sync are both ready. */
  async initialScan(): Promise<void> {
    await this.ensureFolderExists(this.targetFolder);

    const allLocal = this.app.vault.getFiles().filter((f) => this.isUnderTarget(f.path));
    const localMd = allLocal.filter((f) => f.extension === "md");
    const localAttachments = allLocal.filter((f) => f.extension !== "md");

    const localMdRelatives = new Set(localMd.map((f) => this.toRelative(f.path)));
    const remoteMdRelatives = new Set(listFilePaths(this.doc));

    for (const file of localMd) {
      const relative = this.toRelative(file.path);
      const content = await this.app.vault.read(file);
      setFileContent(this.doc, relative, content);
    }
    for (const relative of remoteMdRelatives) {
      if (!localMdRelatives.has(relative)) {
        const ytext = getFileText(this.doc, relative);
        if (ytext) await this.writeLocalFile(relative, ytext.toString());
      }
    }

    const localAttachmentRelatives = new Set(localAttachments.map((f) => this.toRelative(f.path)));
    const remoteAttachmentRelatives = new Set(listAttachmentPaths(this.doc));

    for (const file of localAttachments) {
      await this.syncLocalAttachmentToRemote(file.path);
    }
    for (const relative of remoteAttachmentRelatives) {
      if (!localAttachmentRelatives.has(relative)) {
        const meta = getAttachmentMeta(this.doc, relative);
        if (meta) await this.materializeAttachment(relative, meta);
      }
    }
  }

  async handleLocalCreate(vaultPath: string): Promise<void> {
    if (!this.isUnderTarget(vaultPath)) return;
    if (this.consumeSuppressed(vaultPath)) return;

    if (vaultPath.endsWith(".md")) {
      const file = this.app.vault.getAbstractFileByPath(vaultPath);
      if (!(file instanceof TFile)) return;
      const content = await this.app.vault.read(file);
      setFileContent(this.doc, this.toRelative(vaultPath), content);
    } else {
      await this.syncLocalAttachmentToRemote(vaultPath);
    }
  }

  async handleLocalModify(vaultPath: string): Promise<void> {
    if (!this.isUnderTarget(vaultPath)) return;
    if (this.consumeSuppressed(vaultPath)) return;

    if (vaultPath.endsWith(".md")) {
      if (this.isPathLiveBound(vaultPath)) return;
      const file = this.app.vault.getAbstractFileByPath(vaultPath);
      if (!(file instanceof TFile)) return;
      const content = await this.app.vault.read(file);
      setFileContent(this.doc, this.toRelative(vaultPath), content);
    } else {
      await this.syncLocalAttachmentToRemote(vaultPath);
    }
  }

  handleLocalDelete(vaultPath: string): void {
    if (!this.isUnderTarget(vaultPath)) return;
    if (this.consumeSuppressed(vaultPath)) return;

    if (vaultPath.endsWith(".md")) {
      deleteFilePath(this.doc, this.toRelative(vaultPath));
    } else {
      deleteAttachmentMeta(this.doc, this.toRelative(vaultPath));
    }
  }

  async handleLocalRename(newVaultPath: string, oldVaultPath: string): Promise<void> {
    const oldIsMd = oldVaultPath.endsWith(".md");
    const newIsMd = newVaultPath.endsWith(".md");

    if (this.isUnderTarget(oldVaultPath) && !this.consumeSuppressed(oldVaultPath)) {
      if (oldIsMd) {
        deleteFilePath(this.doc, this.toRelative(oldVaultPath));
      } else {
        deleteAttachmentMeta(this.doc, this.toRelative(oldVaultPath));
      }
    }
    if (this.isUnderTarget(newVaultPath) && !this.consumeSuppressed(newVaultPath)) {
      if (newIsMd) {
        const file = this.app.vault.getAbstractFileByPath(newVaultPath);
        if (file instanceof TFile) {
          const content = await this.app.vault.read(file);
          setFileContent(this.doc, this.toRelative(newVaultPath), content);
        }
      } else {
        await this.syncLocalAttachmentToRemote(newVaultPath);
      }
    }
  }

  private async syncLocalAttachmentToRemote(vaultPath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(vaultPath);
    if (!(file instanceof TFile)) return;

    const relative = this.toRelative(vaultPath);
    const data = await this.app.vault.readBinary(file);
    const hash = sha256Hex(data);

    const existingMeta = getAttachmentMeta(this.doc, relative);
    if (existingMeta?.hash === hash) return; // content hasn't actually changed

    const token = this.getToken();
    if (!token) return; // no auth yet; will be retried on the next relevant local event

    try {
      const alreadyOnServer = await attachmentExistsRemotely(this.apiUrl, token, this.roomId, hash);
      if (!alreadyOnServer) {
        await uploadAttachment(this.apiUrl, token, this.roomId, hash, data);
      }
      setAttachmentMeta(this.doc, relative, { hash, size: data.byteLength, mtime: file.stat.mtime });
    } catch (err) {
      console.error(`[multiplayer-markdown] failed to sync attachment ${vaultPath}`, err);
    }
  }

  private handleRemoteFilesChange(events: Y.YEvent<any>[]): void {
    const affectedRelativePaths = new Set<string>();

    for (const event of events) {
      if (event.target === this.filesMap) {
        // Top-level: a key was added, removed, or replaced wholesale.
        for (const key of (event as Y.YMapEvent<Y.Text>).keysChanged) {
          affectedRelativePaths.add(key);
        }
      } else if (event.path.length > 0) {
        // Nested: content changed inside an existing key's Y.Text. The
        // first path segment is the map key it lives under.
        affectedRelativePaths.add(String(event.path[0]));
      }
    }

    for (const relative of affectedRelativePaths) {
      const vaultPath = this.toVaultPath(relative);
      if (this.isPathLiveBound(vaultPath)) continue;

      const ytext = this.filesMap.get(relative);
      if (ytext) {
        void this.writeLocalFile(relative, ytext.toString());
      } else {
        void this.deleteLocalFile(vaultPath);
      }
    }
  }

  private handleRemoteAttachmentsChange(event: Y.YMapEvent<AttachmentMeta>): void {
    for (const relative of event.keysChanged) {
      const meta = this.attachmentsMap.get(relative);
      if (meta) {
        void this.materializeAttachment(relative, meta);
      } else {
        void this.deleteLocalFile(this.toVaultPath(relative));
      }
    }
  }

  private async materializeAttachment(relativePath: string, meta: AttachmentMeta): Promise<void> {
    const vaultPath = this.toVaultPath(relativePath);
    const existing = this.app.vault.getAbstractFileByPath(vaultPath);

    if (existing instanceof TFile) {
      const currentData = await this.app.vault.readBinary(existing);
      if (sha256Hex(currentData) === meta.hash) return; // already up to date
    }

    const token = this.getToken();
    if (!token) return;

    try {
      const data = await downloadAttachment(this.apiUrl, token, this.roomId, meta.hash);
      this.suppressNextEvent.add(vaultPath);
      if (existing instanceof TFile) {
        await this.app.vault.modifyBinary(existing, data);
      } else {
        await this.ensureParentFolder(vaultPath);
        await this.app.vault.createBinary(vaultPath, data);
      }
    } catch (err) {
      this.suppressNextEvent.delete(vaultPath);
      console.error(`[multiplayer-markdown] failed to materialize attachment ${vaultPath}`, err);
    }
  }

  private async writeLocalFile(relativePath: string, content: string): Promise<void> {
    const vaultPath = this.toVaultPath(relativePath);
    const existing = this.app.vault.getAbstractFileByPath(vaultPath);

    if (existing instanceof TFile) {
      const current = await this.app.vault.read(existing);
      if (current === content) return; // no-op: no event will fire, nothing to suppress
      this.suppressNextEvent.add(vaultPath);
      try {
        await this.app.vault.modify(existing, content);
      } catch (err) {
        this.suppressNextEvent.delete(vaultPath);
        console.error(`[multiplayer-markdown] failed to write ${vaultPath}`, err);
      }
      return;
    }

    this.suppressNextEvent.add(vaultPath);
    try {
      await this.ensureParentFolder(vaultPath);
      await this.app.vault.create(vaultPath, content);
    } catch (err) {
      this.suppressNextEvent.delete(vaultPath);
      console.error(`[multiplayer-markdown] failed to create ${vaultPath}`, err);
    }
  }

  private async deleteLocalFile(vaultPath: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(vaultPath);
    if (existing instanceof TFile) {
      this.suppressNextEvent.add(vaultPath);
      try {
        await this.app.vault.delete(existing);
      } catch (err) {
        this.suppressNextEvent.delete(vaultPath);
        console.error(`[multiplayer-markdown] failed to delete ${vaultPath}`, err);
      }
    }
  }

  private async ensureParentFolder(vaultPath: string): Promise<void> {
    const parts = vaultPath.split("/");
    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      await this.ensureFolderExists(current);
    }
  }

  private async ensureFolderExists(folderPath: string): Promise<void> {
    if (!this.app.vault.getAbstractFileByPath(folderPath)) {
      try {
        await this.app.vault.createFolder(folderPath);
      } catch {
        // race with another create, or it already exists — fine either way
      }
    }
  }

  private consumeSuppressed(vaultPath: string): boolean {
    if (this.suppressNextEvent.has(vaultPath)) {
      this.suppressNextEvent.delete(vaultPath);
      return true;
    }
    return false;
  }
}
