/**
 * Audit log: every mutating call lands a JSONL line; reads do not.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { makeSandbox } from "../helpers/sandbox.js";

async function readAudit(root: string): Promise<Array<Record<string, unknown>>> {
  const p = path.join(root, ".obsidian/plugins/native-mcp/audit.log");
  try {
    const text = await fs.readFile(p, "utf-8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

describe("audit log", () => {
  it("writes one entry per mutating call; none for reads", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/agents");
    try {
      await sb.call("file.read", { file: "AGENTS.md" });
      await sb.call("outline", { file: "AGENTS.md" });
      const before = await readAudit(sb.vaultRoot);
      assert.equal(before.length, 0, "no audit on read-only ops");

      await sb.call("str_replace", {
        file: "AGENTS.md",
        find: "Be concise. Be honest.",
        replace: "Be concise. Be honest. Be kind.",
      });
      const after = await readAudit(sb.vaultRoot);
      assert.equal(after.length, 1);
      const entry = after[0];
      assert.equal(entry.tool, "str_replace");
      assert.equal(entry.dry_run, false);
      assert.match(entry.before_hash as string, /^sha256:/);
      assert.match(entry.after_hash as string, /^sha256:/);
      assert.notEqual(entry.before_hash, entry.after_hash);
    } finally {
      await sb.cleanup();
    }
  });

  it("dry_run still logs (with dry_run: true) for visibility", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/agents");
    try {
      await sb.call("str_replace", {
        file: "AGENTS.md",
        find: "Be concise. Be honest.",
        replace: "x",
        dry_run: true,
      });
      const entries = await readAudit(sb.vaultRoot);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].dry_run, true);
    } finally {
      await sb.cleanup();
    }
  });
});
