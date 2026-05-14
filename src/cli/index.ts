#!/usr/bin/env node
import { createServer } from "../mcp/server";
import { StdioTransport } from "../mcp/stdio-transport";
import { createLogger, formatError } from "../utils/log";
import { VaultRegistry } from "../utils/vaults";

const log = createLogger("cli");

async function main() {
  const registry = new VaultRegistry();

  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    console.log("0.2.0");
    process.exit(0);
  }

  const vaults = registry.list();
  const validation = registry.validate();

  log.info("starting obsidian-native-mcp", {
    transport: "stdio",
    vaultCount: vaults.length,
    source: registry.getSource(),
  });

  if (vaults.length === 0) {
    log.warn("no vaults configured", {
      hint: "Set OBSIDIAN_VAULT_PATHS or ~/.config/obsidian-native-mcp/vaults.json",
    });
  }

  for (const vault of validation.missing) {
    log.warn("configured vault path does not exist", { vault: vault.name, path: vault.path });
  }

  const server = createServer(registry);
  const transport = new StdioTransport();

  transport.onRequest(async (msg) => server.handleRequest(msg));
  transport.start();

  log.info("stdio transport ready", { protocol: "jsonl" });
}

main().catch((err) => {
  log.error("startup failed", { error: formatError(err) });
  process.exit(1);
});
