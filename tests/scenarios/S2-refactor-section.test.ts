/**
 * S2: Refactor a heading section via heading.find → heading.replace_body.
 *
 * Proves the structural-edit round-trip: model gets section_hash from find,
 * passes it back as the precondition, replaces only that section. Unrelated
 * sections are byte-identical after the edit.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeSandbox, readFile } from "../helpers/sandbox.js";

describe("S2 refactor_section", () => {
  it("replaces a single heading body and leaves other sections untouched", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/agents");
    try {
      const file = "AGENTS.md";
      const before = await readFile(sb, file);

      const found = await sb.call<{
        matches: Array<{ path: string; line: number; endLine: number; sectionHash: string }>;
      }>("heading.find", { file, heading: "Process" });
      assert.equal(found.matches.length, 1);
      const target = found.matches[0];

      const r = await sb.call<{ changed: boolean; contentHash: string }>("heading.replace_body", {
        file,
        heading: "Process",
        content: "1. Refactored step.\n2. Another step.\n",
        expected_section_hash: target.sectionHash,
      });
      assert.equal(r.changed, true);

      const after = await readFile(sb, file);
      assert.notEqual(after, before);
      assert.ok(after.includes("## Process"), "heading itself preserved");
      assert.ok(after.includes("1. Refactored step."));
      // Other sections untouched
      assert.ok(after.includes("## Style"));
      assert.ok(after.includes("Be concise. Be honest."));
      assert.ok(after.includes("## Forbidden"));
      assert.ok(after.includes("- Inventing data."));
    } finally {
      await sb.cleanup();
    }
  });

  it("errors with DUPLICATE_TARGET when the leaf is ambiguous", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/dup-headings");
    try {
      const err = await sb.expectFail("heading.replace_body", {
        file: "dup-headings.md",
        heading: "Tasks",
        content: "new body",
        expected_section_hash: "sha256:" + "0".repeat(64),
      });
      assert.equal(err.code, "DUPLICATE_TARGET");
      const matches = err.details?.matches as Array<{ path: string }>;
      assert.ok(matches.length >= 2);
      assert.ok(matches.some((m) => m.path === "Project::Tasks"));
    } finally {
      await sb.cleanup();
    }
  });

  it("succeeds when the full path disambiguates the duplicate", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/dup-headings");
    try {
      const file = "dup-headings.md";
      const found = await sb.call<{ matches: Array<{ path: string; sectionHash: string }> }>(
        "heading.find",
        { file, heading: "Project::Notes" },
      );
      assert.equal(found.matches.length, 1);
      const r = await sb.call<{ changed: boolean }>("heading.replace_body", {
        file,
        heading: "Project::Notes",
        content: "Updated notes.\n",
        expected_section_hash: found.matches[0].sectionHash,
      });
      assert.equal(r.changed, true);
      const text = await readFile(sb, file);
      assert.ok(text.includes("## Notes\nUpdated notes."));
    } finally {
      await sb.cleanup();
    }
  });
});
