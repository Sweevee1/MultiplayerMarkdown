import { requestUrl } from "obsidian";
import * as crypto from "crypto";

export function sha256Hex(data: ArrayBuffer): string {
  return crypto.createHash("sha256").update(Buffer.from(data)).digest("hex");
}

function attachmentUrl(apiUrl: string, roomId: string, hash: string): string {
  return `${apiUrl}/api/rooms/${roomId}/attachments/${hash}`;
}

export async function attachmentExistsRemotely(
  apiUrl: string,
  token: string,
  roomId: string,
  hash: string
): Promise<boolean> {
  const res = await requestUrl({
    url: attachmentUrl(apiUrl, roomId, hash),
    method: "HEAD",
    headers: { Authorization: `Bearer ${token}` },
    throw: false,
  });
  return res.status === 200;
}

export async function uploadAttachment(
  apiUrl: string,
  token: string,
  roomId: string,
  hash: string,
  data: ArrayBuffer
): Promise<void> {
  const res = await requestUrl({
    url: attachmentUrl(apiUrl, roomId, hash),
    method: "PUT",
    headers: { Authorization: `Bearer ${token}` },
    body: data,
    throw: false,
  });
  if (res.status !== 200) {
    throw new Error(`Failed to upload attachment (HTTP ${res.status})`);
  }
}

export async function downloadAttachment(
  apiUrl: string,
  token: string,
  roomId: string,
  hash: string
): Promise<ArrayBuffer> {
  const res = await requestUrl({
    url: attachmentUrl(apiUrl, roomId, hash),
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    throw: false,
  });
  if (res.status !== 200) {
    throw new Error(`Failed to download attachment (HTTP ${res.status})`);
  }
  return res.arrayBuffer;
}
