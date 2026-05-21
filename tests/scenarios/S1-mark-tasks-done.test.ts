/**
 * S1: Mark tasks done in a daily note via repeated str_replace calls.
 *
 * Proves the cheap surgical-edit loop works: no full-file read/write needed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeSandbox, readFile } from "../helpers/sandbox.js";

describe("S1 mark_tasks_done", () => {
  it("flips four checkboxes with four str_replace calls", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/daily-note");
    try {
      const file = "Daily/2026-05-21.md";
      for (let i = 1; i <= 4; i++) {
        const result = await sb.call<{ changed: boolean; replacedCount: number }>("str_replace", {
          file,
          find: `- [ ] task ${i}`,
          replace: `- [x] task ${i}`,
        });
        assert.equal(result.changed, true, `task ${i} should change`);
        assert.equal(result.replacedCount, 1);
      }
      const text = await readFile(sb, file);
      for (let i = 1; i <= 4; i++) {
        assert.ok(text.includes(`- [x] task ${i}`), `task ${i} should be done`);
      }
      // No unrelated drift
      assert.ok(text.includes("## Notes"));
      assert.ok(text.includes("Morning notes go here."));
    } finally {
      await sb.cleanup();
    }
  });

  it("errors with DUPLICATE_TARGET when find string isn't unique", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/dup-headings");
    try {
      const err = await sb.expectFail("str_replace", {
        file: "dup-headings.md",
        find: "## Tasks",
        replace: "## TASKS!",
      });
      assert.equal(err.code, "DUPLICATE_TARGET");
      assert.ok((err.details?.occurrences as number) >= 2);
    } finally {
      await sb.cleanup();
    }
  });

  it("with occurrence='all' replaces every match", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/dup-headings");
    try {
      const result = await sb.call<{ replacedCount: number }>("str_replace", {
        file: "dup-headings.md",
        find: "## Tasks",
        replace: "## TASKS!",
        occurrence: "all",
      });
      // Substring "## Tasks" appears 3× in the fixture:
      //   - two as actual '## Tasks' headings
      //   - one as a substring of '### Tasks' (chars 1..8)
      // This demonstrates why str_replace defaults to occurrence:'unique'.
      assert.equal(result.replacedCount, 3);
    } finally {
      await sb.cleanup();
    }
  });
});
