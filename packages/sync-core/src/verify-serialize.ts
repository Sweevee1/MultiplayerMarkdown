/**
 * Headless smoke test for the files-map + diff-reconciliation logic.
 * Not a full test framework — just fast, dependency-free assertions run via tsx.
 */
import * as Y from "yjs";
import {
  getOrCreateFileText,
  getFileText,
  listFilePaths,
  deleteFilePath,
  reconcileYTextWithContent,
  setFileContent,
  getFilesMap,
  getAttachmentMeta,
  setAttachmentMeta,
  deleteAttachmentMeta,
  listAttachmentPaths,
} from "./serialize.js";
import { isUnderFolder, toRelativePath, toVaultPath } from "./paths.js";

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    console.error(`[verify] FAIL: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    process.exitCode = 1;
  } else {
    console.log(`[verify] OK: ${label}`);
  }
}

// --- files map basics ---
const doc = new Y.Doc();
const t1 = getOrCreateFileText(doc, "a.md");
t1.insert(0, "hello");
assertEqual(getFileText(doc, "a.md")?.toString(), "hello", "getOrCreateFileText then getFileText round-trips");
assertEqual(listFilePaths(doc).join(","), "a.md", "listFilePaths lists inserted path");

getOrCreateFileText(doc, "b.md").insert(0, "world");
assertEqual(listFilePaths(doc).sort().join(","), "a.md,b.md", "listFilePaths lists multiple paths");

deleteFilePath(doc, "a.md");
assertEqual(listFilePaths(doc).join(","), "b.md", "deleteFilePath removes the path");

// --- attachments metadata map ---
const attachDoc = new Y.Doc();
setAttachmentMeta(attachDoc, "images/photo.png", { hash: "abc123", size: 1024, mtime: 111 });
assertEqual(
  JSON.stringify(getAttachmentMeta(attachDoc, "images/photo.png")),
  JSON.stringify({ hash: "abc123", size: 1024, mtime: 111 }),
  "setAttachmentMeta then getAttachmentMeta round-trips"
);
assertEqual(listAttachmentPaths(attachDoc).join(","), "images/photo.png", "listAttachmentPaths lists the path");
deleteAttachmentMeta(attachDoc, "images/photo.png");
assertEqual(listAttachmentPaths(attachDoc).length, 0, "deleteAttachmentMeta removes the path");

// --- setFileContent must be one atomic change, not two (create-key then insert-content) ---
// Regression test: a deep observer reacting separately to "key added" (empty)
// and "content inserted" can race with itself and end up writing the empty
// intermediate state to disk instead of the final content. Confirmed via
// direct testing with a real rename in Obsidian. setFileContent must fire
// the observer exactly once, already containing the final content.
const raceDoc = new Y.Doc();
let observerFireCount = 0;
let contentSeenOnFire = "";
getFilesMap(raceDoc).observeDeep(() => {
  observerFireCount += 1;
  contentSeenOnFire = getFileText(raceDoc, "new-file.md")?.toString() ?? "";
});
setFileContent(raceDoc, "new-file.md", "brand new file content");
assertEqual(observerFireCount, 1, "setFileContent on a brand-new path fires the observer exactly once");
assertEqual(contentSeenOnFire, "brand new file content", "observer sees the final content, not an empty intermediate state");

// --- diff reconciliation: minimal-diff, not clear+reinsert ---
const doc2 = new Y.Doc();
const t2 = getOrCreateFileText(doc2, "note.md");
t2.insert(0, "The quick brown fox");
reconcileYTextWithContent(t2, "The quick red fox jumps");
assertEqual(t2.toString(), "The quick red fox jumps", "reconcileYTextWithContent converges to new content");

// no-op when content is already identical (should not throw, should be a no-op)
reconcileYTextWithContent(t2, "The quick red fox jumps");
assertEqual(t2.toString(), "The quick red fox jumps", "reconcileYTextWithContent is idempotent no-op when unchanged");

// --- diff reconciliation must merge with a concurrent remote insert, not clobber it ---
const docA = new Y.Doc();
const docB = new Y.Doc();
Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA)); // start in sync (both empty)

const textA = getOrCreateFileText(docA, "shared.md");
textA.insert(0, "line one");
Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)));

// Meanwhile, docB's user reconciles a local disk edit (simulating "edited while closed")
const textB = getOrCreateFileText(docB, "shared.md");
reconcileYTextWithContent(textB, "line one, edited locally in B");

// And concurrently, docA's user also made a live edit before the sync round-trip
textA.insert(textA.length, " (live edit in A)");

// Now sync both directions, as the real network would
Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)));
Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));

const finalA = getFileText(docA, "shared.md")!.toString();
const finalB = getFileText(docB, "shared.md")!.toString();
assertEqual(finalA, finalB, "concurrent edit (A) + disk reconciliation (B) converge to the same result");
assertEqual(finalA.includes("edited locally in B"), true, "converged result retains B's disk-reconciled edit");
assertEqual(finalA.includes("live edit in A"), true, "converged result retains A's concurrent live edit");

// --- path helpers ---
assertEqual(isUnderFolder("Shared/note.md", "Shared"), true, "isUnderFolder true for direct child");
assertEqual(isUnderFolder("Shared/sub/note.md", "Shared"), true, "isUnderFolder true for nested child");
assertEqual(isUnderFolder("SharedButNot/note.md", "Shared"), false, "isUnderFolder false for prefix-only false-positive");
assertEqual(isUnderFolder("Other/note.md", "Shared"), false, "isUnderFolder false for unrelated folder");
assertEqual(toRelativePath("Shared/sub/note.md", "Shared"), "sub/note.md", "toRelativePath strips folder root");
assertEqual(toVaultPath("sub/note.md", "Shared"), "Shared/sub/note.md", "toVaultPath re-adds folder root");
assertEqual(toVaultPath(toRelativePath("Shared/a.md", "Shared"), "Shared"), "Shared/a.md", "relative/vault path round-trip");

if (process.exitCode === 1) {
  console.error("[verify] SOME CHECKS FAILED");
  process.exit(1);
} else {
  console.log("[verify] ALL CHECKS PASSED");
  process.exit(0);
}
