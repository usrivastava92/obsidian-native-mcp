/**
 * Top-level "parse a markdown file" entry point used by the cache. Combines:
 *   canonicalise → parseAst → frontmatter/headings/blocks/links/tags
 * into a single `ParsedFile`.
 */

import type { Stats } from "node:fs";
import type { ParsedFile, RelPath } from "../utils/types.js";
import { canonicalise, computeLineOffsets, countLines, sha256Raw } from "./fingerprint.js";
import { parseAst } from "./parse.js";
import { parseFrontmatter } from "./frontmatter.js";
import { extractHeadings } from "./headings.js";
import { extractBlocks } from "./blocks.js";
import { extractLinks } from "./links.js";
import { extractTags } from "./tags.js";

export interface ParseInput {
  path: RelPath;
  absPath: string;
  rawText: string;
  stat: Pick<Stats, "mtimeMs" | "size">;
}

export function parseFile(input: ParseInput): ParsedFile {
  const text = canonicalise(input.rawText);
  const contentHash = sha256Raw(text);
  const lineOffsets = computeLineOffsets(text);
  const totalLines = countLines(text);
  const ast = parseAst(text);
  const frontmatter = parseFrontmatter(text);
  const headings = extractHeadings(ast, text, lineOffsets, totalLines);
  const blocks = extractBlocks(ast, text, lineOffsets);
  const links = extractLinks(ast, text);
  const tags = extractTags(ast);
  return {
    path: input.path,
    absPath: input.absPath,
    text,
    contentHash,
    mtimeMs: input.stat.mtimeMs,
    size: input.stat.size,
    ast,
    lineOffsets,
    totalLines,
    headings,
    blocks,
    links,
    tags,
    frontmatter,
  };
}
