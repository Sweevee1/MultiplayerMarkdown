import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type CollabPlugin from "./main.js";
import { fetchRooms, type RoomInfo } from "./api-client.js";
import { LoginModal } from "./login-modal.js";
import type { LinkedRoom } from "./settings.js";

export class CollabSettingTab extends PluginSettingTab {
  private availableRooms: RoomInfo[] = [];

  constructor(app: App, private plugin: CollabPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Multiplayer Markdown" });

    new Setting(containerEl)
      .setName("WebSocket URL")
      .setDesc("The Hocuspocus sync server, e.g. ws://localhost:4444")
      .addText((text) =>
        text.setValue(this.plugin.settings.wsUrl).onChange(async (value) => {
          this.plugin.settings.wsUrl = value;
          await this.plugin.saveSettingsData();
        })
      );

    new Setting(containerEl)
      .setName("API URL")
      .setDesc("The HTTP login/rooms API, e.g. http://localhost:4445")
      .addText((text) =>
        text.setValue(this.plugin.settings.apiUrl).onChange(async (value) => {
          this.plugin.settings.apiUrl = value;
          await this.plugin.saveSettingsData();
        })
      );

    new Setting(containerEl)
      .setName("Account")
      .setDesc(this.plugin.settings.username ? `Logged in as ${this.plugin.settings.username}` : "Not logged in")
      .addButton((button) => {
        if (this.plugin.settings.username) {
          button.setButtonText("Log out").onClick(async () => {
            this.plugin.settings.username = null;
            this.plugin.settings.token = null;
            await this.plugin.saveSettingsData();
            await this.plugin.roomManager.syncToLinkedRooms(this.plugin.settings.linkedRooms);
            this.display();
          });
        } else {
          button
            .setButtonText("Log in")
            .setCta()
            .onClick(() => {
              new LoginModal(this.app, this.plugin.settings.apiUrl, async (result) => {
                this.plugin.settings.token = result.token;
                this.plugin.settings.username = result.username;
                await this.plugin.saveSettingsData();
                new Notice(`Logged in as ${result.username}`);
                this.display();
              }).open();
            });
        }
      });

    if (!this.plugin.settings.token) return;

    containerEl.createEl("h3", { text: "Rooms" });

    new Setting(containerEl).addButton((button) =>
      button.setButtonText("Refresh room list").onClick(async () => {
        try {
          this.availableRooms = await fetchRooms(this.plugin.settings.apiUrl, this.plugin.settings.token!);
          this.display();
        } catch (err) {
          new Notice(`Failed to fetch rooms: ${err instanceof Error ? err.message : String(err)}`);
        }
      })
    );

    for (const room of this.availableRooms) {
      const linked = this.plugin.settings.linkedRooms.find((r) => r.roomId === room.id);

      const setting = new Setting(containerEl)
        .setName(`${room.label} (${room.role})`)
        .setDesc(linked ? `Synced to folder: ${linked.vaultFolder}` : "Not synced");

      setting.addText((text) => {
        text.setPlaceholder("Local folder, e.g. Shared").setValue(linked?.vaultFolder ?? "");
        // Reconnecting on every keystroke would tear down/recreate the room
        // connection mid-typing; only apply once the field loses focus.
        text.inputEl.addEventListener("blur", async () => {
          const value = text.getValue();
          const rooms = this.plugin.settings.linkedRooms.filter((r) => r.roomId !== room.id);
          if (value.trim()) {
            const newLinked: LinkedRoom = {
              roomId: room.id,
              label: room.label,
              role: room.role,
              vaultFolder: value.trim(),
            };
            rooms.push(newLinked);
          }
          this.plugin.settings.linkedRooms = rooms;
          await this.plugin.saveSettingsData();
          await this.plugin.roomManager.syncToLinkedRooms(this.plugin.settings.linkedRooms);
          this.display();
        });
      });
    }
  }
}
