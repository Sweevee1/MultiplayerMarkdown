/**
 * Headless verification of the exact bug reported from a real production
 * deployment: a user disconnects (e.g. closes the app while offline),
 * keeps typing, then reconnects — and their offline edits must merge into
 * the shared document instead of being silently discarded.
 *
 * Root cause (confirmed via a standalone repro before this fix): sync-core's
 * getOrCreateFileText/setFileContent create a brand-new Y.Text for a path
 * if the *local* Y.Doc doesn't already have that key. A fresh Y.Doc (e.g.
 * after an app restart with no local persistence) has no way to know a
 * path's Y.Text already exists on the server until it actually syncs — so
 * seeding offline-typed content via setFileContent before ever syncing
 * creates a second, independent Y.Text assigned to the same Y.Map key.
 * Two independently-created values assigned to the same Y.Map key don't
 * merge on sync: Yjs's conflict resolution keeps exactly one and silently
 * discards the other's entire content.
 *
 * The fix (RoomManager in the plugin) hydrates each room's Y.Doc from
 * IndexedDB *before* anything else touches it, so a restarted client
 * already knows about every previously-synced file's real Y.Text object.
 * This test exercises that exact mechanism — real y-indexeddb (backed by
 * fake-indexeddb, the standard IndexedDB shim for Node) plus the real
 * sync-core helpers the plugin calls — against a real Hocuspocus server.
 */
import "fake-indexeddb/auto";
import { Server } from "@hocuspocus/server";
import { HocuspocusProvider } from "@hocuspocus/provider";
import type { HocuspocusProviderConfiguration } from "@hocuspocus/provider";
import WebSocket from "ws";
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import { roomDocumentName, setFileContent, getFileText } from "@multiplayer-markdown/sync-core";

const PORT = 4495;
const ROOM = roomDocumentName("verify-offline-merge-test");
const PERSISTENCE_NAME = "verify-offline-merge:test-vault:verify-offline-merge-test";
const PATH = "test.md";

function waitForSynced(provider: HocuspocusProvider): Promise<void> {
  return new Promise((resolve) => {
    if (provider.isSynced) return resolve();
    provider.on("synced", () => resolve());
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeProvider(): HocuspocusProvider {
  return new HocuspocusProvider({
    url: `ws://127.0.0.1:${PORT}`,
    name: ROOM,
    WebSocketPolyfill: WebSocket as unknown,
  } as unknown as HocuspocusProviderConfiguration);
}

async function main() {
  const server = new Server({ port: PORT });
  await server.listen();
  console.log(`[verify] server listening on ${PORT}`);

  // clientA: the "other peer" who stays connected the whole time and
  // originally creates the file — keeps the room alive on the server and
  // lets us read the final merged result independently of clientB.
  const clientA = makeProvider();
  await waitForSynced(clientA);
  setFileContent(clientA.document, PATH, "original content from before going offline");
  await sleep(500);

  // clientB, session 1: syncs normally, matching clientA's state, WITH
  // IndexedDB persistence attached (the fix) so its local knowledge of
  // this file's real Y.Text survives a restart.
  let clientB = makeProvider();
  let clientBPersistence = new IndexeddbPersistence(PERSISTENCE_NAME, clientB.document);
  await clientBPersistence.whenSynced;
  await waitForSynced(clientB);
  console.log("[verify] clientB (session 1) synced, sees:", JSON.stringify(getFileText(clientB.document, PATH)?.toString()));

  // Disconnect clientB — simulates going offline. Then destroy it entirely
  // (not just close the socket) to simulate a full app restart: nothing
  // survives in memory, only whatever IndexedDB persisted.
  clientB.destroy();
  await clientBPersistence.destroy();

  // clientB, session 2: brand-new Y.Doc/provider (as a real restart would
  // create), but hydrated from the SAME IndexedDB persistence name before
  // anything else touches the doc — exactly what RoomManager now does.
  clientB = makeProvider();
  clientBPersistence = new IndexeddbPersistence(PERSISTENCE_NAME, clientB.document);
  await clientBPersistence.whenSynced;

  // "Still offline" here: we deliberately do NOT await waitForSynced(clientB)
  // before typing — the whole point is that offline edits must be safe even
  // before the network catches up. The doc already knows this path's real
  // Y.Text from IndexedDB, so this reconciles into it instead of colliding.
  setFileContent(clientB.document, PATH, "original content from before going offline, PLUS an offline edit");
  console.log("[verify] clientB (session 2, offline) now has:", JSON.stringify(getFileText(clientB.document, PATH)?.toString()));

  // Reconnect.
  await waitForSynced(clientB);
  await sleep(500);

  const finalA = getFileText(clientA.document, PATH)?.toString();
  const finalB = getFileText(clientB.document, PATH)?.toString();

  console.log("[verify] after reconnect, clientA sees:", JSON.stringify(finalA));
  console.log("[verify] after reconnect, clientB sees:", JSON.stringify(finalB));

  const converged = finalA === finalB;
  const noDataLoss = !!finalA?.includes("original content from before going offline") && !!finalA?.includes("PLUS an offline edit");

  clientA.destroy();
  clientB.destroy();
  await clientBPersistence.destroy();
  await server.destroy();

  if (converged && noDataLoss) {
    console.log("[verify] PASS: offline edit survived a full disconnect/restart/reconnect cycle with no data loss");
    process.exit(0);
  } else {
    console.error("[verify] FAIL: offline edit was lost or documents did not converge");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[verify] ERROR", err);
  process.exit(1);
});
