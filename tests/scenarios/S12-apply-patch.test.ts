/**
 * S12: apply_patch context-line validation.
 *
 * The diff's context lines ARE the precondition. A stale context line must
 * abort the entire patch — no partial application.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeSandbox, readFile, writeFileRaw } from "../helpers/sandbox.js";

const ORIGINAL = `# Header

line one
line two
line three

footer
`;

const VALID_PATCH = `@@ -3,3 +3,4 @@
 line one
-line two
+line two MODIFIED
+line two and a half
 line three
`;

const STALE_PATCH = `@@ -3,3 +3,3 @@
 line one
-line WRONG
+line two MODIFIED
 line three
`;

describe("S12 apply_patch", () => {
  it("applies a valid unified diff and updates content_hash", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/tiny");
    try {
      await writeFileRaw(sb, "doc.md", ORIGINAL);
      const beforeRead = await sb.call<{ contentHash: string; totalLines: number }>("file.read", {
        file: "doc.md",
      });
      const r = await sb.call<{ changed: boolean; contentHash: string; hunks: number }>(
        "apply_patch",
        {
          file: "doc.md",
          patch: VALID_PATCH,
        },
      );
      assert.equal(r.changed, true);
      assert.equal(r.hunks, 1);
      assert.notEqual(r.contentHash, beforeRead.contentHash);
      const txt = await readFile(sb, "doc.md");
      assert.ok(txt.includes("line two MODIFIED"));
      assert.ok(txt.includes("line two and a half"));
    } finally {
      await sb.cleanup();
    }
  });

  it("errors STALE_PRECONDITION when a delete-line context doesn't match", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/tiny");
    try {
      await writeFileRaw(sb, "doc.md", ORIGINAL);
      const before = await readFile(sb, "doc.md");
      const err = await sb.expectFail("apply_patch", {
        file: "doc.md",
        patch: STALE_PATCH,
      });
      assert.equal(err.code, "STALE_PRECONDITION");
      const after = await readFile(sb, "doc.md");
      assert.equal(after, before, "file must be untouched on patch failure");
    } finally {
      await sb.cleanup();
    }
  });

  it("expected_content_hash mismatch is detected before parsing patch", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/tiny");
    try {
      await writeFileRaw(sb, "doc.md", ORIGINAL);
      const err = await sb.expectFail("apply_patch", {
        file: "doc.md",
        patch: VALID_PATCH,
        expected_content_hash: "sha256:" + "0".repeat(64),
      });
      assert.equal(err.code, "STALE_PRECONDITION");
    } finally {
      await sb.cleanup();
    }
  });
});
