/**
 * Block-ref tools: find, replace (preserving list-item prefix), rename.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeSandbox, readFile } from "../helpers/sandbox.js";

describe("block.find / block.replace / block.rename", () => {
  it("finds block refs on paragraphs and list items in code-heavy fixture", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/code-heavy");
    try {
      const para = await sb.call<{ matches: Array<{ id: string; structuralType: string }> }>(
        "block.find",
        { file: "code-heavy.md", blockId: "ref-one" },
      );
      assert.equal(para.matches.length, 1);
      assert.equal(para.matches[0].structuralType, "paragraph");

      const li = await sb.call<{ matches: Array<{ id: string; structuralType: string }> }>(
        "block.find",
        { file: "code-heavy.md", blockId: "ref-two" },
      );
      assert.equal(li.matches.length, 1);
      assert.equal(li.matches[0].structuralType, "list-item");
    } finally {
      await sb.cleanup();
    }
  });

  it("block.replace on a list item preserves the leading '- ' marker", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/code-heavy");
    try {
      const found = await sb.call<{ matches: Array<{ blockHash: string }> }>("block.find", {
        file: "code-heavy.md",
        blockId: "ref-two",
      });
      const r = await sb.call<{ changed: boolean }>("block.replace", {
        file: "code-heavy.md",
        blockId: "ref-two",
        content: "- A *replaced* list item with its own block ref.",
        expected_block_hash: found.matches[0].blockHash,
      });
      assert.equal(r.changed, true);
      const txt = await readFile(sb, "code-heavy.md");
      assert.ok(txt.includes("- A *replaced* list item with its own block ref. ^ref-two"));
    } finally {
      await sb.cleanup();
    }
  });

  it("block.rename only touches the marker line", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/code-heavy");
    try {
      const found = await sb.call<{ matches: Array<{ blockHash: string }> }>("block.find", {
        file: "code-heavy.md",
        blockId: "ref-one",
      });
      await sb.call("block.rename", {
        file: "code-heavy.md",
        blockId: "ref-one",
        newId: "renamed",
        expected_block_hash: found.matches[0].blockHash,
      });
      const txt = await readFile(sb, "code-heavy.md");
      assert.ok(txt.includes(" ^renamed"));
      assert.ok(!txt.includes(" ^ref-one"));
    } finally {
      await sb.cleanup();
    }
  });
});
