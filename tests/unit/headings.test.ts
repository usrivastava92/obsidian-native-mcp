import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFile } from "../../src/markdown/parse-file.js";
import { findHeadings } from "../../src/markdown/headings.js";
import * as path from "node:path";
import { readFileSync, statSync } from "node:fs";

function loadFixture(rel: string) {
  const abs = path.resolve("tests/fixtures/vaults", rel);
  const stat = statSync(abs);
  const rawText = readFileSync(abs, "utf-8");
  return parseFile({ path: rel, absPath: abs, rawText, stat });
}

describe("headings (AST-aware)", () => {
  it("does NOT match a heading inside a fenced code block", () => {
    const f = loadFixture("code-heavy/code-heavy.md");
    const fake = f.headings.find((h) => h.text === "Fake Heading In Code");
    assert.equal(fake, undefined, "fenced-code heading must be ignored");
    const real = f.headings.find((h) => h.text === "Real Heading");
    assert.ok(real, "real heading should be detected");
  });

  it("does NOT match a heading inside an HTML comment", () => {
    const f = loadFixture("code-heavy/code-heavy.md");
    const commented = f.headings.find((h) => h.text === "Commented Heading Should Be Ignored");
    assert.equal(commented, undefined);
  });

  it("computes hierarchical paths with `::` separator", () => {
    const f = loadFixture("dup-headings/dup-headings.md");
    const paths = f.headings.map((h) => h.path);
    assert.deepEqual(paths, [
      "Project",
      "Project::Tasks",
      "Project::Notes",
      "Project::Tasks",
      "Project::Tasks::Tasks",
    ]);
  });

  it("flags duplicate paths via duplicateOf", () => {
    const f = loadFixture("dup-headings/dup-headings.md");
    const tasksMatches = f.headings.filter((h) => h.path === "Project::Tasks");
    assert.equal(tasksMatches.length, 2);
    for (const m of tasksMatches) {
      assert.ok(m.duplicateOf && m.duplicateOf.length === 1);
    }
  });

  it("section bounds are correct: section runs to next same-or-shallower heading", () => {
    const f = loadFixture("agents/AGENTS.md");
    const style = f.headings.find((h) => h.text === "Style")!;
    const process = f.headings.find((h) => h.text === "Process")!;
    assert.equal(style.endLine, process.line - 1, "Style ends right before Process");
  });

  it("findHeadings disambiguates by full path when delimiter present", () => {
    const f = loadFixture("dup-headings/dup-headings.md");
    const byLeaf = findHeadings(f.headings, "Tasks");
    assert.equal(byLeaf.length, 3);
    const byPath = findHeadings(f.headings, "Project::Notes");
    assert.equal(byPath.length, 1);
    assert.equal(byPath[0].text, "Notes");
  });
});
