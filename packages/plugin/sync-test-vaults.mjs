import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const vaultsRoot = join(here, "..", "..", "test-vaults");
const vaults = ["vault-a", "vault-b"];

for (const vault of vaults) {
  const pluginDir = join(vaultsRoot, vault, ".obsidian", "plugins", "obsidian-collab");
  mkdirSync(pluginDir, { recursive: true });
  copyFileSync(join(here, "main.js"), join(pluginDir, "main.js"));
  copyFileSync(join(here, "manifest.json"), join(pluginDir, "manifest.json"));
  if (existsSync(join(here, "styles.css"))) {
    copyFileSync(join(here, "styles.css"), join(pluginDir, "styles.css"));
  }

  const obsidianDir = join(vaultsRoot, vault, ".obsidian");
  const communityPluginsFile = join(obsidianDir, "community-plugins.json");
  if (!existsSync(communityPluginsFile)) {
    // Must be the manifest's "id" (multiplayer-markdown), not the plugin
    // folder name (obsidian-collab) — Obsidian keys enabled-plugin state by
    // manifest id regardless of which folder the plugin lives in, so this
    // list entry silently failing to match means the plugin never actually
    // loads even though it looks installed.
    writeFileSync(communityPluginsFile, JSON.stringify(["multiplayer-markdown"], null, 2));
  }

  const testNote = join(vaultsRoot, vault, "Collab Test.md");
  if (!existsSync(testNote)) {
    writeFileSync(testNote, "");
  }

  console.log(`[sync-test-vaults] updated ${vault}`);
}
