export * from "./serialize.js";
export * from "./paths.js";

export const ROOM_PREFIX = "room:";

export function roomDocumentName(roomId: string): string {
  return `${ROOM_PREFIX}${roomId}`;
}

export function roomIdFromDocumentName(documentName: string): string {
  if (!documentName.startsWith(ROOM_PREFIX)) {
    throw new Error(`Not a room document name: ${documentName}`);
  }
  return documentName.slice(ROOM_PREFIX.length);
}
