/**
 * VaultRegistry — the source of truth for which vaults exist and where.
 *
 * Resolution order (first wins):
 *   1. Programmatic vaults supplied to the constructor (used by the plugin)
 *   2. Config file at `~/.config/obsidian-native-mcp/vaults.json`
 *   3. `OBSIDIAN_VAULT_PATHS` env var (semicolon-separated)
 *   4. Obsidian's own per-OS vault list (auto-discovery)
 *
 * When only one vault is registered, all tools that accept `vault?` infer it.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { Vault } from "../utils/types.js";

export interface VaultEntry {
  name: Vault;
  root: string; // absolute path
}

export interface RegistryOptions {
  /** Programmatically supplied vaults (highest precedence). */
  initial?: VaultEntry[];
  /** Skip the env var lookup (for tests). */
  skipEnv?: boolean;
  /** Skip the config-file lookup (for tests). */
  skipConfigFile?: boolean;
  /** Skip Obsidian auto-discovery (for tests). */
  skipObsidian?: boolean;
}

export class VaultRegistry {
  private byName = new Map<string, VaultEntry>();

  constructor(entries: VaultEntry[] = []) {
    for (const e of entries) this.byName.set(e.name, { ...e });
  }

  static async discover(opts: RegistryOptions = {}): Promise<VaultRegistry> {
    const byName = new Map<string, VaultEntry>();
    const byRoot = new Map<string, VaultEntry>();

    const normalize = (p: string): string => {
      // Normalize for de-dup: absolute, no trailing slash, case-preserved
      // (macOS/Windows are case-insensitive at the filesystem level but we
      // keep case for display; key is lowercased on those platforms).
      const abs = path.resolve(p);
      const trimmed = abs.endsWith(path.sep) && abs.length > 1 ? abs.slice(0, -1) : abs;
      return process.platform === "win32" || process.platform === "darwin"
        ? trimmed.toLowerCase()
        : trimmed;
    };

    const add = (name: string, root: string) => {
      const key = normalize(root);
      if (byRoot.has(key)) return; // first-registered name wins for this path
      if (byName.has(name)) return; // name collision — keep the earlier one
      const entry = { name, root: path.resolve(root) };
      byName.set(name, entry);
      byRoot.set(key, entry);
    };

    for (const e of opts.initial ?? []) add(e.name, e.root);
    if (!opts.skipConfigFile) {
      for (const e of await readConfigFile()) add(e.name, e.root);
    }
    if (!opts.skipEnv) {
      for (const e of readEnvVar()) add(e.name, e.root);
    }
    if (!opts.skipObsidian) {
      for (const e of await readObsidianDiscovery()) add(e.name, e.root);
    }

    return new VaultRegistry(Array.from(byName.values()));
  }

  list(): VaultEntry[] {
    return Array.from(this.byName.values());
  }

  count(): number {
    return this.byName.size;
  }

  get(name: string): VaultEntry | undefined {
    return this.byName.get(name);
  }

  /**
   * Resolve a vault by explicit name OR by inference (only when exactly one
   * vault is registered).
   */
  resolve(name?: string): VaultEntry {
    if (name !== undefined) {
      const e = this.byName.get(name);
      if (!e) throw new Error(`unknown vault: ${name}`);
      return e;
    }
    if (this.byName.size === 0) throw new Error("no vaults configured");
    if (this.byName.size === 1) return this.list()[0];
    throw new Error(
      `multiple vaults configured (${this.list()
        .map((v) => v.name)
        .join(", ")}); specify "vault" explicitly`,
    );
  }
}

// ---------------------------------------------------------------------------

async function readConfigFile(): Promise<VaultEntry[]> {
  const cfgPath = path.join(os.homedir(), ".config", "obsidian-native-mcp", "vaults.json");
  let raw: string;
  try {
    raw = await fs.readFile(cfgPath, "utf-8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { vaults?: Record<string, string> };
    if (!parsed.vaults || typeof parsed.vaults !== "object") return [];
    return Object.entries(parsed.vaults).map(([name, root]) => ({
      name,
      root: path.resolve(root),
    }));
  } catch {
    return [];
  }
}

function readEnvVar(): VaultEntry[] {
  const v = process.env.OBSIDIAN_VAULT_PATHS;
  if (!v) return [];
  const parts = v
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.map((p) => ({
    name: path.basename(path.resolve(p)),
    root: path.resolve(p),
  }));
}

async function readObsidianDiscovery(): Promise<VaultEntry[]> {
  const cfgPath = obsidianConfigPath();
  if (!cfgPath) return [];
  let raw: string;
  try {
    raw = await fs.readFile(cfgPath, "utf-8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as {
      vaults?: Record<string, { path: string; ts?: number; open?: boolean }>;
    };
    if (!parsed.vaults) return [];
    return Object.values(parsed.vaults)
      .filter((v) => typeof v.path === "string")
      .map((v) => ({
        name: path.basename(v.path),
        root: path.resolve(v.path),
      }));
  } catch {
    return [];
  }
}

function obsidianConfigPath(): string | null {
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "obsidian", "obsidian.json");
    case "win32":
      return path.join(
        process.env.APPDATA ?? path.join(home, "AppData", "Roaming"),
        "obsidian",
        "obsidian.json",
      );
    case "linux":
      return path.join(
        process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"),
        "obsidian",
        "obsidian.json",
      );
    default:
      return null;
  }
}
