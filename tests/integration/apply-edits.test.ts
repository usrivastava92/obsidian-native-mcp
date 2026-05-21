/**
 * apply_edits: atomic multi-edit in a single round-trip.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeSandbox, readFile } from "../helpers/sandbox.js";

describe("apply_edits", () => {
  it("applies several str_replace ops in order, atomically", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/daily-note");
    try {
      const file = "Daily/2026-05-21.md";
      const r = await sb.call<{ changed: boolean; edits: Array<{ replacedCount: number }> }>(
        "apply_edits",
        {
          file,
          edits: [
            { find: "- [ ] task 1", replace: "- [x] task 1" },
            { find: "- [ ] task 2", replace: "- [x] task 2" },
            { find: "Morning notes go here.", replace: "Morning notes done." },
          ],
        },
      );
      assert.equal(r.changed, true);
      assert.equal(r.edits.length, 3);
      const txt = await readFile(sb, file);
      assert.ok(txt.includes("- [x] task 1"));
      assert.ok(txt.includes("- [x] task 2"));
      assert.ok(txt.includes("Morning notes done."));
    } finally {
      await sb.cleanup();
    }
  });

  it("rolls back in memory when one edit fails — no partial write", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/daily-note");
    try {
      const file = "Daily/2026-05-21.md";
      const before = await readFile(sb, file);
      const err = await sb.expectFail("apply_edits", {
        file,
        edits: [
          { find: "- [ ] task 1", replace: "- [x] task 1" },
          { find: "DOES NOT EXIST", replace: "x" }, // fails
          { find: "- [ ] task 3", replace: "- [x] task 3" },
        ],
      });
      assert.equal(err.code, "NOT_FOUND");
      assert.match(err.message, /edits\[1\] failed/);
      const after = await readFile(sb, file);
      assert.equal(after, before, "no partial write");
    } finally {
      await sb.cleanup();
    }
  });
});
