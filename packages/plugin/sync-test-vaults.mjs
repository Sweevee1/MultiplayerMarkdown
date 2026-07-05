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

  const obsidianDir = join(vaultsRoot, vault, ".obsidian");
  const communityPluginsFile = join(obsidianDir, "community-plugins.json");
  if (!existsSync(communityPluginsFile)) {
    writeFileSync(communityPluginsFile, JSON.stringify(["obsidian-collab"], null, 2));
  }

  const testNote = join(vaultsRoot, vault, "Collab Test.md");
  if (!existsSync(testNote)) {
    writeFileSync(testNote, "");
  }

  console.log(`[sync-test-vaults] updated ${vault}`);
}
