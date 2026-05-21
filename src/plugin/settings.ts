/**
 * Plugin settings UI: vault picker, server URL display + copy, token rotate,
 * read-only toggle, per-tool toggles, audit-log tail viewer.
 */

import { App, Notice, PluginSettingTab, Setting, ButtonComponent } from "obsidian";

declare const navigator: { clipboard: { writeText(text: string): Promise<void> } };
import type ObsidianNativeMcpPlugin from "./main.js";
import { VaultRegistry } from "../vault/registry.js";
import { AuditLog } from "../audit/log.js";

const ALL_TOOL_NAMES = [
  // reads (always safe)
  "vault.list",
  "vault.info",
  "file.list",
  "file.find",
  "file.read",
  "file.read_range",
  "outline",
  "heading.find",
  "block.find",
  "frontmatter.get",
  "tags.list",
  "links.get",
  "metadata.read",
  "search.content",
  "file.diff",
  // writes
  "str_replace",
  "apply_patch",
  "apply_edits",
  "heading.replace_body",
  "heading.rename",
  "block.replace",
  "block.rename",
  "frontmatter.set",
  "frontmatter.delete",
  "lines.replace",
  "lines.insert",
  "file.create",
  "file.replace",
  "file.append",
  "file.move",
  "file.delete",
  "bulk.apply",
  "regex.replace",
];

export class SettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: ObsidianNativeMcpPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Obsidian Native MCP" });

    // --- Server URL & token ----------------------------------------------
    const url = this.plugin.getServerUrl();
    const urlSetting = new Setting(containerEl)
      .setName("MCP Server URL")
      .setDesc("Paste this into your AI client's MCP server config.");
    if (url) {
      urlSetting.addText((t) => t.setValue(url).setDisabled(true));
      urlSetting.addButton((b) =>
        b.setButtonText("Copy").onClick(async () => {
          await navigator.clipboard.writeText(url);
          new Notice("URL copied.");
        }),
      );
    } else {
      urlSetting.setDesc("Server not running. Enable at least one vault below.");
    }

    new Setting(containerEl)
      .setName("Rotate token")
      .setDesc("Generate a new bearer token (restarts the server).")
      .addButton((b: ButtonComponent) =>
        b
          .setButtonText("Rotate")
          .setWarning()
          .onClick(async () => {
            await this.plugin.rotateToken();
            this.display();
          }),
      );

    // --- Port ------------------------------------------------------------
    new Setting(containerEl)
      .setName("Port")
      .setDesc("HTTP port (restart required).")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.port)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (Number.isInteger(n) && n > 0 && n < 65536) {
            this.plugin.settings.port = n;
            await this.plugin.saveSettings();
          }
        }),
      )
      .addButton((b) =>
        b.setButtonText("Restart server").onClick(async () => {
          await this.plugin.restartServer();
          this.display();
        }),
      );

    // --- Read-only -------------------------------------------------------
    new Setting(containerEl)
      .setName("Read-only mode")
      .setDesc(
        "Block all mutating tools. Recommended when granting access to less-trusted clients.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.readOnly).onChange(async (v) => {
          this.plugin.settings.readOnly = v;
          await this.plugin.saveSettings();
          await this.plugin.restartServer();
        }),
      );

    // --- Vaults ----------------------------------------------------------
    containerEl.createEl("h3", { text: "Vaults" });
    void this.renderVaults(containerEl);

    // --- Tool toggles ----------------------------------------------------
    const toolsHeader = containerEl.createEl("h3", { text: "Tools" });
    toolsHeader.createEl("br");
    const desc = containerEl.createEl("p", {
      text: "Disable individual tools you don't want exposed (default: regex.replace off).",
    });
    desc.style.opacity = "0.8";
    for (const name of ALL_TOOL_NAMES) {
      const enabled = this.plugin.settings.toolToggles[name];
      const defaultOn = name !== "regex.replace";
      new Setting(containerEl).setName(name).addToggle((t) =>
        t.setValue(typeof enabled === "boolean" ? enabled : defaultOn).onChange(async (v) => {
          this.plugin.settings.toolToggles[name] = v;
          await this.plugin.saveSettings();
          await this.plugin.restartServer();
        }),
      );
    }

    // --- Audit log viewer -----------------------------------------------
    containerEl.createEl("h3", { text: "Recent audit log" });
    void this.renderAudit(containerEl);
  }

  private async renderVaults(parent: HTMLElement): Promise<void> {
    const registry = await VaultRegistry.discover({ skipEnv: true, skipConfigFile: true });
    const list = registry.list();
    if (list.length === 0) {
      parent.createEl("p", { text: "No Obsidian vaults detected." });
      return;
    }
    for (const v of list) {
      new Setting(parent)
        .setName(v.name)
        .setDesc(v.root)
        .addToggle((t) =>
          t.setValue(this.plugin.settings.enabledVaults.includes(v.name)).onChange(async (val) => {
            const set = new Set(this.plugin.settings.enabledVaults);
            if (val) set.add(v.name);
            else set.delete(v.name);
            this.plugin.settings.enabledVaults = Array.from(set);
            await this.plugin.saveSettings();
            await this.plugin.restartServer();
          }),
        );
    }
  }

  private async renderAudit(parent: HTMLElement): Promise<void> {
    const registry = await VaultRegistry.discover({ skipEnv: true, skipConfigFile: true });
    const list = registry.list();
    if (list.length === 0) return;
    const audit = new AuditLog(list[0].root);
    const entries = await audit.tail(100);
    const pre = parent.createEl("pre");
    pre.style.maxHeight = "240px";
    pre.style.overflow = "auto";
    pre.style.fontSize = "11px";
    pre.textContent =
      entries.length === 0
        ? "(no audit entries yet)"
        : entries.map((e) => JSON.stringify(e)).join("\n");
    new Setting(parent).addButton((b) =>
      b.setButtonText("Copy log").onClick(async () => {
        await navigator.clipboard.writeText(pre.textContent ?? "");
        new Notice("Audit log copied.");
      }),
    );
  }
}
