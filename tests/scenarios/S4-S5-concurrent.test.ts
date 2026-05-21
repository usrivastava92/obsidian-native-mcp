/**
 * S4 + S5: hash-precondition concurrency model.
 *
 * S4: read → external edit → write with stale hash → STALE_PRECONDITION.
 *     Re-read returns the external change; retry succeeds.
 *
 * S5: read section A → external edit to section B → write to A with the
 *     ORIGINAL section_hash → succeeds (section hashes isolate concerns).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { makeSandbox } from "../helpers/sandbox.js";

describe("S4 concurrent_human_edit", () => {
  it("write with stale expected_content_hash returns STALE_PRECONDITION + current hash", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/agents");
    try {
      const file = "AGENTS.md";
      const read1 = await sb.call<{ contentHash: string; content: string }>("file.read", { file });

      // External edit OOB
      const abs = path.join(sb.vaultRoot, file);
      await fs.writeFile(abs, read1.content + "\nAppended out-of-band.\n", "utf-8");

      const err = await sb.expectFail("file.replace", {
        file,
        content: "OOPS this would clobber",
        expected_content_hash: read1.contentHash,
      });
      assert.equal(err.code, "STALE_PRECONDITION");
      // The error carries actual + expected hashes so the LLM can recover.
      assert.ok(typeof err.details?.actual === "string");
      assert.notEqual(err.details?.actual, read1.contentHash);

      // Retry path: re-read, then write succeeds.
      const read2 = await sb.call<{ contentHash: string }>("file.read", { file });
      const result = await sb.call<{ contentHash: string }>("file.replace", {
        file,
        content: "Brand new content.\n",
        expected_content_hash: read2.contentHash,
      });
      assert.notEqual(result.contentHash, read2.contentHash);
    } finally {
      await sb.cleanup();
    }
  });
});

describe("S5 concurrent_unrelated_edit", () => {
  it("section_hash precondition is unaffected by changes to a different section", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/agents");
    try {
      const file = "AGENTS.md";
      // Find the "Style" section's hash.
      const styleFound = await sb.call<{ matches: Array<{ sectionHash: string }> }>(
        "heading.find",
        { file, heading: "Style" },
      );
      assert.equal(styleFound.matches.length, 1);
      const styleSectionHash = styleFound.matches[0].sectionHash;

      // External edit to a DIFFERENT section ("Forbidden") via str_replace.
      await sb.call("str_replace", {
        file,
        find: "- Inventing data.",
        replace: "- Inventing data is unacceptable.",
      });

      // Replacing the "Style" body using the original section_hash should
      // still succeed — section_hash is computed over the section's bytes
      // which are unchanged.
      const r = await sb.call<{ changed: boolean }>("heading.replace_body", {
        file,
        heading: "Style",
        content: "Be concise. Be honest. Be kind.\n",
        expected_section_hash: styleSectionHash,
      });
      assert.equal(r.changed, true);
    } finally {
      await sb.cleanup();
    }
  });
});
