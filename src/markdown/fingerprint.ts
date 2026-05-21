/**
 * Canonical-form hashing. See DESIGN_V1.md §4.
 *
 * All inputs are canonicalised before hashing:
 *   - UTF-8 BOM stripped
 *   - CRLF/CR → LF
 *
 * No trailing-newline normalisation: we hash the canonicalised bytes verbatim.
 */

import { createHash } from "node:crypto";
import type { Hash } from "../utils/types.js";

/** Strip UTF-8 BOM and normalise line endings to "\n". */
export function canonicalise(text: string): string {
  let out = text;
  if (out.length > 0 && out.charCodeAt(0) === 0xfeff) {
    out = out.slice(1);
  }
  if (out.indexOf("\r") !== -1) {
    out = out.replace(/\r\n?/g, "\n");
  }
  return out;
}

/** Compute `sha256:<hex>` of a string after canonicalisation. */
export function sha256(text: string): Hash {
  const h = createHash("sha256");
  h.update(canonicalise(text), "utf8");
  return `sha256:${h.digest("hex")}`;
}

/** Compute `sha256:<hex>` of raw bytes (no canonicalisation). */
export function sha256Raw(text: string): Hash {
  const h = createHash("sha256");
  h.update(text, "utf8");
  return `sha256:${h.digest("hex")}`;
}

/**
 * Build a sorted array of line-start byte offsets for a canonicalised string.
 * Returns `[0, offset_of_line_2, ..., text.length]` (sentinel at end).
 * Therefore `lineOffsets[i]` is the start of line `i+1`, and the slice for
 * lines `[from..to]` (1-based, inclusive) is
 * `text.slice(lineOffsets[from-1], lineOffsets[to])`.
 */
export function computeLineOffsets(canonical: string): number[] {
  const offsets: number[] = [0];
  for (let i = 0; i < canonical.length; i++) {
    if (canonical.charCodeAt(i) === 10 /* \n */) {
      offsets.push(i + 1);
    }
  }
  // Sentinel: end-of-text (one past last line, only if last line had no
  // trailing newline) — ensures lineOffsets[totalLines] === text.length.
  if (offsets[offsets.length - 1] !== canonical.length) {
    offsets.push(canonical.length);
  }
  return offsets;
}

/**
 * Total number of "logical" lines in canonicalised text.
 * A trailing "\n" does NOT count as creating an empty extra line.
 * Examples:
 *   ""       → 0
 *   "abc"    → 1
 *   "abc\n"  → 1
 *   "abc\nd" → 2
 *   "\n"     → 1
 */
export function countLines(canonical: string): number {
  if (canonical.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < canonical.length - 1; i++) {
    if (canonical.charCodeAt(i) === 10) n++;
  }
  if (canonical.charCodeAt(canonical.length - 1) === 10) {
    // trailing newline: no extra logical line
  }
  return n;
}

/**
 * Extract the byte range for lines `[from..to]` (1-based, inclusive) from
 * canonicalised text using a precomputed `lineOffsets` array.
 */
export function sliceLines(
  canonical: string,
  lineOffsets: number[],
  from: number,
  to: number,
): string {
  if (from < 1) throw new RangeError(`from must be >= 1, got ${from}`);
  if (to < from) throw new RangeError(`to (${to}) must be >= from (${from})`);
  const totalLines = lineOffsets.length - 1;
  if (from > totalLines) return "";
  const clampedTo = Math.min(to, totalLines);
  const start = lineOffsets[from - 1];
  const end = lineOffsets[clampedTo];
  return canonical.slice(start, end);
}

/** Hash a line range. */
export function rangeHash(
  canonical: string,
  lineOffsets: number[],
  from: number,
  to: number,
): Hash {
  return sha256Raw(sliceLines(canonical, lineOffsets, from, to));
}
