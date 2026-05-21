import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalise,
  sha256,
  sha256Raw,
  computeLineOffsets,
  countLines,
  sliceLines,
  rangeHash,
} from "../../src/markdown/fingerprint.js";

describe("canonicalise", () => {
  it("strips UTF-8 BOM", () => {
    assert.equal(canonicalise("\uFEFFhello"), "hello");
  });
  it("normalises CRLF to LF", () => {
    assert.equal(canonicalise("a\r\nb\r\nc"), "a\nb\nc");
  });
  it("normalises lone CR to LF", () => {
    assert.equal(canonicalise("a\rb"), "a\nb");
  });
  it("is a no-op on already-canonical input", () => {
    assert.equal(canonicalise("a\nb\n"), "a\nb\n");
  });
});

describe("sha256 / sha256Raw", () => {
  it("returns sha256:<hex> format", () => {
    assert.match(sha256("x"), /^sha256:[0-9a-f]{64}$/);
  });
  it("canonicalises input for sha256 but not sha256Raw", () => {
    assert.equal(sha256("a\r\nb"), sha256("a\nb"));
    assert.notEqual(sha256Raw("a\r\nb"), sha256Raw("a\nb"));
  });
});

describe("computeLineOffsets / countLines", () => {
  it("handles empty string", () => {
    assert.deepEqual(computeLineOffsets(""), [0]);
    assert.equal(countLines(""), 0);
  });
  it("handles single line no newline", () => {
    assert.deepEqual(computeLineOffsets("abc"), [0, 3]);
    assert.equal(countLines("abc"), 1);
  });
  it("handles trailing newline", () => {
    const offsets = computeLineOffsets("abc\n");
    assert.equal(offsets[0], 0);
    assert.equal(offsets[1], 4);
    assert.equal(countLines("abc\n"), 1);
  });
  it("handles multi-line", () => {
    const text = "abc\nde\nf";
    assert.deepEqual(computeLineOffsets(text), [0, 4, 7, 8]);
    assert.equal(countLines(text), 3);
  });
});

describe("sliceLines / rangeHash", () => {
  const text = "alpha\nbeta\ngamma\ndelta\n";
  const offsets = computeLineOffsets(text);

  it("returns line 1 only", () => {
    assert.equal(sliceLines(text, offsets, 1, 1), "alpha\n");
  });
  it("returns multi-line slice", () => {
    assert.equal(sliceLines(text, offsets, 2, 3), "beta\ngamma\n");
  });
  it("clamps `to` to total lines", () => {
    assert.equal(sliceLines(text, offsets, 3, 99), "gamma\ndelta\n");
  });
  it("returns empty when from > total", () => {
    assert.equal(sliceLines(text, offsets, 99, 99), "");
  });
  it("rejects from < 1", () => {
    assert.throws(() => sliceLines(text, offsets, 0, 1), /from must be >= 1/);
  });
  it("rejects to < from", () => {
    assert.throws(() => sliceLines(text, offsets, 2, 1), /to .* must be >= from/);
  });
  it("rangeHash is deterministic", () => {
    assert.equal(rangeHash(text, offsets, 2, 3), rangeHash(text, offsets, 2, 3));
  });
});
