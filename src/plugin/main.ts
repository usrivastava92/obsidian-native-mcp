import { Plugin } from "obsidian";
import { HttpTransport } from "../mcp/http-transport";
import { createServer } from "../mcp/server";
import { createLogger, formatError } from "../utils/log";
import { VaultRegistry } from "../utils/vaults";
import { NativeMcpSettingTab } from "./settings";

const log = createLogger("plugin");

interface PluginSettings {
  selectedVaults: string[];
}

const DEFAULT_SETTINGS: PluginSettings = {
  selectedVaults: [],
};

export default class NativeMcpPlugin extends Plugin {
  private transport: HttpTransport | null = null;
  private settings: PluginSettings = DEFAULT_SETTINGS;
  private registry = new VaultRegistry();

  async onload(): Promise<void> {
    await this.loadSettings();

    const allVaults = VaultRegistry.discoverFromObsidian();
    log.info("plugin loading", {
      discoveredVaultCount: allVaults.length,
      selectedVaultCount: this.settings.selectedVaults.length,
    });

    if (this.settings.selectedVaults.length > 0) {
      const selected = allVaults.filter((v) => this.settings.selectedVaults.includes(v.name));
      if (selected.length > 0) {
        this.registry.configure(selected);
      }
    }

    if (this.registry.list().length > 0) {
      await this.startServer();
    } else {
      log.warn("plugin started without active vaults", {
        hint: "Select at least one vault in plugin settings",
      });
    }

    this.addSettingTab(new NativeMcpSettingTab(this.app, this));
  }

  async startServer(): Promise<void> {
    this.transport?.close();

    const vaults = this.registry.list();
    log.info("starting plugin transport", { vaultCount: vaults.length });

    const server = createServer(this.registry);
    this.transport = new HttpTransport();
    this.transport.onRequest(async (msg) => server.handleRequest(msg));
    try {
      await this.transport.start();
    } catch (err) {
      log.error("failed to start plugin transport", { error: formatError(err) });
      throw err;
    }
  }

  restartServer(): void {
    void this.startServer().catch((err) => {
      log.error("failed to restart plugin transport", { error: formatError(err) });
    });
  }

  getServerUrl(): string | null {
    return this.transport?.url ?? null;
  }

  getRegistry(): VaultRegistry {
    return this.registry;
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  getSettings(): PluginSettings {
    return this.settings;
  }

  async updateSelectedVaults(names: string[]): Promise<void> {
    this.settings.selectedVaults = names;
    await this.saveSettings();

    const allVaults = VaultRegistry.discoverFromObsidian();
    const selected = allVaults.filter((v) => names.includes(v.name));
    this.registry.configure(selected);
    log.info("updated selected vaults", { selectedVaultCount: selected.length });

    if (selected.length > 0) {
      await this.startServer();
    } else {
      this.transport?.close();
      this.transport = null;
      log.warn("stopped plugin transport because no vaults are selected");
    }
  }

  onunload(): void {
    this.transport?.close();
    log.info("plugin unloaded");
  }
}
