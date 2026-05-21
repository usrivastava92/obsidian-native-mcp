/**
 * Obsidian plugin entry — boots the HTTP/SSE MCP server, exposes settings UI.
 */

import { Plugin, Notice } from "obsidian";
import { VaultRegistry } from "../vault/registry.js";
import { Permissions, DEFAULT_PERMISSIONS, type PermissionConfig } from "../vault/permissions.js";
import { LRUFileCache } from "../cache/file-cache.js";
import { AuditLog } from "../audit/log.js";
import { ToolRegistry } from "../handlers/registry.js";
import { registerAll } from "../tools/index.js";
import { createServer } from "../mcp/server.js";
import { HttpTransport } from "../mcp/http.js";
import { FsPromptsProvider } from "../prompts/provider.js";
import { SettingsTab } from "./settings.js";

export interface PluginSettings {
  port: number;
  bearerToken: string | null; // null → auto-generate at boot
  readOnly: boolean;
  toolToggles: Record<string, boolean>;
  allowedOrigins: string[] | null; // null → defaults
  enabledVaults: string[]; // vault names to expose
}

const DEFAULT_SETTINGS: PluginSettings = {
  port: 9789,
  bearerToken: null,
  readOnly: false,
  toolToggles: {},
  allowedOrigins: null,
  enabledVaults: [],
};

export default class ObsidianNativeMcpPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;
  private transport: HttpTransport | null = null;
  private serverUrl: string | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new SettingsTab(this.app, this));
    await this.startServer();
  }

  async onunload(): Promise<void> {
    await this.stopServer();
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<PluginSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(data ?? {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  getServerUrl(): string | null {
    return this.serverUrl;
  }

  async restartServer(): Promise<void> {
    await this.stopServer();
    await this.startServer();
  }

  async rotateToken(): Promise<void> {
    this.settings.bearerToken = null; // force regeneration
    await this.saveSettings();
    await this.restartServer();
    new Notice("MCP token rotated.");
  }

  private async startServer(): Promise<void> {
    // Discover vaults from Obsidian + filter by enabled list.
    const registry = await VaultRegistry.discover({ skipEnv: true, skipConfigFile: true });
    const enabled = new Set(this.settings.enabledVaults);
    const filtered =
      enabled.size === 0 ? registry.list() : registry.list().filter((v) => enabled.has(v.name));
    if (filtered.length === 0) {
      new Notice("Obsidian Native MCP: no vaults enabled.");
      return;
    }
    const effectiveRegistry = new VaultRegistry(filtered);
    const permConfig: PermissionConfig = {
      ...DEFAULT_PERMISSIONS,
      readOnly: this.settings.readOnly,
      tools: { ...DEFAULT_PERMISSIONS.tools, ...this.settings.toolToggles },
    };
    const perms = new Permissions(permConfig);
    const cache = new LRUFileCache();
    const audit = new AuditLog(filtered[0].root);
    const toolReg = new ToolRegistry();
    registerAll(toolReg);
    const prompts = new FsPromptsProvider(effectiveRegistry);
    const handle = createServer({
      version: this.manifest.version,
      registry: effectiveRegistry,
      perms,
      cache,
      audit,
      tools: toolReg,
      promptsProvider: prompts,
    });
    this.transport = new HttpTransport({
      port: this.settings.port,
      bearerToken: this.settings.bearerToken ?? undefined,
      allowedOrigins: this.settings.allowedOrigins ?? undefined,
      version: this.manifest.version,
      vaultCount: filtered.length,
      readOnly: this.settings.readOnly,
    });
    await this.transport.start((req, ctx) => handle.handleRequest(req, ctx.clientId));
    const addr = this.transport.getAddress();
    const token = this.transport.getBearerToken();
    if (this.settings.bearerToken !== token) {
      this.settings.bearerToken = token;
      await this.saveSettings();
    }
    if (addr) {
      this.serverUrl = `http://${addr.host}:${addr.port}/sse?token=${encodeURIComponent(token)}`;
    }
  }

  private async stopServer(): Promise<void> {
    if (this.transport) {
      await this.transport.stop();
      this.transport = null;
      this.serverUrl = null;
    }
  }
}
