/**
 * Headless verification of server-side disk persistence: create a room,
 * write files into it, persist to disk, tear down the in-memory Y.Doc
 * entirely (simulating a server restart), then hydrate a brand new Y.Doc
 * from disk and confirm the content survives byte-for-byte — including a
 * deletion actually removing the file on disk.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as Y from "yjs";
import { roomDocumentName, setFileContent, deleteFilePath, listFilePaths } from "@multiplayer-markdown/sync-core";
import { hydrateRoomFromDisk, writeRoomToDisk } from "./persistence.js";

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    console.error(`[verify] FAIL: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    process.exitCode = 1;
  } else {
    console.log(`[verify] OK: ${label}`);
  }
}

async function main() {
  const vaultsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "multiplayer-markdown-persist-test-"));
  const documentName = roomDocumentName("persist-test");

  // --- first "server session": write some files, persist, "restart" ---
  const doc1 = new Y.Doc();
  setFileContent(doc1, "note1.md", "hello from note1");
  setFileContent(doc1, "sub/nested.md", "a nested file");
  setFileContent(doc1, "note-to-delete.md", "this will be deleted");
  await writeRoomToDisk(documentName, doc1, vaultsRoot);

  const onDiskAfterFirstWrite = await fs.readFile(path.join(vaultsRoot, "persist-test", "note1.md"), "utf8");
  assertEqual(onDiskAfterFirstWrite, "hello from note1", "top-level file written to disk correctly");

  const nestedOnDisk = await fs.readFile(path.join(vaultsRoot, "persist-test", "sub", "nested.md"), "utf8");
  assertEqual(nestedOnDisk, "a nested file", "nested subfolder file written to disk correctly");

  // Simulate deleting a file, then persisting again — the on-disk file must actually go away.
  deleteFilePath(doc1, "note-to-delete.md");
  await writeRoomToDisk(documentName, doc1, vaultsRoot);
  const deletedFileGone = await fs
    .access(path.join(vaultsRoot, "persist-test", "note-to-delete.md"))
    .then(() => false)
    .catch(() => true);
  assertEqual(deletedFileGone, true, "deleting a file from the Y.Doc removes it from disk on next persist");

  // --- "server restart": brand new Y.Doc, no shared memory with doc1 at all ---
  const doc2 = new Y.Doc();
  await hydrateRoomFromDisk(documentName, doc2, vaultsRoot);

  assertEqual(
    doc2.getMap("files").get("note1.md")?.toString(),
    "hello from note1",
    "hydrated doc recovers top-level file content after simulated restart"
  );
  assertEqual(
    doc2.getMap("files").get("sub/nested.md")?.toString(),
    "a nested file",
    "hydrated doc recovers nested file content after simulated restart"
  );
  assertEqual(
    listFilePaths(doc2).includes("note-to-delete.md"),
    false,
    "hydrated doc does not resurrect a file that was deleted before restart"
  );

  // --- a brand new room with nothing on disk yet must hydrate to empty, not throw ---
  const doc3 = new Y.Doc();
  await hydrateRoomFromDisk(roomDocumentName("never-seen-before"), doc3, vaultsRoot);
  assertEqual(listFilePaths(doc3).length, 0, "hydrating a room with no prior disk state yields an empty doc, no throw");

  await fs.rm(vaultsRoot, { recursive: true, force: true });

  if (process.exitCode === 1) {
    console.error("[verify] SOME CHECKS FAILED");
    process.exit(1);
  } else {
    console.log("[verify] ALL CHECKS PASSED");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("[verify] ERROR", err);
  process.exit(1);
});
