#!/usr/bin/env bun
import { startMcpServer } from "./mcp/server";
import { VaultRegistry } from "./utils/vaults";

async function main() {
  const registry = new VaultRegistry();

  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    console.log("0.2.0");
    process.exit(0);
  }

  console.error("obsidian-native-mcp server starting");
  await startMcpServer(registry);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
