/**
 * Build a navigation outline from a parsed file. The outline is just the
 * headings array with an optional depth cap — kept as a separate module
 * to make it easy for the LLM-facing tool to call directly.
 */

import type { HeadingInfo } from "../utils/types.js";

export interface Outline {
  headings: HeadingInfo[];
}

export function buildOutline(headings: HeadingInfo[], maxDepth?: number): Outline {
  if (typeof maxDepth === "number") {
    return { headings: headings.filter((h) => h.level <= maxDepth) };
  }
  return { headings: headings.slice() };
}
