/**
 * Basic file ops: append, move (3 conflict modes), delete (trash), create-only.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { makeSandbox, readFile } from "../helpers/sandbox.js";

describe("file.append", () => {
  it("creates the file when missing", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/tiny");
    try {
      await sb.call("file.append", { file: "fresh.md", content: "hello" });
      const text = await readFile(sb, "fresh.md");
      assert.ok(text.startsWith("hello"));
      assert.ok(text.endsWith("\n"));
    } finally {
      await sb.cleanup();
    }
  });

  it("appends with ensureTrailingNewline (default true)", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/agents");
    try {
      const before = await readFile(sb, "AGENTS.md");
      await sb.call("file.append", { file: "AGENTS.md", content: "line one\nline two" });
      const after = await readFile(sb, "AGENTS.md");
      assert.ok(after.startsWith(before.endsWith("\n") ? before : before + "\n"));
      assert.ok(after.endsWith("line one\nline two\n"));
    } finally {
      await sb.cleanup();
    }
  });
});

describe("file.delete + trash", () => {
  it("moves into <vault>/.obsidian/trash by default and preserves the path", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/dup-headings");
    try {
      const r = await sb.call<{ trashed: boolean; trashedTo?: string }>("file.delete", {
        file: "dup-headings.md",
      });
      assert.equal(r.trashed, true);
      assert.ok(r.trashedTo!.startsWith(".obsidian/trash/"));
      const stillThere = await fs
        .stat(path.join(sb.vaultRoot, "dup-headings.md"))
        .catch(() => null);
      assert.equal(stillThere, null);
      const inTrash = await fs.stat(path.join(sb.vaultRoot, r.trashedTo!));
      assert.ok(inTrash.isFile());
    } finally {
      await sb.cleanup();
    }
  });

  it("hard delete requires expected_content_hash", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/agents");
    try {
      const err = await sb.expectFail("file.delete", { file: "AGENTS.md", trash: false });
      assert.equal(err.code, "INVALID_ARGS");
    } finally {
      await sb.cleanup();
    }
  });

  it("trash collision uniquifies the destination", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/agents");
    try {
      await sb.call("file.delete", { file: "AGENTS.md" });
      await sb.call("file.create", { file: "AGENTS.md", content: "# AGENTS v2\n" });
      const r = await sb.call<{ trashedTo: string }>("file.delete", { file: "AGENTS.md" });
      assert.match(r.trashedTo, /AGENTS \(1\)\.md$/);
    } finally {
      await sb.cleanup();
    }
  });
});
