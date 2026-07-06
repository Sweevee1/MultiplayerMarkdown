import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type CollabPlugin from "./main.js";
import {
  fetchRooms,
  createRoom,
  fetchRoomMembers,
  inviteToRoom,
  removeFromRoom,
  type RoomInfo,
  type MemberInfo,
} from "./api-client.js";
import { LoginModal } from "./login-modal.js";
import type { LinkedRoom, Role } from "./settings.js";

/** Lowercase, alnum-and-dash-only room id derived from a human-readable name, matching the server's ROOM_ID_PATTERN. */
function slugifyRoomId(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export class CollabSettingTab extends PluginSettingTab {
  private availableRooms: RoomInfo[] = [];
  private newRoomLabel = "";
  private newRoomFolder = "";
  private expandedMembersRoomId: string | null = null;
  private roomMembers: MemberInfo[] = [];
  private membersError: string | null = null;

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
            this.plugin.folderPresenceManager.refresh();
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

    containerEl.createEl("h3", { text: "Create a room" });

    new Setting(containerEl)
      .setName("Room name")
      .setDesc('Creates a new shared room and makes you its editor. Share the name with others, then use "Manage members" below to grant them access.')
      .addText((text) =>
        text.setPlaceholder("e.g. Team Notes").onChange((value) => {
          this.newRoomLabel = value;
        })
      );

    new Setting(containerEl)
      .setName("Local folder")
      .setDesc("Vault-relative folder to sync this room to, e.g. Shared. Defaults to the room name.")
      .addText((text) =>
        text.setPlaceholder("e.g. Team Notes").onChange((value) => {
          this.newRoomFolder = value;
        })
      );

    new Setting(containerEl).addButton((button) =>
      button
        .setButtonText("Create room")
        .setCta()
        .onClick(async () => {
          const label = this.newRoomLabel.trim();
          const roomId = slugifyRoomId(label);
          if (!label || !roomId) {
            new Notice("Enter a room name");
            return;
          }
          const vaultFolder = this.newRoomFolder.trim() || label;
          try {
            const room = await createRoom(this.plugin.settings.apiUrl, this.plugin.settings.token!, roomId, label);
            this.plugin.settings.linkedRooms = [
              ...this.plugin.settings.linkedRooms,
              { roomId: room.id, label: room.label, role: room.role, vaultFolder },
            ];
            await this.plugin.saveSettingsData();
            await this.plugin.roomManager.syncToLinkedRooms(this.plugin.settings.linkedRooms);
            this.plugin.folderPresenceManager.refresh();
            this.newRoomLabel = "";
            this.newRoomFolder = "";
            new Notice(`Created room "${room.label}"`);
            this.display();
          } catch (err) {
            new Notice(`Failed to create room: ${err instanceof Error ? err.message : String(err)}`);
          }
        })
    );

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
          this.plugin.folderPresenceManager.refresh();
          this.display();
        });
      });

      // Any editor (not just the room's creator) may manage its members —
      // matches the server's symmetric editor permission model.
      if (room.role === "editor") {
        setting.addButton((button) =>
          button.setButtonText("Manage members").onClick(() => {
            const opening = this.expandedMembersRoomId !== room.id;
            this.expandedMembersRoomId = opening ? room.id : null;
            this.roomMembers = [];
            this.membersError = null;
            this.display();
            if (opening) void this.loadMembers(room.id);
          })
        );
      }

      if (this.expandedMembersRoomId === room.id) {
        this.renderMembersPanel(containerEl, room);
      }
    }
  }

  private async loadMembers(roomId: string): Promise<void> {
    try {
      this.roomMembers = await fetchRoomMembers(this.plugin.settings.apiUrl, this.plugin.settings.token!, roomId);
      this.membersError = null;
    } catch (err) {
      this.membersError = err instanceof Error ? err.message : String(err);
    }
    this.display();
  }

  private renderMembersPanel(containerEl: HTMLElement, room: RoomInfo): void {
    const panel = containerEl.createDiv({ cls: "mm-members-panel" });

    if (this.membersError) {
      panel.createEl("p", { text: `Failed to load members: ${this.membersError}` });
      return;
    }

    for (const member of this.roomMembers) {
      new Setting(panel)
        .setName(member.username)
        .setDesc(member.role)
        .addButton((button) =>
          button.setButtonText("Remove").onClick(async () => {
            try {
              await removeFromRoom(this.plugin.settings.apiUrl, this.plugin.settings.token!, room.id, member.username);
              await this.loadMembers(room.id);
            } catch (err) {
              new Notice(`Failed to remove ${member.username}: ${err instanceof Error ? err.message : String(err)}`);
            }
          })
        );
    }

    let inviteUsername = "";
    let inviteRole: Role = "viewer";
    new Setting(panel)
      .setName("Invite someone")
      .setDesc("They must already have an account on this server")
      .addText((text) => {
        text.setPlaceholder("Username").onChange((value) => {
          inviteUsername = value;
        });
      })
      .addDropdown((dropdown) => {
        dropdown
          .addOption("viewer", "Viewer")
          .addOption("editor", "Editor")
          .setValue("viewer")
          .onChange((value) => {
            inviteRole = value as Role;
          });
      })
      .addButton((button) =>
        button
          .setButtonText("Invite")
          .setCta()
          .onClick(async () => {
            const username = inviteUsername.trim();
            if (!username) {
              new Notice("Enter a username");
              return;
            }
            try {
              await inviteToRoom(this.plugin.settings.apiUrl, this.plugin.settings.token!, room.id, username, inviteRole);
              new Notice(`Invited ${username}`);
              await this.loadMembers(room.id);
            } catch (err) {
              new Notice(`Failed to invite ${username}: ${err instanceof Error ? err.message : String(err)}`);
            }
          })
      );
  }
}
