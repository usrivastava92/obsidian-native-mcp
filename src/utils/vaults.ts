import { homedir, platform } from "os";
import { resolve, basename, join } from "path";
import { readFileSync, existsSync, readdirSync, statSync } from "fs";

const IS_WIN = platform() === "win32";

export interface VaultConfig {
  name: string;
  path: string;
}

export class VaultRegistry {
  private vaults: Map<string, string> = new Map();

  constructor() {
    const fromEnv = this.parseEnv();
    const fromConfig = this.parseConfigFile();

    if (fromEnv.length > 0) {
      for (const v of fromEnv) this.vaults.set(v.name, v.path);
    } else if (fromConfig.length > 0) {
      for (const v of fromConfig) this.vaults.set(v.name, v.path);
    } else {
      const hint = IS_WIN
        ? "Set OBSIDIAN_VAULT_PATHS or create %APPDATA%\\obsidian-native-mcp\\vaults.json"
        : "Set OBSIDIAN_VAULT_PATHS or create ~/.config/obsidian-native-mcp/vaults.json";
      console.error(`No vaults configured. ${hint}`);
      process.exit(1);
    }

    console.error(
      `Configured vaults: ${this.list()
        .map((v) => `${v.name} -> ${v.path}`)
        .join(", ")}`,
    );
  }

  private parseEnv(): VaultConfig[] {
    const envVal = process.env.OBSIDIAN_VAULT_PATHS;
    if (!envVal) return [];

    const separator = /[;\n]/;
    const parts = envVal
      .split(separator)
      .map((s) => s.trim())
      .filter(Boolean);

    return parts.map((p) => {
      const resolved = resolve(p.replace(/^~/, homedir()));
      return { name: basename(resolved), path: resolved };
    });
  }

  private configDir(): string {
    if (IS_WIN) {
      return resolve(
        process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
        "obsidian-native-mcp",
      );
    }
    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg) return resolve(xdg, "obsidian-native-mcp");
    return resolve(homedir(), ".config", "obsidian-native-mcp");
  }

  private parseConfigFile(): VaultConfig[] {
    const configPath = join(this.configDir(), "vaults.json");

    if (!existsSync(configPath)) return [];

    try {
      const raw = readFileSync(configPath, "utf-8");
      const config = JSON.parse(raw);
      const resolved: VaultConfig[] = [];

      const entries = config.vaults
        ? (Object.entries(config.vaults) as [string, unknown][])
        : (Object.entries(config).filter(([k]) => k !== "default") as [string, unknown][]);

      for (const [name, path] of entries) {
        if (typeof path === "string") {
          resolved.push({ name, path: resolve(path.replace(/^~/, homedir())) });
        }
      }

      return resolved;
    } catch {
      return [];
    }
  }

  resolve(name?: string): string {
    if (name) {
      const path = this.vaults.get(name);
      if (!path) {
        const available = this.list()
          .map((v) => v.name)
          .join(", ");
        throw new Error(`Unknown vault "${name}". Available vaults: ${available}`);
      }
      return path;
    }

    if (this.vaults.size === 1) {
      return this.vaults.values().next().value!;
    }

    const available = this.list()
      .map((v) => v.name)
      .join(", ");
    throw new Error(`Multiple vaults configured but no vault specified. Choose one: ${available}`);
  }

  list(): VaultConfig[] {
    return Array.from(this.vaults.entries()).map(([name, path]) => ({
      name,
      path,
    }));
  }

  info(name?: string): { name: string; path: string; fileCount: number } {
    const vaultPath = this.resolve(name);
    let fileCount = 0;
    try {
      const walkDir = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          try {
            const stat = statSync(full);
            if (stat.isDirectory()) {
              if (!entry.startsWith(".")) walkDir(full);
            } else if (entry.endsWith(".md")) {
              fileCount++;
            }
          } catch {
            // skip unreadable entries
          }
        }
      };
      walkDir(vaultPath);
    } catch {
      // skip unreadable directories
    }
    return { name: basename(vaultPath), path: vaultPath, fileCount };
  }
}
