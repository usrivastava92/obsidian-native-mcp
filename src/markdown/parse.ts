/**
 * Markdown parser wrapper over mdast (unified.js ecosystem).
 *
 * We compose:
 *   - micromark-extension-gfm           (tables, task lists, strikethrough, autolinks)
 *   - micromark-extension-frontmatter   (YAML frontmatter)
 *   - micromark-extension-wiki-link     ([[wiki]] and ![[embed]])
 *
 * The output is a mdast Root with `position` info on every node, which is
 * what makes our structural tools correct without extra bookkeeping.
 */

import type { Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { frontmatter } from "micromark-extension-frontmatter";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
// NOTE: We do NOT use micromark-extension-wiki-link / mdast-util-wiki-link.
// Those packages are unmaintained (0.0.x) and incompatible with modern
// mdast-util-from-markdown. We extract `[[wikilinks]]` and `![[embeds]]`
// ourselves in src/markdown/links.ts by walking text nodes with a regex.

const FRONTMATTER_PRESETS = ["yaml"] as const;

let cachedExtensions: ReturnType<typeof buildExtensions> | null = null;

function buildExtensions() {
  return {
    extensions: [
      gfm(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      frontmatter(FRONTMATTER_PRESETS as any),
    ],
    mdastExtensions: [
      gfmFromMarkdown(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      frontmatterFromMarkdown(FRONTMATTER_PRESETS as any),
    ],
  };
}

/**
 * Parse canonicalised markdown text into a mdast `Root`.
 * Caller is responsible for canonicalisation (see `canonicalise`).
 */
export function parseAst(canonicalText: string): Root {
  if (cachedExtensions === null) cachedExtensions = buildExtensions();
  return fromMarkdown(canonicalText, {
    extensions: cachedExtensions.extensions,
    mdastExtensions: cachedExtensions.mdastExtensions,
  }) as Root;
}
