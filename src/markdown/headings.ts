/**
 * Heading extraction & section bounds — AST-aware, so:
 *   - headings inside fenced code blocks are NOT matched
 *   - headings inside HTML comments are NOT matched
 *   - setext-style headings (===/---) ARE matched
 *   - duplicate paths are surfaced (not silently disambiguated)
 */

import type { Heading, Root, RootContent } from "mdast";
import type { HeadingInfo, Hash } from "../utils/types.js";
import { rangeHash } from "./fingerprint.js";

export function extractHeadings(
  ast: Root,
  canonical: string,
  lineOffsets: number[],
  totalLines: number,
): HeadingInfo[] {
  const headings: HeadingInfo[] = [];
  const rawHeadings: Heading[] = [];
  for (const child of ast.children) {
    if (child.type === "heading") rawHeadings.push(child);
  }
  if (rawHeadings.length === 0) return [];

  // Determine endLine for each heading: line - 1 of the next heading whose
  // level <= current level, else end of file.
  for (let i = 0; i < rawHeadings.length; i++) {
    const h = rawHeadings[i];
    const startLine = h.position!.start.line;
    let endLine = totalLines;
    for (let j = i + 1; j < rawHeadings.length; j++) {
      const next = rawHeadings[j];
      if (next.depth <= h.depth) {
        endLine = next.position!.start.line - 1;
        break;
      }
    }
    if (endLine < startLine) endLine = startLine;
    const text = headingText(h);
    const level = h.depth as 1 | 2 | 3 | 4 | 5 | 6;
    const sectionHash: Hash = rangeHash(canonical, lineOffsets, startLine, endLine);
    headings.push({
      id: `h-${i + 1}`,
      path: "", // filled below
      text,
      level,
      line: startLine,
      endLine,
      sectionHash,
      childrenCount: 0,
    });
  }

  // Compute paths and child counts using a running stack.
  const stack: HeadingInfo[] = [];
  for (const h of headings) {
    while (stack.length > 0 && stack[stack.length - 1].level >= h.level) stack.pop();
    h.path = [...stack.map((s) => s.text), h.text].join("::");
    if (stack.length > 0) stack[stack.length - 1].childrenCount += 1;
    stack.push(h);
  }

  // Detect duplicates by path
  const byPath = new Map<string, HeadingInfo[]>();
  for (const h of headings) {
    const arr = byPath.get(h.path) ?? [];
    arr.push(h);
    byPath.set(h.path, arr);
  }
  for (const [, list] of byPath) {
    if (list.length > 1) {
      const ids = list.map((h) => h.id);
      for (const h of list) {
        h.duplicateOf = ids.filter((id) => id !== h.id);
      }
    }
  }

  return headings;
}

/** Concatenate the plain-text content of a heading node. */
export function headingText(h: Heading): string {
  return textOf(h.children as RootContent[]).trim();
}

function textOf(nodes: RootContent[]): string {
  let out = "";
  for (const n of nodes) {
    if (n.type === "text") out += n.value;
    else if (n.type === "inlineCode") out += n.value;
    else if ("children" in n && Array.isArray((n as { children?: unknown[] }).children)) {
      out += textOf((n as { children: RootContent[] }).children);
    }
  }
  return out;
}

/**
 * Find headings matching `query`. Match semantics:
 *   - If `query` contains the delimiter, match against the full path.
 *   - Otherwise, match against the leaf text only.
 * Returns ALL matches; caller is responsible for disambiguation.
 */
export function findHeadings(
  headings: HeadingInfo[],
  query: string,
  delimiter: string = "::",
): HeadingInfo[] {
  const wantsPath = query.includes(delimiter);
  if (wantsPath) {
    return headings.filter((h) => h.path === query);
  }
  return headings.filter((h) => h.text === query);
}
