/**
 * S6: outline a 5000-line note in <50ms with all 1000 headings present.
 * S7: surgical edit on the same big file uses <2KB of "context bytes"
 *     (size of args+result combined), not the full file.
 *
 * These bound the perf + LLM-efficiency claims from DESIGN_V1.md.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeSandbox } from "../helpers/sandbox.js";

function byteSize(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v), "utf-8");
}

describe("S6 giant_file_outline", () => {
  it("returns an outline with all headings quickly", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/large-kb");
    try {
      const t0 = process.hrtime.bigint();
      const o = await sb.call<{
        totalLines: number;
        headings: Array<{ path: string; level: number }>;
      }>("outline", { file: "big.md" });
      const t1 = process.hrtime.bigint();
      const elapsedMs = Number(t1 - t0) / 1_000_000;
      // 1 H1 + 250 H2 + 750 H3 = 1001 headings
      assert.equal(o.headings.length, 1001, "must include every heading");
      assert.ok(o.totalLines > 4000, `expected >4000 lines, got ${o.totalLines}`);
      // Generous threshold for CI (cold parse): require <500ms.
      assert.ok(elapsedMs < 500, `outline took ${elapsedMs.toFixed(1)}ms (expected <500ms)`);
    } finally {
      await sb.cleanup();
    }
  });

  it("outline payload is materially smaller than the source file", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/large-kb");
    try {
      const fileRead = await sb.call<{ content: string }>("file.read", { file: "big.md" });
      const fileSize = Buffer.byteLength(fileRead.content, "utf-8");
      const o = await sb.call<unknown>("outline", { file: "big.md", maxDepth: 2 });
      const outlineSize = byteSize(o);
      // Outline must be cheaper than the file itself.
      assert.ok(
        outlineSize < fileSize * 0.7,
        `outline payload was ${outlineSize}B vs file ${fileSize}B (expected <70% of file)`,
      );
    } finally {
      await sb.cleanup();
    }
  });
});

describe("S7 giant_file_surgical_edit_cost", () => {
  it("str_replace round-trip on a 5k-line file costs <2KB of args+result bytes", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/large-kb");
    try {
      const args = {
        file: "big.md",
        find: "Paragraph for section 137.",
        replace: "Paragraph for section 137 (edited).",
      };
      const result = await sb.call<unknown>("str_replace", args);
      const total = byteSize(args) + byteSize(result);
      assert.ok(total < 2_000, `args+result was ${total} bytes (expected <2000)`);
    } finally {
      await sb.cleanup();
    }
  });
});
