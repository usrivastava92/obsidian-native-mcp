import { Plugin } from "obsidian";
import { HttpTransport } from "../mcp/http-transport";
import { createServer } from "../mcp/server";
import { VaultRegistry } from "../utils/vaults";
import { NativeMcpSettingTab } from "./settings";

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

    if (this.settings.selectedVaults.length > 0) {
      const selected = allVaults.filter((v) => this.settings.selectedVaults.includes(v.name));
      if (selected.length > 0) {
        this.registry.configure(selected);
      }
    }

    if (this.registry.list().length > 0) {
      await this.startServer();
    }

    this.addSettingTab(new NativeMcpSettingTab(this.app, this));
  }

  async startServer(): Promise<void> {
    this.transport?.close();

    const server = createServer(this.registry);
    this.transport = new HttpTransport();
    this.transport.onRequest(async (msg) => server.handleRequest(msg));
    await this.transport.start();
  }

  restartServer(): void {
    this.startServer();
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

    if (selected.length > 0) {
      await this.startServer();
    } else {
      this.transport?.close();
      this.transport = null;
    }
  }

  onunload(): void {
    this.transport?.close();
  }
}
