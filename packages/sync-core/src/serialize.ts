import * as Y from "yjs";
import diff from "fast-diff";

export const FILES_MAP_KEY = "files";

export function getFilesMap(doc: Y.Doc): Y.Map<Y.Text> {
  return doc.getMap<Y.Text>(FILES_MAP_KEY);
}

export function getOrCreateFileText(doc: Y.Doc, path: string): Y.Text {
  const files = getFilesMap(doc);
  let ytext = files.get(path);
  if (!ytext) {
    ytext = new Y.Text();
    files.set(path, ytext);
  }
  return ytext;
}

export function getFileText(doc: Y.Doc, path: string): Y.Text | undefined {
  return getFilesMap(doc).get(path);
}

export function listFilePaths(doc: Y.Doc): string[] {
  return Array.from(getFilesMap(doc).keys());
}

export function deleteFilePath(doc: Y.Doc, path: string): void {
  getFilesMap(doc).delete(path);
}

/**
 * Reconciles a Y.Text's content to match `newContent` by applying only the
 * minimal insert/delete diff, not a clear+reinsert. This matters because a
 * clear+reinsert would show up as "delete everything, retype everything" to
 * every other connected collaborator (destroying their cursor position and
 * conflicting with any concurrent edit at the CRDT level), whereas a diff
 * applies just the actual changed region as ops that merge cleanly.
 */
export function reconcileYTextWithContent(ytext: Y.Text, newContent: string): void {
  const oldContent = ytext.toString();
  if (oldContent === newContent) return;

  const applyOps = () => {
    const changes = diff(oldContent, newContent);
    let index = 0;
    for (const [op, text] of changes) {
      if (op === diff.EQUAL) {
        index += text.length;
      } else if (op === diff.INSERT) {
        ytext.insert(index, text);
        index += text.length;
      } else if (op === diff.DELETE) {
        ytext.delete(index, text.length);
      }
    }
  };

  const doc = ytext.doc;
  if (doc) {
    doc.transact(applyOps);
  } else {
    applyOps();
  }
}

/**
 * Sets a path's content, creating its Y.Text entry if needed — as ONE
 * atomic transaction. This matters: creating the Y.Text entry (a Y.Map key
 * add) and inserting its initial content are otherwise two separate
 * transactions, so any change-observer (ours included) fires twice — once
 * with an empty placeholder, once with the real content — and two async
 * reactions to those two firings can land out of order. Confirmed directly:
 * this raced with itself and left a renamed file's content empty on disk.
 * Wrapping both steps in one transact() means observers only ever see the
 * final, complete state.
 */
export function setFileContent(doc: Y.Doc, path: string, content: string): void {
  doc.transact(() => {
    const ytext = getOrCreateFileText(doc, path);
    reconcileYTextWithContent(ytext, content);
  });
}

export const ATTACHMENTS_META_MAP_KEY = "attachmentsMeta";

export interface AttachmentMeta {
  hash: string;
  size: number;
  mtime: number;
}

/**
 * Attachments (images, PDFs, etc.) live outside Yjs entirely — only this
 * lightweight metadata syncs through the CRDT layer. The actual bytes are
 * fetched over HTTP, content-addressed by hash, once a peer notices a
 * relativePath -> hash mapping it doesn't have locally yet.
 */
export function getAttachmentsMetaMap(doc: Y.Doc): Y.Map<AttachmentMeta> {
  return doc.getMap<AttachmentMeta>(ATTACHMENTS_META_MAP_KEY);
}

export function listAttachmentPaths(doc: Y.Doc): string[] {
  return Array.from(getAttachmentsMetaMap(doc).keys());
}

export function getAttachmentMeta(doc: Y.Doc, path: string): AttachmentMeta | undefined {
  return getAttachmentsMetaMap(doc).get(path);
}

export function setAttachmentMeta(doc: Y.Doc, path: string, meta: AttachmentMeta): void {
  getAttachmentsMetaMap(doc).set(path, meta);
}

export function deleteAttachmentMeta(doc: Y.Doc, path: string): void {
  getAttachmentsMetaMap(doc).delete(path);
}
