import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/mcp/server";
import { VaultRegistry } from "../src/utils/vaults";
import { removePath } from "../src/utils/fs-utils";

function parseTextResult(response: any): any {
  return JSON.parse(response.result.content[0].text);
}

test("tools/list includes expanded MCP capabilities", async () => {
  const vault = mkdtempSync(join(tmpdir(), "obsidian-native-mcp-server-"));
  const previousVaults = process.env.OBSIDIAN_VAULT_PATHS;
  process.env.OBSIDIAN_VAULT_PATHS = vault;

  try {
    const server = createServer(new VaultRegistry());
    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });

    const toolNames = response?.result?.tools.map((tool: { name: string }) => tool.name) || [];
    for (const name of [
      "move_file",
      "replace_file",
      "replace_section",
      "search_files",
      "read_metadata",
      "get_links",
      "bulk_patch",
    ]) {
      assert.ok(toolNames.includes(name), `missing tool ${name}`);
    }
  } finally {
    if (previousVaults === undefined) delete process.env.OBSIDIAN_VAULT_PATHS;
    else process.env.OBSIDIAN_VAULT_PATHS = previousVaults;
    await removePath(vault);
  }
});

test("tools/call returns structured JSON results for new and upgraded tools", async () => {
  const vault = mkdtempSync(join(tmpdir(), "obsidian-native-mcp-server-"));
  const previousVaults = process.env.OBSIDIAN_VAULT_PATHS;
  process.env.OBSIDIAN_VAULT_PATHS = vault;

  try {
    writeFileSync(join(vault, "Target.md"), "# Target", "utf-8");
    writeFileSync(join(vault, "Source.md"), "See [[Target]]", "utf-8");

    const server = createServer(new VaultRegistry());

    const listFilesResponse = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_files", arguments: { recursive: true } },
    });
    const listed = parseTextResult(listFilesResponse);
    assert.equal(Array.isArray(listed), true);

    const metadataResponse = await server.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "read_metadata", arguments: { filename: "Target.md" } },
    });
    const metadata = parseTextResult(metadataResponse);
    assert.equal(metadata.path, "Target.md");

    const linksResponse = await server.handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_links", arguments: { filename: "Target.md", direction: "both" } },
    });
    const links = parseTextResult(linksResponse);
    assert.equal(links.backlinks.resolved.length, 1);

    const deletePreviewResponse = await server.handleRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "delete_file", arguments: { filename: "Target.md", dry_run: true } },
    });
    const deletePreview = parseTextResult(deletePreviewResponse);
    assert.equal(deletePreview.deleted, false);
    assert.equal(deletePreview.existed, true);
  } finally {
    if (previousVaults === undefined) delete process.env.OBSIDIAN_VAULT_PATHS;
    else process.env.OBSIDIAN_VAULT_PATHS = previousVaults;
    await removePath(vault);
  }
});
