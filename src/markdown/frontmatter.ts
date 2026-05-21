/**
 * Frontmatter handling. Uses the `yaml` library for correctness on block
 * scalars, nested maps, anchors, comments, multi-line lists, etc.
 *
 * All public functions accept the *full file text* (canonicalised) and either
 * read the frontmatter or return new file text with the frontmatter mutated.
 *
 * Round-trip safe for typical files: we preserve user formatting for keys we
 * don't touch by editing only the affected sub-document.
 */

import { parseDocument, Document, isMap, YAMLMap, Scalar, parse as parseYaml } from "yaml";
import type { ParsedFrontmatter } from "../utils/types.js";
import { sha256Raw } from "./fingerprint.js";

const FENCE = /^---\s*\r?\n/;

interface FrontmatterBlock {
  /** 0-based byte offset where the opening `---` starts. */
  start: number;
  /** 0-based byte offset immediately after the closing `---\n`. */
  end: number;
  /** YAML body text (between the two fences, excluding them). */
  body: string;
  /** Full block text including fences. */
  raw: string;
  /** 1-based line of opening fence. */
  startLine: number;
  /** 1-based line of closing fence. */
  endLine: number;
}

/**
 * Locate the frontmatter block if present. Returns null when absent or malformed.
 * A frontmatter block must:
 *   - begin at byte 0
 *   - start with `---` followed by EOL
 *   - end with a line containing exactly `---`
 */
export function locateFrontmatter(text: string): FrontmatterBlock | null {
  if (!FENCE.test(text)) return null;
  // Find length of opening fence including newline
  const opening = text.match(FENCE)!;
  const openLen = opening[0].length;
  // Find closing fence: a line containing only `---` (with optional trailing whitespace).
  const closingRe = /\n---[ \t]*(?:\r?\n|$)/g;
  closingRe.lastIndex = openLen - 1; // start searching from end of opening line
  const m = closingRe.exec(text);
  if (!m) return null;
  const bodyStart = openLen;
  const bodyEnd = m.index + 1; // include the leading \n before --- in body? no — exclude.
  // Body excludes the leading "\n" of the closing fence line.
  const body = text.slice(bodyStart, bodyEnd);
  const end = m.index + m[0].length;
  const raw = text.slice(0, end);
  // Compute line numbers
  const startLine = 1;
  let endLine = 1;
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) endLine++;
  }
  return { start: 0, end, body, raw, startLine, endLine };
}

export function parseFrontmatter(text: string): ParsedFrontmatter | undefined {
  const block = locateFrontmatter(text);
  if (block === null) return undefined;
  let data: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(block.body) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed YAML: report as empty data; callers can detect via raw.
    data = {};
  }
  return {
    raw: block.body,
    data,
    frontmatterHash: sha256Raw(block.raw),
    startLine: block.startLine,
    endLine: block.endLine,
  };
}

/**
 * Set a (possibly nested) key in the frontmatter, returning new file text.
 * If the file has no frontmatter, one is created at the top.
 * `keyPath` uses dot-notation: e.g. `"status.priority"`.
 */
export function setFrontmatterKey(text: string, keyPath: string, value: unknown): string {
  const segs = parseKeyPath(keyPath);
  const block = locateFrontmatter(text);
  if (block === null) {
    const doc = new Document<YAMLMap>({} as Record<string, unknown>);
    setIn(doc, segs, value);
    return `---\n${doc.toString()}---\n${text}`;
  }
  const doc = parseDocument(block.body);
  setIn(doc, segs, value);
  const newBody = doc.toString();
  return text.slice(0, block.start) + `---\n${newBody}---\n` + text.slice(block.end);
}

/** Delete a (possibly nested) key. No-op (with `changed: false`) if absent. */
export function deleteFrontmatterKey(
  text: string,
  keyPath: string,
): { text: string; changed: boolean } {
  const segs = parseKeyPath(keyPath);
  const block = locateFrontmatter(text);
  if (block === null) return { text, changed: false };
  const doc = parseDocument(block.body);
  const existed = hasIn(doc, segs);
  if (!existed) return { text, changed: false };
  deleteIn(doc, segs);
  const newBody = doc.toString();
  return {
    text: text.slice(0, block.start) + `---\n${newBody}---\n` + text.slice(block.end),
    changed: true,
  };
}

export function getFrontmatterKey(text: string, keyPath?: string): unknown {
  const fm = parseFrontmatter(text);
  if (!fm) return undefined;
  if (!keyPath) return fm.data;
  return getInPlain(fm.data, parseKeyPath(keyPath));
}

// ---------------------------------------------------------------------------
// Key-path utilities
// ---------------------------------------------------------------------------

/** Parse "a.b.c" → ["a","b","c"]. Rejects empty segments. */
function parseKeyPath(keyPath: string): string[] {
  if (!keyPath || typeof keyPath !== "string") {
    throw new TypeError("keyPath must be a non-empty string");
  }
  const segs = keyPath.split(".");
  for (const s of segs) {
    if (s.length === 0) throw new TypeError(`Invalid keyPath: "${keyPath}"`);
  }
  return segs;
}

function setIn(doc: Document, segs: string[], value: unknown): void {
  doc.setIn(segs, value);
}

function deleteIn(doc: Document, segs: string[]): void {
  doc.deleteIn(segs);
}

function hasIn(doc: Document, segs: string[]): boolean {
  return doc.hasIn(segs);
}

function getInPlain(data: unknown, segs: string[]): unknown {
  let cur: unknown = data;
  for (const s of segs) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[s];
  }
  return cur;
}

// keep used imports for type checking even if tree-shaken
void isMap;
void YAMLMap;
void Scalar;
