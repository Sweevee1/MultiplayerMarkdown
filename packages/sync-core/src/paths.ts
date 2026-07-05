/**
 * A room maps to one top-level shared folder. Y.Map keys inside a room's
 * doc are always relative to that folder's root, never vault-absolute —
 * so the room is independent of what a given device happens to name or
 * where it mounts the folder locally.
 */

export function isUnderFolder(vaultPath: string, folderRoot: string): boolean {
  return vaultPath === folderRoot || vaultPath.startsWith(`${folderRoot}/`);
}

export function toRelativePath(vaultPath: string, folderRoot: string): string {
  if (vaultPath === folderRoot) return "";
  const prefix = `${folderRoot}/`;
  if (!vaultPath.startsWith(prefix)) {
    throw new Error(`${vaultPath} is not under folder ${folderRoot}`);
  }
  return vaultPath.slice(prefix.length);
}

export function toVaultPath(relativePath: string, folderRoot: string): string {
  return relativePath ? `${folderRoot}/${relativePath}` : folderRoot;
}
