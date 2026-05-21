/**
 * S10: code-fence safety.
 *
 * The headings AST parser must skip fenced code; therefore heading.find /
 * heading.replace_body / outline MUST NOT operate on a "heading" that is
 * actually a comment line inside a code block.
 *
 * This is the single highest-blast-radius bug in v0.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeSandbox, readFile } from "../helpers/sandbox.js";

describe("S10 code_fence_safety", () => {
  it("outline omits fenced-code 'headings' and html-comment 'headings'", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/code-heavy");
    try {
      const o = await sb.call<{ headings: Array<{ text: string }> }>("outline", {
        file: "code-heavy.md",
      });
      const texts = o.headings.map((h) => h.text);
      assert.ok(texts.includes("Real Heading"));
      assert.ok(texts.includes("Real Subheading"));
      assert.ok(!texts.includes("Fake Heading In Code"));
      assert.ok(!texts.includes("Commented Heading Should Be Ignored"));
    } finally {
      await sb.cleanup();
    }
  });

  it("heading.find returns no match for a fenced-code 'heading'", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/code-heavy");
    try {
      const r = await sb.call<{ matches: unknown[] }>("heading.find", {
        file: "code-heavy.md",
        heading: "Fake Heading In Code",
      });
      assert.equal(r.matches.length, 0);
    } finally {
      await sb.cleanup();
    }
  });

  it("heading.replace_body errors on fenced 'heading' and DOES NOT touch the file", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/code-heavy");
    try {
      const before = await readFile(sb, "code-heavy.md");
      const err = await sb.expectFail("heading.replace_body", {
        file: "code-heavy.md",
        heading: "Fake Heading In Code",
        content: "OOPS",
        expected_section_hash: "sha256:0".padEnd(71, "0"),
      });
      assert.equal(err.code, "NOT_FOUND");
      const after = await readFile(sb, "code-heavy.md");
      assert.equal(after, before, "file must be untouched on NOT_FOUND");
    } finally {
      await sb.cleanup();
    }
  });

  it("tags inside code fences are not counted", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/code-heavy");
    try {
      const t = await sb.call<{ tags: Array<{ tag: string }> }>("tags.list", {
        file: "code-heavy.md",
      });
      const list = t.tags.map((x) => x.tag);
      assert.ok(list.includes("real-tag"));
      assert.ok(!list.includes("fake-tag"));
      assert.ok(!list.includes("also-not-a-tag"));
      // URL-fragment guard
      assert.ok(!list.includes("fragment"));
    } finally {
      await sb.cleanup();
    }
  });
});
