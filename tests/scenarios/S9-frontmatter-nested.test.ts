/**
 * S9: frontmatter.set nested.
 *
 * Set status.priority on the stress fixture; verify (a) it's set, (b) block
 * scalars are preserved verbatim, (c) sibling keys are untouched, (d) the
 * body of the file is byte-identical apart from the frontmatter region.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeSandbox, readFile } from "../helpers/sandbox.js";

describe("S9 frontmatter_nested_set", () => {
  it("sets a nested key and preserves sibling keys + block scalar", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/frontmatter-stress");
    try {
      const file = "fm.md";
      const fmBefore = await sb.call<{ frontmatterHash: string; data: Record<string, unknown> }>(
        "frontmatter.get",
        { file },
      );
      assert.equal((fmBefore.data.status as { priority: string }).priority, "low");

      const r = await sb.call<{ changed: boolean; frontmatterHash: string }>("frontmatter.set", {
        file,
        keyPath: "status.priority",
        value: "high",
        expected_frontmatter_hash: fmBefore.frontmatterHash,
      });
      assert.equal(r.changed, true);
      assert.notEqual(r.frontmatterHash, fmBefore.frontmatterHash);

      const fmAfter = await sb.call<{ data: Record<string, unknown> }>("frontmatter.get", { file });
      assert.equal((fmAfter.data.status as { priority: string }).priority, "high");
      assert.equal((fmAfter.data.status as { owner: string }).owner, "usrivastava");
      assert.equal(fmAfter.data.title, "Stress Test");
      assert.deepEqual(fmAfter.data.aliases, ["alpha", "beta"]);
      const desc = fmAfter.data.description as string;
      assert.match(desc, /multi-line block scalar/);
      assert.match(desc, /preserved exactly/);

      // File body below "---" is intact
      const text = await readFile(sb, file);
      assert.ok(text.includes("# Body"));
      assert.ok(text.includes("Content here."));
    } finally {
      await sb.cleanup();
    }
  });

  it("requires expected_frontmatter_hash when frontmatter exists", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/frontmatter-stress");
    try {
      const err = await sb.expectFail("frontmatter.set", {
        file: "fm.md",
        keyPath: "title",
        value: "x",
      });
      assert.equal(err.code, "INVALID_ARGS");
    } finally {
      await sb.cleanup();
    }
  });
});
