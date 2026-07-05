import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";

/**
 * Attachments live entirely outside the Yjs/CRDT layer (Yjs isn't suited to
 * large binary blobs) — plain content-addressed files on disk, one store
 * per room so the room-membership check that already gates everything else
 * gates these too. Only lightweight metadata (hash/size/mtime) goes in the
 * room's Y.Doc; the actual bytes are fetched over HTTP on demand.
 */

export function sha256Hex(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function attachmentPath(attachmentsRoot: string, roomId: string, hash: string): string {
  return path.join(attachmentsRoot, roomId, hash);
}

export async function attachmentExists(attachmentsRoot: string, roomId: string, hash: string): Promise<boolean> {
  try {
    await fs.access(attachmentPath(attachmentsRoot, roomId, hash));
    return true;
  } catch {
    return false;
  }
}

export async function readAttachment(attachmentsRoot: string, roomId: string, hash: string): Promise<Buffer> {
  return fs.readFile(attachmentPath(attachmentsRoot, roomId, hash));
}

/**
 * Writes an attachment, verifying the uploaded bytes actually hash to the
 * claimed value first — refusing to let a client (accidentally or
 * maliciously) store content under a hash that doesn't match it, which
 * would poison the content-addressed store for every other reader.
 */
export async function writeAttachment(
  attachmentsRoot: string,
  roomId: string,
  claimedHash: string,
  data: Buffer
): Promise<void> {
  const actualHash = sha256Hex(data);
  if (actualHash !== claimedHash) {
    throw new Error(`Uploaded content hash (${actualHash}) does not match claimed hash (${claimedHash})`);
  }
  const filePath = attachmentPath(attachmentsRoot, roomId, claimedHash);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, data);
}
