/**
 * Permission gating: read-only mode, per-tool enable/disable, per-vault
 * subdirectory allow/deny lists.
 */

import picomatch from "picomatch";
import { ToolFailure } from "../utils/types.js";

export interface VaultPermissions {
  /** Globs of allowed paths within the vault (whitelist). If empty, all allowed. */
  allowPaths?: string[];
  /** Globs of denied paths within the vault. Applied after allow check. */
  denyPaths?: string[];
}

export interface PermissionConfig {
  readOnly: boolean;
  /** Map: toolName → enabled. Missing entries default to `defaultEnabled`. */
  tools: Record<string, boolean>;
  defaultEnabled: boolean;
  /** Per-vault path restrictions. */
  vaults: Record<string, VaultPermissions>;
}

export const DEFAULT_PERMISSIONS: PermissionConfig = {
  readOnly: false,
  tools: {
    // Power tools off by default
    "regex.replace": false,
  },
  defaultEnabled: true,
  vaults: {},
};

export class Permissions {
  private compiled = new Map<string, { allow?: picomatch.Matcher; deny?: picomatch.Matcher }>();

  constructor(private config: PermissionConfig = DEFAULT_PERMISSIONS) {
    this.recompile();
  }

  setConfig(config: PermissionConfig): void {
    this.config = config;
    this.recompile();
  }

  getConfig(): PermissionConfig {
    return this.config;
  }

  isReadOnly(): boolean {
    return this.config.readOnly;
  }

  isToolEnabled(toolName: string): boolean {
    const explicit = this.config.tools[toolName];
    if (typeof explicit === "boolean") return explicit;
    return this.config.defaultEnabled;
  }

  assertTool(toolName: string, requiresWrite: boolean): void {
    if (!this.isToolEnabled(toolName)) {
      throw new ToolFailure("PERMISSION_DENIED", `tool disabled: ${toolName}`, { tool: toolName });
    }
    if (requiresWrite && this.config.readOnly) {
      throw new ToolFailure("PERMISSION_DENIED", `server is in read-only mode`, { tool: toolName });
    }
  }

  assertPath(vault: string, relPath: string): void {
    const compiled = this.compiled.get(vault);
    if (!compiled) return; // no restrictions
    if (compiled.allow && !compiled.allow(relPath)) {
      throw new ToolFailure("PERMISSION_DENIED", `path not in allow list: ${relPath}`);
    }
    if (compiled.deny && compiled.deny(relPath)) {
      throw new ToolFailure("PERMISSION_DENIED", `path in deny list: ${relPath}`);
    }
  }

  private recompile(): void {
    this.compiled.clear();
    for (const [vault, perms] of Object.entries(this.config.vaults)) {
      const entry: { allow?: picomatch.Matcher; deny?: picomatch.Matcher } = {};
      if (perms.allowPaths && perms.allowPaths.length > 0) {
        entry.allow = picomatch(perms.allowPaths);
      }
      if (perms.denyPaths && perms.denyPaths.length > 0) {
        entry.deny = picomatch(perms.denyPaths);
      }
      if (entry.allow || entry.deny) this.compiled.set(vault, entry);
    }
  }
}
