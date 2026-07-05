/**
 * Headless verification of the core CRDT sync mechanism: two independent
 * clients connect to the same room over a real WebSocket, edit concurrently,
 * and must converge to an identical, non-lossy merged document.
 *
 * This proves the server + Yjs + Hocuspocus provider stack works end-to-end.
 * It does NOT prove the Obsidian CM6 binding renders correctly — that step
 * requires opening the plugin in two real Obsidian vaults and is out of
 * reach for headless verification.
 */
import { Server } from "@hocuspocus/server";
import { HocuspocusProvider } from "@hocuspocus/provider";
import type { HocuspocusProviderConfiguration } from "@hocuspocus/provider";
import WebSocket from "ws";
import { roomDocumentName } from "@multiplayer-markdown/sync-core";

const PORT = 4499;
const ROOM = roomDocumentName("verify-sync-test");

function waitForSynced(provider: HocuspocusProvider): Promise<void> {
  return new Promise((resolve) => {
    if (provider.isSynced) return resolve();
    provider.on("synced", () => resolve());
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const server = new Server({ port: PORT });
  await server.listen();
  console.log(`[verify] server listening on ${PORT}`);

  // Node has no native WebSocket in scope, so each client needs the `ws`
  // polyfill. This combo (url + WebSocketPolyfill) is the shape that's
  // actually proven to work at runtime (verified end-to-end in Phase 1);
  // the published type only allows WebSocketPolyfill alongside
  // `websocketProvider`, but constructing one manually here changed the
  // provider's connection timing and it never synced. Cast past the
  // overly-strict type rather than the broken alternative shape.
  const makeProviderOptions = () =>
    ({
      url: `ws://127.0.0.1:${PORT}`,
      name: ROOM,
      WebSocketPolyfill: WebSocket as unknown,
    }) as unknown as HocuspocusProviderConfiguration;

  const clientA = new HocuspocusProvider(makeProviderOptions());
  const clientB = new HocuspocusProvider(makeProviderOptions());

  await Promise.all([waitForSynced(clientA), waitForSynced(clientB)]);
  console.log("[verify] both clients synced with server");

  const textA = clientA.document.getText("content");
  const textB = clientB.document.getText("content");

  // Concurrent, non-overlapping edits from both ends of the same document.
  textA.insert(0, "Hello from A. ");
  textB.insert(0, "Hello from B. ");

  // Give the sync protocol a moment to propagate over the real network round-trip.
  await sleep(1000);

  const finalA = textA.toString();
  const finalB = textB.toString();

  console.log(`[verify] clientA sees: ${JSON.stringify(finalA)}`);
  console.log(`[verify] clientB sees: ${JSON.stringify(finalB)}`);

  const converged = finalA === finalB;
  const noDataLoss = finalA.includes("Hello from A.") && finalA.includes("Hello from B.");

  clientA.destroy();
  clientB.destroy();
  await server.destroy();

  if (converged && noDataLoss) {
    console.log("[verify] PASS: concurrent edits from two independent clients converged with no data loss");
    process.exit(0);
  } else {
    console.error("[verify] FAIL: documents did not converge correctly");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[verify] ERROR", err);
  process.exit(1);
});
