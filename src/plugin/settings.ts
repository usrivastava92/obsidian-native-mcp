import { App, PluginSettingTab, Setting } from "obsidian";
import { VaultRegistry } from "../utils/vaults";
import type NativeMcpPlugin from "./main";

export class NativeMcpSettingTab extends PluginSettingTab {
  private plugin: NativeMcpPlugin;

  constructor(app: App, plugin: NativeMcpPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Obsidian Native MCP" });

    const url = this.plugin.getServerUrl();
    if (url) {
      new Setting(containerEl)
        .setName("MCP Server URL")
        .setDesc("Add this URL to your Claude Desktop config")
        .addText((text) => {
          text.setValue(url).setDisabled(true);
          text.inputEl.style.width = "100%";
        })
        .addButton((btn) => {
          btn.setButtonText("Copy").onClick(async () => {
            await (navigator as any).clipboard.writeText(url);
            btn.setButtonText("Copied!");
            setTimeout(() => btn.setButtonText("Copy"), 2000);
          });
        });
    } else {
      new Setting(containerEl)
        .setName("Server inactive")
        .setDesc("Select at least one vault below to start the MCP server.");
    }

    containerEl.createEl("h3", { text: "Vaults" });

    const allVaults = VaultRegistry.discoverFromObsidian();
    const selected = this.plugin.getSettings().selectedVaults;

    if (allVaults.length === 0) {
      containerEl.createEl("p", {
        text: "No Obsidian vaults found. Make sure Obsidian has been started at least once.",
      });
      return;
    }

    for (const vault of allVaults) {
      const isSelected = selected.includes(vault.name);
      new Setting(containerEl)
        .setName(vault.name)
        .setDesc(vault.path)
        .addToggle((toggle) =>
          toggle.setValue(isSelected).onChange(async (value) => {
            const newSelected = value
              ? [...selected, vault.name]
              : selected.filter((n) => n !== vault.name);
            await this.plugin.updateSelectedVaults(newSelected);
            this.display();
          }),
        );
    }
  }
}
