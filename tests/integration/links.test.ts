/**
 * Link extraction (typed) + backlink resolution.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeSandbox } from "../helpers/sandbox.js";

describe("links extraction", () => {
  it("typed link kinds; ignores links inside fenced code", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/links-zoo");
    try {
      const r = await sb.call<{
        outlinks: Array<{
          kind: string;
          target?: string;
          url?: string;
          alias?: string;
          heading?: string;
          blockId?: string;
        }>;
      }>("links.get", { file: "source.md", direction: "outlinks" });

      const kinds = r.outlinks.map((l) => l.kind);
      assert.ok(kinds.includes("wiki"));
      assert.ok(kinds.includes("embed"));
      assert.ok(kinds.includes("header-ref"));
      assert.ok(kinds.includes("block-ref"));
      assert.ok(kinds.includes("markdown"));

      const headerRef = r.outlinks.find((l) => l.kind === "header-ref")!;
      assert.equal(headerRef.target, "Other");
      assert.equal(headerRef.heading, "Section A");

      const blockRef = r.outlinks.find((l) => l.kind === "block-ref")!;
      assert.equal(blockRef.target, "Other");
      assert.equal(blockRef.blockId, "block-id");

      // The "not-a-link" inside backticks must not appear.
      assert.ok(
        !r.outlinks.some((l) => "target" in l && (l as { target: string }).target === "NotALink"),
      );
      assert.ok(
        !r.outlinks.some(
          (l) =>
            "target" in l && (l as { target: string }).target === "AlsoNotAWikiLinkInsideFence",
        ),
      );
    } finally {
      await sb.cleanup();
    }
  });

  it("computes backlinks correctly", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/links-zoo");
    try {
      const r = await sb.call<{ backlinks: Array<{ file: string }> }>("links.get", {
        file: "Target.md",
        direction: "backlinks",
      });
      assert.ok(r.backlinks.some((b) => b.file === "source.md"));
    } finally {
      await sb.cleanup();
    }
  });
});
