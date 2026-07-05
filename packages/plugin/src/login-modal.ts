import { App, Modal, Setting, Notice } from "obsidian";
import { login } from "./api-client.js";

export class LoginModal extends Modal {
  private username = "";
  private password = "";

  constructor(
    app: App,
    private apiUrl: string,
    private onSuccess: (result: { token: string; username: string }) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Log in to Multiplayer Markdown server" });

    new Setting(contentEl).setName("Username").addText((text) =>
      text.onChange((value) => {
        this.username = value;
      })
    );

    new Setting(contentEl).setName("Password").addText((text) => {
      text.inputEl.type = "password";
      text.onChange((value) => {
        this.password = value;
      });
      text.inputEl.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter") this.submit();
      });
    });

    new Setting(contentEl).addButton((button) =>
      button
        .setButtonText("Log in")
        .setCta()
        .onClick(() => this.submit())
    );
  }

  private async submit(): Promise<void> {
    if (!this.username || !this.password) {
      new Notice("Enter a username and password");
      return;
    }
    try {
      const result = await login(this.apiUrl, this.username, this.password);
      this.close();
      this.onSuccess(result);
    } catch (err) {
      new Notice(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
