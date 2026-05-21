/**
 * S13: search.content honors limit + offset, returns lineHash per hit,
 *      reports total across pages.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeSandbox } from "../helpers/sandbox.js";

describe("S13 search_pagination", () => {
  it("limit and offset partition a large result set", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/large-kb");
    try {
      // "bullet a" appears 750× (3 per section × 250 sections).
      const page1 = await sb.call<{
        hits: Array<{ line: number; lineHash: string }>;
        total: number;
        nextOffset?: number;
      }>("search.content", { query: "bullet a", limit: 100, offset: 0 });
      assert.equal(page1.hits.length, 100);
      assert.equal(page1.total, 750);
      assert.equal(page1.nextOffset, 100);
      for (const h of page1.hits) {
        assert.match(h.lineHash, /^sha256:[0-9a-f]{64}$/);
      }
      const page2 = await sb.call<{ hits: unknown[]; nextOffset?: number }>("search.content", {
        query: "bullet a",
        limit: 100,
        offset: 100,
      });
      assert.equal(page2.hits.length, 100);
    } finally {
      await sb.cleanup();
    }
  });
});
