/**
 * S8: bulk.apply atomic rollback.
 *
 * Three ops; the third one is engineered to fail (stale hash). The first two
 * must NOT have been written; all touched files must be byte-identical to
 * pre-state.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { makeSandbox, readFile } from "../helpers/sandbox.js";

function hashFile(text: string): string {
  const h = createHash("sha256");
  h.update(text, "utf8");
  return h.digest("hex");
}

describe("S8 bulk_atomic_rollback", () => {
  it("when one op fails, no file is written", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/agents");
    try {
      await sb.call("file.create", { file: "a.md", content: "# A\n\nalpha\n" });
      await sb.call("file.create", { file: "b.md", content: "# B\n\nbeta\n" });
      await sb.call("file.create", { file: "c.md", content: "# C\n\ngamma\n" });

      const beforeA = await readFile(sb, "a.md");
      const beforeB = await readFile(sb, "b.md");
      const beforeC = await readFile(sb, "c.md");

      const r = await sb.call<{
        atomic: boolean;
        dry_run: boolean;
        validated?: boolean;
        rolled_back?: boolean;
        failing_index?: number;
        results: Array<{ ok: boolean; error?: { code: string } }>;
      }>("bulk.apply", {
        ops: [
          { tool: "str_replace", args: { file: "a.md", find: "alpha", replace: "ALPHA!" } },
          { tool: "str_replace", args: { file: "b.md", find: "beta", replace: "BETA!" } },
          // Engineered failure: hash mismatch on c.md
          {
            tool: "str_replace",
            args: {
              file: "c.md",
              find: "gamma",
              replace: "GAMMA!",
              expected_content_hash: "sha256:" + "0".repeat(64),
            },
          },
        ],
      });

      // Dry-run validation catches the failure; no real writes happen, no rollback needed.
      assert.equal(r.validated, false, "validation must fail on the third op");
      assert.equal(r.rolled_back, undefined, "no real writes → nothing to roll back");
      assert.equal(r.failing_index, undefined);
      assert.equal(r.results[0].ok, true);
      assert.equal(r.results[1].ok, true);
      assert.equal(r.results[2].ok, false);
      assert.equal(r.results[2].error?.code, "STALE_PRECONDITION");
      // The other files must remain untouched.
      const afterA = await readFile(sb, "a.md");
      const afterB = await readFile(sb, "b.md");
      const afterC = await readFile(sb, "c.md");
      assert.equal(hashFile(afterA), hashFile(beforeA));
      assert.equal(hashFile(afterB), hashFile(beforeB));
      assert.equal(hashFile(afterC), hashFile(beforeC));
    } finally {
      await sb.cleanup();
    }
  });

  it("when all ops succeed, all files are written together", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/agents");
    try {
      await sb.call("file.create", { file: "a.md", content: "# A\n\nalpha\n" });
      await sb.call("file.create", { file: "b.md", content: "# B\n\nbeta\n" });

      const r = await sb.call<{ rolled_back: boolean; results: Array<{ ok: boolean }> }>(
        "bulk.apply",
        {
          ops: [
            { tool: "str_replace", args: { file: "a.md", find: "alpha", replace: "ALPHA!" } },
            { tool: "str_replace", args: { file: "b.md", find: "beta", replace: "BETA!" } },
          ],
        },
      );

      assert.equal(r.rolled_back, false);
      assert.ok(r.results.every((x) => x.ok));
      assert.ok((await readFile(sb, "a.md")).includes("ALPHA!"));
      assert.ok((await readFile(sb, "b.md")).includes("BETA!"));
    } finally {
      await sb.cleanup();
    }
  });
});

// Silence unused
void fs;
void path;
