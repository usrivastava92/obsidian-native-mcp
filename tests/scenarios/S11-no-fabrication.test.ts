/**
 * S11: no fabrication on missing target.
 *
 * v0 silently invented headings; v1 must error with NOT_FOUND and leave the
 * file byte-identical.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeSandbox, readFile } from "../helpers/sandbox.js";

describe("S11 no_fabrication_on_missing", () => {
  it("heading.replace_body errors and leaves file unchanged", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/agents");
    try {
      const before = await readFile(sb, "AGENTS.md");
      const err = await sb.expectFail("heading.replace_body", {
        file: "AGENTS.md",
        heading: "Does Not Exist",
        content: "FABRICATED",
        expected_section_hash: "sha256:0".padEnd(71, "0"),
      });
      assert.equal(err.code, "NOT_FOUND");
      const after = await readFile(sb, "AGENTS.md");
      assert.equal(after, before);
    } finally {
      await sb.cleanup();
    }
  });

  it("file.create errors with DESTINATION_EXISTS on existing file", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/agents");
    try {
      const err = await sb.expectFail("file.create", {
        file: "AGENTS.md",
        content: "should not write",
      });
      assert.equal(err.code, "DESTINATION_EXISTS");
    } finally {
      await sb.cleanup();
    }
  });

  it("file.move with default on_conflict errors when destination exists", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/dup-headings");
    try {
      // Create a second file to collide with
      await sb.call("file.create", { file: "other.md", content: "# Other\n" });
      const err = await sb.expectFail("file.move", {
        from: "dup-headings.md",
        to: "other.md",
      });
      assert.equal(err.code, "DESTINATION_EXISTS");
    } finally {
      await sb.cleanup();
    }
  });

  it("file.move with on_conflict='rename' uniquifies", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/dup-headings");
    try {
      await sb.call("file.create", { file: "other.md", content: "# Other\n" });
      const r = await sb.call<{ to: string }>("file.move", {
        from: "dup-headings.md",
        to: "other.md",
        on_conflict: "rename",
      });
      assert.match(r.to, /other \(1\)\.md$/);
    } finally {
      await sb.cleanup();
    }
  });
});
