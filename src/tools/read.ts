/**
 * Read-side tools (no write permission required).
 *
 * Every read returns hashes so the LLM's next surgical write can pass them
 * back as a precondition without re-reading.
 */

import * as path from "node:path";
import { ToolFailure } from "../utils/types.js";
import type { ToolDefinition } from "../handlers/registry.js";
import { getString, reqString, getInt, getEnum, getBool } from "../handlers/args.js";
import { loadFile, resolvePath } from "./common.js";
import { sliceLines, rangeHash } from "../markdown/fingerprint.js";
import { buildOutline } from "../markdown/outline.js";
import { findHeadings } from "../markdown/headings.js";
import { findBlocks } from "../markdown/blocks.js";
import { walk } from "../fs/walk.js";
import picomatch from "picomatch";
import { readText, fileExists } from "../fs/io.js";

// ---------------------------------------------------------------------------
// vault.list
// ---------------------------------------------------------------------------

export const vaultListTool: ToolDefinition = {
  name: "vault.list",
  summary: "List all configured vaults by name.",
  requiresWrite: false,
  schema: { type: "object", properties: {}, additionalProperties: false },
  async handler(_args, ctx) {
    const list = ctx.registry.list().map((v) => ({ name: v.name }));
    return { vaults: list };
  },
};

// ---------------------------------------------------------------------------
// vault.info
// ---------------------------------------------------------------------------

export const vaultInfoTool: ToolDefinition = {
  name: "vault.info",
  summary: "Get statistics for a single vault.",
  requiresWrite: false,
  schema: {
    type: "object",
    properties: { vault: { type: "string" } },
    additionalProperties: false,
  },
  async handler(_args, ctx) {
    let fileCount = 0;
    let sizeBytes = 0;
    for await (const e of walk(ctx.vault.root, { extensions: ["md"] })) {
      if (e.type === "file") {
        fileCount++;
        sizeBytes += e.size;
      }
    }
    return { name: ctx.vault.name, fileCount, sizeBytes };
  },
};

// ---------------------------------------------------------------------------
// file.list
// ---------------------------------------------------------------------------

export const fileListTool: ToolDefinition = {
  name: "file.list",
  summary:
    "List files/directories in the vault, optionally recursively, with optional glob filter.",
  requiresWrite: false,
  schema: {
    type: "object",
    properties: {
      vault: { type: "string" },
      directory: { type: "string", description: "Vault-relative directory" },
      recursive: { type: "boolean" },
      glob: { type: "string", description: "picomatch glob, matched against vault-relative path" },
      limit: { type: "integer", minimum: 1, maximum: 10000 },
      offset: { type: "integer", minimum: 0 },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const directory = getString(args, "directory", { optional: true });
    const recursive = getBool(args, "recursive", { optional: true, default: false });
    const glob = getString(args, "glob", { optional: true });
    const limit = getInt(args, "limit", { optional: true, min: 1, max: 10000 }) ?? 1000;
    const offset = getInt(args, "offset", { optional: true, min: 0 }) ?? 0;
    const rootAbs = directory ? resolvePath(ctx, directory) : ctx.vault.root;
    const matcher = glob ? picomatch(glob) : null;
    const matches: Array<{
      path: string;
      type: "file" | "directory";
      sizeBytes: number;
      mtimeMs: number;
    }> = [];
    let count = 0;
    for await (const e of walk(rootAbs, { maxDepth: recursive ? Infinity : 0 })) {
      if (matcher && !matcher(e.relPath)) continue;
      count++;
      if (count <= offset) continue;
      if (matches.length >= limit) continue;
      matches.push({ path: e.relPath, type: e.type, sizeBytes: e.size, mtimeMs: e.mtimeMs });
    }
    return {
      entries: matches,
      total: count,
      nextOffset: offset + matches.length < count ? offset + matches.length : undefined,
    };
  },
};

// ---------------------------------------------------------------------------
// file.find  (filename search by exact / substring / glob / regex)
// ---------------------------------------------------------------------------

export const fileFindTool: ToolDefinition = {
  name: "file.find",
  summary: "Find files by name (exact / substring / glob / regex).",
  requiresWrite: false,
  schema: {
    type: "object",
    properties: {
      vault: { type: "string" },
      query: { type: "string" },
      mode: { type: "string", enum: ["exact", "substring", "glob", "regex"] },
      directory: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 10000 },
      offset: { type: "integer", minimum: 0 },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const query = reqString(args, "query");
    const mode = getEnum(args, "mode", ["exact", "substring", "glob", "regex"] as const, {
      optional: true,
      default: "substring",
    })!;
    const directory = getString(args, "directory", { optional: true });
    const limit = getInt(args, "limit", { optional: true, min: 1, max: 10000 }) ?? 200;
    const offset = getInt(args, "offset", { optional: true, min: 0 }) ?? 0;
    const rootAbs = directory ? resolvePath(ctx, directory) : ctx.vault.root;
    let matcher: (p: string) => boolean;
    if (mode === "exact") matcher = (p) => path.basename(p) === query;
    else if (mode === "substring") matcher = (p) => path.basename(p).includes(query);
    else if (mode === "glob") matcher = picomatch(query);
    else {
      let re: RegExp;
      try {
        re = new RegExp(query);
      } catch (e) {
        throw new ToolFailure("INVALID_ARGS", `invalid regex: ${(e as Error).message}`);
      }
      matcher = (p) => re.test(p);
    }
    const matches: Array<{ path: string; why: string }> = [];
    let count = 0;
    for await (const e of walk(rootAbs, { maxDepth: Infinity })) {
      if (e.type !== "file") continue;
      if (!matcher(e.relPath)) continue;
      count++;
      if (count <= offset) continue;
      if (matches.length >= limit) continue;
      matches.push({ path: e.relPath, why: mode });
    }
    return {
      matches,
      total: count,
      nextOffset: offset + matches.length < count ? offset + matches.length : undefined,
    };
  },
};

// ---------------------------------------------------------------------------
// file.read
// ---------------------------------------------------------------------------

export const fileReadTool: ToolDefinition = {
  name: "file.read",
  summary:
    "Read a file's full content. Returns content + content_hash + totalLines so subsequent surgical edits can use the hash as a precondition.",
  requiresWrite: false,
  schema: {
    type: "object",
    properties: {
      vault: { type: "string" },
      file: { type: "string" },
    },
    required: ["file"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const file = reqString(args, "file");
    const abs = resolvePath(ctx, file);
    if (!(await fileExists(abs))) {
      throw new ToolFailure("NOT_FOUND", `file not found: ${file}`);
    }
    // Markdown files go through the parser; non-markdown are returned raw.
    if (file.toLowerCase().endsWith(".md")) {
      const parsed = await loadFile(ctx, file);
      return {
        file,
        content: parsed.text,
        contentHash: parsed.contentHash,
        totalLines: parsed.totalLines,
        frontmatter: parsed.frontmatter
          ? { data: parsed.frontmatter.data, frontmatterHash: parsed.frontmatter.frontmatterHash }
          : undefined,
      };
    }
    const raw = await readText(abs);
    const { sha256, canonicalise, countLines } = await import("../markdown/fingerprint.js");
    const canon = canonicalise(raw);
    return {
      file,
      content: canon,
      contentHash: sha256(canon),
      totalLines: countLines(canon),
    };
  },
};

// ---------------------------------------------------------------------------
// file.read_range
// ---------------------------------------------------------------------------

export const fileReadRangeTool: ToolDefinition = {
  name: "file.read_range",
  summary:
    "Read a line range from a file (1-based, inclusive). Returns the slice + rangeHash + contentHash for surgical follow-ups.",
  requiresWrite: false,
  schema: {
    type: "object",
    properties: {
      vault: { type: "string" },
      file: { type: "string" },
      from: { type: "integer", minimum: 1 },
      to: { type: "integer", minimum: 1 },
    },
    required: ["file", "from", "to"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const file = reqString(args, "file");
    const from = getInt(args, "from", { min: 1 })!;
    const to = getInt(args, "to", { min: from })!;
    const parsed = await loadFile(ctx, file);
    const lines = sliceLines(parsed.text, parsed.lineOffsets, from, to);
    const rh = rangeHash(parsed.text, parsed.lineOffsets, from, to);
    return {
      file,
      from,
      to: Math.min(to, parsed.totalLines),
      lines,
      rangeHash: rh,
      contentHash: parsed.contentHash,
      totalLines: parsed.totalLines,
    };
  },
};

// ---------------------------------------------------------------------------
// outline
// ---------------------------------------------------------------------------

export const outlineTool: ToolDefinition = {
  name: "outline",
  summary:
    "Return the heading tree of a markdown file. Each entry includes path, level, line, end_line, section_hash, children_count, and (when applicable) duplicate_of[]. Use this to navigate large notes without reading them.",
  requiresWrite: false,
  schema: {
    type: "object",
    properties: {
      vault: { type: "string" },
      file: { type: "string" },
      maxDepth: { type: "integer", minimum: 1, maximum: 6 },
    },
    required: ["file"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const file = reqString(args, "file");
    const maxDepth = getInt(args, "maxDepth", { optional: true, min: 1, max: 6 });
    const parsed = await loadFile(ctx, file);
    const outline = buildOutline(parsed.headings, maxDepth);
    return {
      file,
      contentHash: parsed.contentHash,
      totalLines: parsed.totalLines,
      headings: outline.headings,
    };
  },
};

// ---------------------------------------------------------------------------
// heading.find
// ---------------------------------------------------------------------------

export const headingFindTool: ToolDefinition = {
  name: "heading.find",
  summary:
    "Find headings by leaf text OR by full Parent::Child::Leaf path. Returns ALL matches; surgical-edit tools require disambiguation when count > 1.",
  requiresWrite: false,
  schema: {
    type: "object",
    properties: {
      vault: { type: "string" },
      file: { type: "string" },
      heading: { type: "string" },
      delimiter: { type: "string" },
    },
    required: ["file", "heading"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const file = reqString(args, "file");
    const heading = reqString(args, "heading");
    const delimiter = getString(args, "delimiter", { optional: true }) ?? "::";
    const parsed = await loadFile(ctx, file);
    const matches = findHeadings(parsed.headings, heading, delimiter);
    return { matches, contentHash: parsed.contentHash };
  },
};

// ---------------------------------------------------------------------------
// block.find
// ---------------------------------------------------------------------------

export const blockFindTool: ToolDefinition = {
  name: "block.find",
  summary:
    "Find a block-reference (^id) in a file. Returns line/structuralType/blockHash so block.replace can be called with the precondition.",
  requiresWrite: false,
  schema: {
    type: "object",
    properties: {
      vault: { type: "string" },
      file: { type: "string" },
      blockId: { type: "string" },
    },
    required: ["file", "blockId"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const file = reqString(args, "file");
    const blockId = reqString(args, "blockId");
    const parsed = await loadFile(ctx, file);
    const matches = findBlocks(parsed.blocks, blockId);
    return { matches, contentHash: parsed.contentHash };
  },
};

// ---------------------------------------------------------------------------
// frontmatter.get
// ---------------------------------------------------------------------------

export const frontmatterGetTool: ToolDefinition = {
  name: "frontmatter.get",
  summary: "Read the frontmatter (or a nested key via dot-notation) from a markdown file.",
  requiresWrite: false,
  schema: {
    type: "object",
    properties: {
      vault: { type: "string" },
      file: { type: "string" },
      keyPath: { type: "string", description: "Dot-notated key path, e.g. 'status.priority'" },
    },
    required: ["file"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const file = reqString(args, "file");
    const keyPath = getString(args, "keyPath", { optional: true });
    const parsed = await loadFile(ctx, file);
    if (!parsed.frontmatter) {
      return { data: undefined, frontmatterHash: undefined, contentHash: parsed.contentHash };
    }
    let data: unknown = parsed.frontmatter.data;
    if (keyPath) {
      const segs = keyPath.split(".");
      for (const s of segs) {
        if (data === null || typeof data !== "object") {
          data = undefined;
          break;
        }
        data = (data as Record<string, unknown>)[s];
      }
    }
    return {
      data,
      frontmatterHash: parsed.frontmatter.frontmatterHash,
      contentHash: parsed.contentHash,
    };
  },
};

// ---------------------------------------------------------------------------
// tags.list
// ---------------------------------------------------------------------------

export const tagsListTool: ToolDefinition = {
  name: "tags.list",
  summary:
    "List tags found in a single file (when 'file' is supplied) or aggregated across the vault.",
  requiresWrite: false,
  schema: {
    type: "object",
    properties: {
      vault: { type: "string" },
      file: { type: "string" },
      prefix: { type: "string" },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const file = getString(args, "file", { optional: true });
    const prefix = getString(args, "prefix", { optional: true });
    if (file) {
      const parsed = await loadFile(ctx, file);
      const tags = (prefix ? parsed.tags.filter((t) => t.startsWith(prefix)) : parsed.tags).map(
        (t) => ({ tag: t, count: 1 }),
      );
      return { tags };
    }
    const counts = new Map<string, number>();
    for await (const e of walk(ctx.vault.root, { extensions: ["md"] })) {
      if (e.type !== "file") continue;
      try {
        const parsed = await ctx.cache.get(ctx.vault.root, e.absPath);
        for (const t of parsed.tags) {
          if (prefix && !t.startsWith(prefix)) continue;
          counts.set(t, (counts.get(t) ?? 0) + 1);
        }
      } catch {
        /* skip unreadable */
      }
    }
    const tags = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([tag, count]) => ({ tag, count }));
    return { tags };
  },
};

// ---------------------------------------------------------------------------
// links.get
// ---------------------------------------------------------------------------

export const linksGetTool: ToolDefinition = {
  name: "links.get",
  summary:
    "Return outlinks (from the given file) and/or backlinks (vault-wide search for refs targeting the file's basename).",
  requiresWrite: false,
  schema: {
    type: "object",
    properties: {
      vault: { type: "string" },
      file: { type: "string" },
      direction: { type: "string", enum: ["outlinks", "backlinks", "both"] },
    },
    required: ["file"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const file = reqString(args, "file");
    const direction = getEnum(args, "direction", ["outlinks", "backlinks", "both"] as const, {
      optional: true,
      default: "both",
    })!;
    const parsed = await loadFile(ctx, file);
    const baseName = path.basename(file, path.extname(file));
    const outlinks = parsed.links;
    const backlinks: Array<{ file: string; line: number; kind: string }> = [];
    if (direction === "backlinks" || direction === "both") {
      for await (const e of walk(ctx.vault.root, { extensions: ["md"] })) {
        if (e.type !== "file") continue;
        if (e.absPath === parsed.absPath) continue;
        try {
          const other = await ctx.cache.get(ctx.vault.root, e.absPath);
          for (const l of other.links) {
            const target = "target" in l ? l.target : undefined;
            if (
              target &&
              (target === baseName || target === file || target.endsWith(`/${baseName}`))
            ) {
              backlinks.push({ file: other.path, line: l.line, kind: l.kind });
            }
          }
        } catch {
          /* skip */
        }
      }
    }
    return {
      outlinks: direction === "backlinks" ? [] : outlinks,
      backlinks: direction === "outlinks" ? [] : backlinks,
      contentHash: parsed.contentHash,
    };
  },
};

// ---------------------------------------------------------------------------
// metadata.read
// ---------------------------------------------------------------------------

export const metadataReadTool: ToolDefinition = {
  name: "metadata.read",
  summary:
    "Read structural metadata for a file: frontmatter, headings, tags, link counts, total lines, content_hash.",
  requiresWrite: false,
  schema: {
    type: "object",
    properties: {
      vault: { type: "string" },
      file: { type: "string" },
    },
    required: ["file"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const file = reqString(args, "file");
    const parsed = await loadFile(ctx, file);
    return {
      file,
      contentHash: parsed.contentHash,
      totalLines: parsed.totalLines,
      frontmatter: parsed.frontmatter
        ? { data: parsed.frontmatter.data, frontmatterHash: parsed.frontmatter.frontmatterHash }
        : undefined,
      headings: parsed.headings.map((h) => ({
        path: h.path,
        level: h.level,
        line: h.line,
        endLine: h.endLine,
        sectionHash: h.sectionHash,
      })),
      tags: parsed.tags,
      linkCounts: parsed.links.reduce<Record<string, number>>((acc, l) => {
        acc[l.kind] = (acc[l.kind] ?? 0) + 1;
        return acc;
      }, {}),
    };
  },
};

// ---------------------------------------------------------------------------
// search.content
// ---------------------------------------------------------------------------

export const searchContentTool: ToolDefinition = {
  name: "search.content",
  summary:
    "Substring search across markdown files. Returns hits with surrounding context and per-line hashes (each hit can be surgically rewritten with str_replace).",
  requiresWrite: false,
  schema: {
    type: "object",
    properties: {
      vault: { type: "string" },
      query: { type: "string" },
      directory: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 1000 },
      offset: { type: "integer", minimum: 0 },
      contextLines: { type: "integer", minimum: 0, maximum: 20 },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const query = reqString(args, "query");
    const directory = getString(args, "directory", { optional: true });
    const limit = getInt(args, "limit", { optional: true, min: 1, max: 1000 }) ?? 100;
    const offset = getInt(args, "offset", { optional: true, min: 0 }) ?? 0;
    const contextLines = getInt(args, "contextLines", { optional: true, min: 0, max: 20 }) ?? 2;
    const rootAbs = directory ? resolvePath(ctx, directory) : ctx.vault.root;
    const hits: Array<Record<string, unknown>> = [];
    let count = 0;
    for await (const e of walk(rootAbs, { extensions: ["md"] })) {
      if (e.type !== "file") continue;
      let parsed;
      try {
        parsed = await ctx.cache.get(ctx.vault.root, e.absPath);
      } catch {
        continue;
      }
      const text = parsed.text;
      const lineStarts = parsed.lineOffsets;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes(query)) continue;
        count++;
        if (count <= offset) continue;
        if (hits.length >= limit) continue;
        const lineNum = i + 1;
        const lh = rangeHash(text, lineStarts, lineNum, lineNum);
        const before = lines.slice(Math.max(0, i - contextLines), i);
        const after = lines.slice(i + 1, Math.min(lines.length, i + 1 + contextLines));
        hits.push({
          file: parsed.path,
          line: lineNum,
          lineHash: lh,
          snippet: lines[i],
          before,
          after,
          contentHash: parsed.contentHash,
        });
      }
    }
    return {
      hits,
      total: count,
      nextOffset: offset + hits.length < count ? offset + hits.length : undefined,
    };
  },
};

// ---------------------------------------------------------------------------
// file.diff
// ---------------------------------------------------------------------------

export const fileDiffTool: ToolDefinition = {
  name: "file.diff",
  summary:
    "(planned) Diff a file against a prior content_hash. Stubbed for v1.0 — requires history cache; returns NOT_FOUND until enabled.",
  requiresWrite: false,
  schema: {
    type: "object",
    properties: {
      vault: { type: "string" },
      file: { type: "string" },
      fromHash: { type: "string" },
      toHash: { type: "string" },
    },
    required: ["file", "fromHash"],
    additionalProperties: false,
  },
  async handler(_args, _ctx) {
    throw new ToolFailure("NOT_FOUND", "file.diff history is not yet retained; coming in 1.1");
  },
};

// ---------------------------------------------------------------------------
// Aggregate export
// ---------------------------------------------------------------------------

export const READ_TOOLS: ToolDefinition[] = [
  vaultListTool,
  vaultInfoTool,
  fileListTool,
  fileFindTool,
  fileReadTool,
  fileReadRangeTool,
  outlineTool,
  headingFindTool,
  blockFindTool,
  frontmatterGetTool,
  tagsListTool,
  linksGetTool,
  metadataReadTool,
  searchContentTool,
  fileDiffTool,
];
