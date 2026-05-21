#!/usr/bin/env node
/**
 * CLI entry point: stdio MCP server using the official @modelcontextprotocol/sdk.
 *
 * Usage:
 *   obsidian-native-mcp [--read-only] [--vault name=path]... [--config path]
 *
 * Vault resolution order: --vault flags → $OBSIDIAN_VAULT_PATHS env
 * → ~/.config/obsidian-native-mcp/vaults.json
 * (Obsidian auto-discovery is skipped in CLI mode — configure vaults explicitly)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { VaultRegistry } from "../vault/registry.js";
import { Permissions, DEFAULT_PERMISSIONS } from "../vault/permissions.js";
import { LRUFileCache } from "../cache/file-cache.js";
import { AuditLog } from "../audit/log.js";
import { ToolRegistry } from "../handlers/registry.js";
import { registerAll } from "../tools/index.js";
import { FsPromptsProvider } from "../prompts/provider.js";

interface CliFlags {
  readOnly: boolean;
  configPath?: string;
  initialVaults: Array<{ name: string; root: string }>;
}

function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = { readOnly: false, initialVaults: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--read-only") flags.readOnly = true;
    else if (a === "--config") flags.configPath = argv[++i];
    else if (a === "--vault") {
      const v = argv[++i];
      const eq = v?.indexOf("=") ?? -1;
      if (eq === -1) {
        process.stderr.write(`--vault expects name=path, got: ${v}\n`);
        process.exit(2);
      }
      flags.initialVaults.push({ name: v.slice(0, eq), root: path.resolve(v.slice(eq + 1)) });
    } else if (a === "--version" || a === "-V") {
      process.stdout.write(readPkgVersion() + "\n");
      process.exit(0);
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "obsidian-native-mcp [--read-only] [--vault name=path]... [--config path]\n",
      );
      process.exit(0);
    }
  }
  return flags;
}

function readPkgVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(here, "..", "..", "package.json");
    const raw = readFileSync(pkgPath, "utf-8");
    const json = JSON.parse(raw) as { version?: string };
    return json.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const version = readPkgVersion();

  // CLI mode: skip Obsidian auto-discovery — user configures vaults via env/flags.
  const registry = await VaultRegistry.discover({
    initial: flags.initialVaults,
    skipObsidian: true,
  });
  if (registry.count() === 0) {
    process.stderr.write("error: no vaults configured\n");
    process.stderr.write("  set OBSIDIAN_VAULT_PATHS=/path/to/vault\n");
    process.stderr.write("  or pass --vault name=/path/to/vault\n");
    process.exit(2);
  }

  const perms = new Permissions({ ...DEFAULT_PERMISSIONS, readOnly: flags.readOnly });
  const cache = new LRUFileCache();
  const audit = new AuditLog(registry.list()[0].root);
  const toolReg = new ToolRegistry();
  registerAll(toolReg);
  const promptsProvider = new FsPromptsProvider(registry);

  // ------------------------------------------------------------------
  // Wire everything into the official MCP SDK Server
  // ------------------------------------------------------------------
  const server = new Server(
    { name: "obsidian-native-mcp", version },
    { capabilities: { tools: {}, prompts: {} } },
  );

  // tools/list
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = toolReg
      .list((name) => perms.isToolEnabled(name))
      .map((t) => ({
        name: t.name,
        description: t.summary,
        inputSchema: t.schema,
      }));
    return { tools };
  });

  // tools/call
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const vaultName = typeof args.vault === "string" ? args.vault : undefined;
    let vault;
    try {
      vault = registry.resolve(vaultName);
    } catch (e) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: (e as Error).message }],
      };
    }
    const ctx = { vault, perms, cache, audit, registry, clientId: "stdio" };
    const result = await toolReg.invoke(name, args, ctx);
    if (!result.ok) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify(result.error) }],
      };
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result.result) }],
    };
  });

  // prompts/list
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    const prompts = await promptsProvider.list();
    return { prompts };
  });

  // prompts/get
  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const out = await promptsProvider.get(
      req.params.name,
      req.params.arguments as Record<string, string> | undefined,
    );
    return out;
  });

  // ------------------------------------------------------------------
  // Start with the official stdio transport
  // ------------------------------------------------------------------
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${(e as Error).message}\n`);
  process.exit(1);
});
