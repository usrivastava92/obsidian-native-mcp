#!/usr/bin/env node
import { createServer } from "../mcp/server";
import { StdioTransport } from "../mcp/stdio-transport";
import { VaultRegistry } from "../utils/vaults";

async function main() {
  const registry = new VaultRegistry();

  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    console.log("0.2.0");
    process.exit(0);
  }

  console.error("obsidian-native-mcp server starting");

  const server = createServer(registry);
  const transport = new StdioTransport();

  transport.onRequest(async (msg) => server.handleRequest(msg));
  transport.start();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
