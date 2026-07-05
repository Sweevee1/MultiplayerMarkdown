import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Doc as YDoc } from "yjs";
import { roomIdFromDocumentName, listFilePaths, getFileText, setFileContent } from "@multiplayer-markdown/sync-core";

/**
 * Lists every markdown file under `rootDir`, relative to it, using forward
 * slashes regardless of platform. Returns [] if the directory doesn't exist
 * yet (a brand-new room with nothing persisted so far).
 */
async function listMarkdownFiles(rootDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(rootDir, { recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries.filter((entry) => entry.endsWith(".md")).map((entry) => entry.split(path.sep).join("/"));
}

function roomDirFor(documentName: string, vaultsRoot: string): string {
  const roomId = roomIdFromDocumentName(documentName);
  return path.join(vaultsRoot, roomId);
}

/**
 * Runs once, the first time a room is requested and doesn't yet exist in
 * server memory (Hocuspocus's onLoadDocument). Populates the fresh Y.Doc
 * from whatever markdown files already exist on disk for this room, using
 * the exact same setFileContent helper the Obsidian plugin uses — one
 * audited file<->Y.Text algorithm shared by both sides.
 */
export async function hydrateRoomFromDisk(documentName: string, doc: YDoc, vaultsRoot: string): Promise<void> {
  const roomDir = roomDirFor(documentName, vaultsRoot);
  const relativePaths = await listMarkdownFiles(roomDir);

  for (const relativePath of relativePaths) {
    const content = await fs.readFile(path.join(roomDir, ...relativePath.split("/")), "utf8");
    setFileContent(doc, relativePath, content);
  }
}

/**
 * Runs (debounced) whenever a room's Y.Doc changes (Hocuspocus's
 * onStoreDocument). Writes every current file to disk and removes any
 * disk file that's no longer present in the room, so the on-disk mirror
 * always matches the CRDT state exactly — including deletions.
 */
export async function writeRoomToDisk(documentName: string, doc: YDoc, vaultsRoot: string): Promise<void> {
  const roomDir = roomDirFor(documentName, vaultsRoot);
  await fs.mkdir(roomDir, { recursive: true });

  const currentPaths = new Set(listFilePaths(doc));

  for (const relativePath of currentPaths) {
    const ytext = getFileText(doc, relativePath);
    if (!ytext) continue;
    const absolutePath = path.join(roomDir, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, ytext.toString(), "utf8");
  }

  const onDisk = await listMarkdownFiles(roomDir);
  for (const relativePath of onDisk) {
    if (!currentPaths.has(relativePath)) {
      await fs.unlink(path.join(roomDir, ...relativePath.split("/")));
    }
  }
}
