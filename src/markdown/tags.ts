/**
 * Tag extraction. AST-aware: tags inside fenced code blocks, inline code,
 * HTML, frontmatter (we extract those separately), or URLs are NOT counted.
 *
 * Obsidian tags:
 *   - Begin with `#` followed by a tag name made of [a-zA-Z0-9_/-]
 *   - Must not start with a digit (e.g. `#404` is NOT a tag, by Obsidian rule)
 *   - Cannot be immediately preceded by an alphanumeric or `]` (to skip
 *     `https://example.com#fragment` inside an autolink that survived).
 */

import type { Root, RootContent } from "mdast";

const TAG_RE = /(?:^|[^\w\]])#([A-Za-z][\w/-]*)/g;

export function extractTags(ast: Root): string[] {
  const seen = new Set<string>();
  walk(ast, seen);
  // Stable ordering: by first appearance order
  return Array.from(seen);
}

const SKIP_TYPES = new Set(["code", "inlineCode", "html", "yaml", "toml", "link", "image"]);

function walk(node: Root | RootContent, out: Set<string>): void {
  if (!node) return;
  const t = (node as { type: string }).type;
  if (SKIP_TYPES.has(t)) return;
  if (t === "text") {
    const v = (node as { value: string }).value;
    let m: RegExpExecArray | null;
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(v)) !== null) {
      out.add(m[1]);
    }
    return;
  }
  const anyNode = node as unknown as { children?: RootContent[] };
  if (Array.isArray(anyNode.children)) {
    for (const c of anyNode.children) walk(c, out);
  }
}
