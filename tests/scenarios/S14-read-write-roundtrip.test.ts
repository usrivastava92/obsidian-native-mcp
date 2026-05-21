/**
 * S14: read → surgical edit → read returns new hash chain.
 *
 * Validates the LLM round-trip: every write returns the new content_hash so
 * the next write can chain without re-reading.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeSandbox } from "../helpers/sandbox.js";

describe("S14 hash_chain", () => {
  it("read → str_replace returns matching new content_hash; subsequent read confirms", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/agents");
    try {
      const file = "AGENTS.md";
      const r1 = await sb.call<{ contentHash: string }>("file.read", { file });
      const edit = await sb.call<{ contentHash: string }>("str_replace", {
        file,
        find: "Be concise. Be honest.",
        replace: "Be concise. Be honest. Be kind.",
      });
      assert.notEqual(edit.contentHash, r1.contentHash);
      const r2 = await sb.call<{ contentHash: string }>("file.read", { file });
      assert.equal(
        r2.contentHash,
        edit.contentHash,
        "edit's returned hash must equal next read's hash",
      );
    } finally {
      await sb.cleanup();
    }
  });

  it("range read → lines.replace with returned range_hash succeeds in one round-trip", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/agents");
    try {
      const file = "AGENTS.md";
      const range = await sb.call<{ from: number; to: number; rangeHash: string; lines: string }>(
        "file.read_range",
        { file, from: 3, to: 5 },
      );
      const r = await sb.call<{ changed: boolean }>("lines.replace", {
        file,
        from: range.from,
        to: range.to,
        content: "REPLACED LINE\n",
        expected_range_hash: range.rangeHash,
      });
      assert.equal(r.changed, true);
    } finally {
      await sb.cleanup();
    }
  });

  it("outline → heading.replace_body using returned section_hash in one round-trip", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/agents");
    try {
      const file = "AGENTS.md";
      const o = await sb.call<{ headings: Array<{ path: string; sectionHash: string }> }>(
        "outline",
        { file },
      );
      const style = o.headings.find((h) => h.path === "Agent Rules::Style");
      assert.ok(style);
      const r = await sb.call<{ changed: boolean; contentHash: string }>("heading.replace_body", {
        file,
        heading: "Agent Rules::Style",
        content: "Updated style guidance.\n",
        expected_section_hash: style!.sectionHash,
      });
      assert.equal(r.changed, true);
    } finally {
      await sb.cleanup();
    }
  });
});
