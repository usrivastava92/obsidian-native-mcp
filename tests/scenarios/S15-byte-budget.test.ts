/**
 * S15: byte-budget benchmark.
 *
 * Replays a typical 10-edit session two ways:
 *   A) v0-style: file.read full → file.replace full   (heavy)
 *   B) v1-style: str_replace                          (surgical)
 *
 * Asserts B uses <= 20% of A's bytes. This is the marketing benchmark.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeSandbox } from "../helpers/sandbox.js";

function byteSize(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v), "utf-8");
}

describe("S15 context_byte_budget_v0_vs_v1", () => {
  it("surgical edits use <=20% of full-file rewrite bytes", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/large-kb");
    try {
      const file = "big.md";
      const targets = [13, 47, 88, 121, 173, 199, 217, 232, 244, 249];

      // (A) v0-style — full file read + full file replace per edit.
      let v0Bytes = 0;
      for (const n of targets) {
        const readArgs = { file };
        const readResult = await sb.call<{ content: string; contentHash: string }>(
          "file.read",
          readArgs,
        );
        const newContent = readResult.content.replace(
          `Paragraph for section ${n}.`,
          `Paragraph for section ${n} (edited).`,
        );
        const replaceArgs = {
          file,
          content: newContent,
          expected_content_hash: readResult.contentHash,
        };
        const replaceResult = await sb.call<unknown>("file.replace", replaceArgs);
        v0Bytes +=
          byteSize(readArgs) +
          byteSize(readResult) +
          byteSize(replaceArgs) +
          byteSize(replaceResult);
      }

      // Fresh sandbox so the v1 measurement is independent
      const sb2 = await makeSandbox("tests/fixtures/vaults/large-kb");
      try {
        let v1Bytes = 0;
        for (const n of targets) {
          const args = {
            file,
            find: `Paragraph for section ${n}.`,
            replace: `Paragraph for section ${n} (edited).`,
          };
          const result = await sb2.call<unknown>("str_replace", args);
          v1Bytes += byteSize(args) + byteSize(result);
        }
        const ratio = v1Bytes / v0Bytes;
        // Strong claim: at least 5× cheaper.
        assert.ok(
          ratio < 0.2,
          `expected v1 to use <=20% of v0 bytes, but ratio was ${(ratio * 100).toFixed(2)}% ` +
            `(v0=${v0Bytes}B, v1=${v1Bytes}B)`,
        );
      } finally {
        await sb2.cleanup();
      }
    } finally {
      await sb.cleanup();
    }
  });
});
