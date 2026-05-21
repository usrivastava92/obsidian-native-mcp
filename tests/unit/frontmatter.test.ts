import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseFrontmatter,
  setFrontmatterKey,
  deleteFrontmatterKey,
  getFrontmatterKey,
} from "../../src/markdown/frontmatter.js";
import { readFileSync } from "node:fs";

const FIXTURE = readFileSync("tests/fixtures/vaults/frontmatter-stress/fm.md", "utf-8");

describe("frontmatter parsing", () => {
  it("locates the block at the top", () => {
    const fm = parseFrontmatter(FIXTURE);
    assert.ok(fm);
    assert.equal(typeof fm!.frontmatterHash, "string");
    assert.equal(fm!.startLine, 1);
  });
  it("parses nested keys", () => {
    const v = getFrontmatterKey(FIXTURE, "status.priority");
    assert.equal(v, "low");
  });
  it("returns undefined for missing nested key", () => {
    assert.equal(getFrontmatterKey(FIXTURE, "status.does-not-exist"), undefined);
  });
});

describe("setFrontmatterKey", () => {
  it("updates a nested key without disturbing siblings", () => {
    const updated = setFrontmatterKey(FIXTURE, "status.priority", "high");
    assert.equal(getFrontmatterKey(updated, "status.priority"), "high");
    assert.equal(getFrontmatterKey(updated, "status.owner"), "usrivastava");
    assert.equal(getFrontmatterKey(updated, "title"), "Stress Test");
  });

  it("preserves block scalar key 'description'", () => {
    const updated = setFrontmatterKey(FIXTURE, "title", "Renamed");
    const desc = getFrontmatterKey(updated, "description");
    assert.ok(typeof desc === "string");
    assert.match(desc as string, /multi-line block scalar/);
    assert.match(desc as string, /preserved exactly/);
  });

  it("creates frontmatter if absent", () => {
    const text = "# No frontmatter yet\n";
    const updated = setFrontmatterKey(text, "title", "Hi");
    assert.match(updated, /^---\n/);
    assert.equal(getFrontmatterKey(updated, "title"), "Hi");
  });

  it("rejects empty or dotted-empty key paths", () => {
    assert.throws(() => setFrontmatterKey(FIXTURE, "", "x"));
    assert.throws(() => setFrontmatterKey(FIXTURE, "a..b", "x"));
  });
});

describe("deleteFrontmatterKey", () => {
  it("removes a nested key and reports changed=true", () => {
    const r = deleteFrontmatterKey(FIXTURE, "status.owner");
    assert.equal(r.changed, true);
    assert.equal(getFrontmatterKey(r.text, "status.owner"), undefined);
    assert.equal(getFrontmatterKey(r.text, "status.priority"), "low");
  });

  it("is a no-op for missing key", () => {
    const r = deleteFrontmatterKey(FIXTURE, "missing");
    assert.equal(r.changed, false);
    assert.equal(r.text, FIXTURE);
  });

  it("does NOT confuse 'alias' with 'aliases' (prefix-match guard)", () => {
    // Note: there is no top-level 'alias' key — only 'aliases'.
    const r = deleteFrontmatterKey(FIXTURE, "alias");
    assert.equal(r.changed, false);
    assert.deepEqual(getFrontmatterKey(r.text, "aliases"), ["alpha", "beta"]);
  });
});
