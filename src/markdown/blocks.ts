/**
 * Block-reference (`^id`) extraction & lookup, AST-aware.
 *
 * Obsidian block refs attach to a *structural block*: a paragraph, list item,
 * table row, callout, code block, or heading. The `^id` marker appears on
 * the last line of the block, separated by whitespace.
 *
 * We walk the AST top-level children, then for each block-typed node we
 * inspect the last line's text for a trailing `\s^id` token.
 */

import type { Root, RootContent } from "mdast";
import type { BlockInfo, BlockStructuralType, Hash } from "../utils/types.js";
import { rangeHash } from "./fingerprint.js";

const BLOCK_REF_RE = /(?:^|\s)\^([A-Za-z0-9-_]+)\s*$/;

export function extractBlocks(ast: Root, canonical: string, lineOffsets: number[]): BlockInfo[] {
  const blocks: BlockInfo[] = [];
  visit(ast, canonical, lineOffsets, blocks);
  return blocks;
}

function visit(
  node: Root | RootContent,
  canonical: string,
  lineOffsets: number[],
  out: BlockInfo[],
): void {
  // Only top-level children of Root are "blocks" for ref purposes (per Obsidian).
  if (node.type === "root") {
    for (const child of node.children) walkBlock(child, canonical, lineOffsets, out);
  }
}

function walkBlock(
  node: RootContent,
  canonical: string,
  lineOffsets: number[],
  out: BlockInfo[],
): void {
  const pos = node.position;
  if (!pos) return;
  const startLine = pos.start.line;
  const endLine = pos.end.line;
  // Read the last line's text from the canonical source
  const lastLine = sliceLine(canonical, lineOffsets, endLine);
  const m = BLOCK_REF_RE.exec(lastLine);
  if (!m) {
    // No block ref on the last line — but list items / table rows can carry
    // refs per-row, so recurse into them.
    if (node.type === "list") {
      for (const item of node.children) walkBlock(item, canonical, lineOffsets, out);
      return;
    }
    if (node.type === "table") {
      for (const row of node.children) walkBlock(row, canonical, lineOffsets, out);
      return;
    }
    return;
  }
  const id = `^${m[1]}`;
  const structuralType = structuralOf(node.type);
  const blockHash: Hash = rangeHash(canonical, lineOffsets, startLine, endLine);
  out.push({
    id,
    line: endLine,
    startLine,
    endLine,
    blockHash,
    structuralType,
  });
}

function sliceLine(canonical: string, lineOffsets: number[], line: number): string {
  if (line < 1 || line > lineOffsets.length - 1) return "";
  const start = lineOffsets[line - 1];
  const end = lineOffsets[line];
  // Strip trailing newline for matching convenience
  let slice = canonical.slice(start, end);
  if (slice.endsWith("\n")) slice = slice.slice(0, -1);
  return slice;
}

function structuralOf(type: string): BlockStructuralType {
  switch (type) {
    case "paragraph":
      return "paragraph";
    case "listItem":
      return "list-item";
    case "tableRow":
      return "table-row";
    case "code":
      return "code";
    case "heading":
      return "heading";
    case "blockquote":
      return "callout"; // Obsidian callouts are blockquotes
    default:
      return "other";
  }
}

/** Find block by id. Always returns all matches (Obsidian normally has one). */
export function findBlocks(blocks: BlockInfo[], id: string): BlockInfo[] {
  const normalized = id.startsWith("^") ? id : `^${id}`;
  return blocks.filter((b) => b.id === normalized);
}
