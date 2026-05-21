/**
 * Typed link extraction. AST-aware so links inside fenced code, HTML, or
 * frontmatter are not surfaced. Wikilinks/embeds are extracted by regex over
 * `text` nodes only — we deliberately do not use the unmaintained
 * micromark-extension-wiki-link package.
 *
 * Recognised kinds:
 *   - wiki         [[Target]]
 *   - embed        ![[Target]]
 *   - header-ref   [[Target#Heading]] or [[T#H|Alias]]
 *   - block-ref    [[Target^block-id]] or with alias
 *   - markdown     [text](url)
 */

import type { Root, RootContent, Link } from "mdast";
import type { ExtractedLink } from "../utils/types.js";

const SKIP_TYPES = new Set(["code", "html", "yaml", "toml", "inlineCode"]);

// [[Target#Header^block|alias]] — captures target, optional #header, optional ^block, optional |alias
const WIKILINK_RE =
  /(!?)\[\[([^\]\n|#^]+)(?:#([^\]\n|^]+))?(?:\^([^\]\n|]+))?(?:\|([^\]\n]+))?\]\]/g;

export function extractLinks(ast: Root, _canonical: string): ExtractedLink[] {
  const out: ExtractedLink[] = [];
  walk(ast, out);
  return out;
}

function walk(node: Root | RootContent, out: ExtractedLink[]): void {
  if (!node) return;
  const t = (node as { type: string }).type;
  if (SKIP_TYPES.has(t)) return;

  if (t === "text") {
    const n = node as unknown as {
      value: string;
      position?: { start: { line: number; column: number } };
    };
    const startLine = n.position?.start.line ?? 0;
    const startCol = n.position?.start.column ?? 0;
    const text = n.value;
    WIKILINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKILINK_RE.exec(text)) !== null) {
      const bang = m[1];
      const target = m[2];
      const heading = m[3];
      const blockId = m[4];
      const alias = m[5];
      // For multi-line text values, compute line offset of this match
      const before = text.slice(0, m.index);
      const nlCount = (before.match(/\n/g) ?? []).length;
      const lastNl = before.lastIndexOf("\n");
      const line = startLine + nlCount;
      const col = nlCount === 0 ? startCol + m.index : m.index - lastNl;
      if (blockId !== undefined) {
        out.push({ kind: "block-ref", target, blockId, alias, line, col });
      } else if (heading !== undefined) {
        out.push({ kind: "header-ref", target, heading, alias, line, col });
      } else if (bang === "!") {
        out.push({ kind: "embed", target, alias, line, col });
      } else {
        out.push({ kind: "wiki", target, alias, line, col });
      }
    }
    return;
  }

  if (t === "link") {
    const l = node as Link;
    const text = collectText(l.children as RootContent[]);
    out.push({
      kind: "markdown",
      text,
      url: l.url,
      line: l.position?.start.line ?? 0,
      col: l.position?.start.column ?? 0,
    });
    return;
  }

  const anyNode = node as unknown as { children?: RootContent[] };
  if (Array.isArray(anyNode.children)) {
    for (const c of anyNode.children) walk(c, out);
  }
}

function collectText(nodes: RootContent[]): string {
  let s = "";
  for (const n of nodes) {
    if (n.type === "text") s += n.value;
    else if (n.type === "inlineCode") s += n.value;
    else if ("children" in n && Array.isArray((n as { children?: unknown[] }).children)) {
      s += collectText((n as { children: RootContent[] }).children);
    }
  }
  return s;
}
