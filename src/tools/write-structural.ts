/**
 * Structural write tools:
 *   heading.replace_body, heading.rename, block.replace, block.rename,
 *   frontmatter.set, frontmatter.delete
 *
 * These all consume a precondition hash returned by the corresponding `find` /
 * `outline` / `frontmatter.get` read tool, making the LLM round-trip extremely
 * cheap.
 */

import { ToolFailure } from "../utils/types.js";
import type { ToolDefinition } from "../handlers/registry.js";
import { reqString, getString, getBool } from "../handlers/args.js";
import { loadFile, persist, assertHash, requireHash } from "./common.js";
import { findHeadings } from "../markdown/headings.js";
import { findBlocks } from "../markdown/blocks.js";
import { setFrontmatterKey, deleteFrontmatterKey } from "../markdown/frontmatter.js";
import { rangeHash } from "../markdown/fingerprint.js";
import { AuditLog } from "../audit/log.js";

function ensureSingleHeading(matches: ReturnType<typeof findHeadings>, query: string) {
  if (matches.length === 0) {
    throw new ToolFailure("NOT_FOUND", `no heading matches: ${query}`);
  }
  if (matches.length > 1) {
    throw new ToolFailure(
      "DUPLICATE_TARGET",
      `${matches.length} headings match "${query}"; disambiguate using full Parent::Child::Leaf path`,
      { matches: matches.map((h) => ({ id: h.id, path: h.path, line: h.line, level: h.level })) },
    );
  }
  return matches[0];
}

// ---------------------------------------------------------------------------
// heading.replace_body
// ---------------------------------------------------------------------------

export const headingReplaceBodyTool: ToolDefinition = {
  name: "heading.replace_body",
  summary:
    "Replace the BODY beneath a heading (not the heading line itself). Errors if heading missing or path is ambiguous. Requires expected_section_hash from heading.find/outline.",
  requiresWrite: true,
  schema: {
    type: "object",
    properties: {
      vault: { type: "string" },
      file: { type: "string" },
      heading: { type: "string" },
      content: { type: "string" },
      expected_section_hash: { type: "string" },
      delimiter: { type: "string" },
      dry_run: { type: "boolean" },
    },
    required: ["file", "heading", "content", "expected_section_hash"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const file = reqString(args, "file");
    const heading = reqString(args, "heading");
    const content = reqString(args, "content");
    const expected = reqString(args, "expected_section_hash");
    const delimiter = getString(args, "delimiter", { optional: true }) ?? "::";
    const dry = getBool(args, "dry_run", { optional: true, default: false })!;
    const parsed = await loadFile(ctx, file);
    const matches = findHeadings(parsed.headings, heading, delimiter);
    const target = ensureSingleHeading(matches, heading);
    assertHash(expected, target.sectionHash, "expected_section_hash");
    // The "body" is target.line+1 .. target.endLine (the heading line itself stays).
    const bodyStart = target.line + 1;
    const bodyEnd = target.endLine;
    let newText: string;
    if (bodyStart > bodyEnd) {
      // No existing body; insert right after the heading line.
      const insertAt = parsed.lineOffsets[target.line];
      let body = content.replace(/\r\n?/g, "\n");
      if (!body.endsWith("\n")) body += "\n";
      newText = parsed.text.slice(0, insertAt) + body + parsed.text.slice(insertAt);
    } else {
      const start = parsed.lineOffsets[bodyStart - 1];
      const end = parsed.lineOffsets[bodyEnd];
      const original = parsed.text.slice(start, end);
      const endedWithNewline = original.endsWith("\n");
      let body = content.replace(/\r\n?/g, "\n");
      if (endedWithNewline && !body.endsWith("\n")) body += "\n";
      newText = parsed.text.slice(0, start) + body + parsed.text.slice(end);
    }
    const argsHash = AuditLog.hashArgs(args);
    const out = await persist(ctx, parsed.absPath, newText, {
      tool: "heading.replace_body",
      file,
      args_hash: argsHash,
      before_hash: parsed.contentHash,
      dry_run: dry,
    });
    return {
      file,
      changed: true,
      contentHash: out.contentHash,
      totalLines: out.totalLines,
      headingLine: target.line,
      dry_run: dry,
    };
  },
};

// ---------------------------------------------------------------------------
// heading.rename
// ---------------------------------------------------------------------------

export const headingRenameTool: ToolDefinition = {
  name: "heading.rename",
  summary:
    "Rename a heading's text in place. Errors on missing/duplicate. Preserves heading level. Does NOT update backlinks (use bulk.apply for that).",
  requiresWrite: true,
  schema: {
    type: "object",
    properties: {
      vault: { type: "string" },
      file: { type: "string" },
      heading: { type: "string" },
      newText: { type: "string" },
      expected_section_hash: { type: "string" },
      delimiter: { type: "string" },
      dry_run: { type: "boolean" },
    },
    required: ["file", "heading", "newText", "expected_section_hash"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const file = reqString(args, "file");
    const heading = reqString(args, "heading");
    const newText = reqString(args, "newText");
    const expected = reqString(args, "expected_section_hash");
    const delimiter = getString(args, "delimiter", { optional: true }) ?? "::";
    const dry = getBool(args, "dry_run", { optional: true, default: false })!;
    const parsed = await loadFile(ctx, file);
    const matches = findHeadings(parsed.headings, heading, delimiter);
    const target = ensureSingleHeading(matches, heading);
    assertHash(expected, target.sectionHash, "expected_section_hash");
    const headingLineStart = parsed.lineOffsets[target.line - 1];
    const headingLineEnd = parsed.lineOffsets[target.line];
    const headingLine = parsed.text.slice(headingLineStart, headingLineEnd);
    const m = /^(\s*#{1,6}\s+)([^\n]*?)(\s*)$/.exec(headingLine.replace(/\n$/, ""));
    if (!m) {
      throw new ToolFailure("PARSE_ERROR", `cannot recognise heading line at ${target.line}`);
    }
    const prefix = m[1];
    const trailing = m[3];
    const rebuilt = `${prefix}${newText}${trailing}` + (headingLine.endsWith("\n") ? "\n" : "");
    const newFileText =
      parsed.text.slice(0, headingLineStart) + rebuilt + parsed.text.slice(headingLineEnd);
    const argsHash = AuditLog.hashArgs(args);
    const out = await persist(ctx, parsed.absPath, newFileText, {
      tool: "heading.rename",
      file,
      args_hash: argsHash,
      before_hash: parsed.contentHash,
      dry_run: dry,
    });
    return {
      file,
      changed: true,
      contentHash: out.contentHash,
      totalLines: out.totalLines,
      dry_run: dry,
    };
  },
};

// ---------------------------------------------------------------------------
// block.replace
// ---------------------------------------------------------------------------

export const blockReplaceTool: ToolDefinition = {
  name: "block.replace",
  summary:
    "Replace the structural block referenced by ^id (paragraph/list-item/table-row/etc.) preserving the ^id marker. Requires expected_block_hash from block.find.",
  requiresWrite: true,
  schema: {
    type: "object",
    properties: {
      vault: { type: "string" },
      file: { type: "string" },
      blockId: { type: "string" },
      content: { type: "string" },
      expected_block_hash: { type: "string" },
      dry_run: { type: "boolean" },
    },
    required: ["file", "blockId", "content", "expected_block_hash"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const file = reqString(args, "file");
    const blockId = reqString(args, "blockId");
    const content = reqString(args, "content");
    const expected = reqString(args, "expected_block_hash");
    const dry = getBool(args, "dry_run", { optional: true, default: false })!;
    const parsed = await loadFile(ctx, file);
    const matches = findBlocks(parsed.blocks, blockId);
    if (matches.length === 0) throw new ToolFailure("NOT_FOUND", `no block ${blockId}`);
    if (matches.length > 1) {
      throw new ToolFailure("DUPLICATE_TARGET", `${matches.length} blocks match ${blockId}`, {
        matches: matches.map((b) => ({ line: b.line, startLine: b.startLine, endLine: b.endLine })),
      });
    }
    const target = matches[0];
    assertHash(expected, target.blockHash, "expected_block_hash");
    const start = parsed.lineOffsets[target.startLine - 1];
    const end = parsed.lineOffsets[target.endLine];
    const original = parsed.text.slice(start, end);
    const endedWithNewline = original.endsWith("\n");
    const body = content.replace(/\r\n?/g, "\n");
    // Append the ^id marker preserving structure
    const normalisedId = target.id; // already "^foo"
    const stripped = body.replace(/\s+\^[A-Za-z0-9-_]+\s*$/, "");
    let withMarker = stripped + (stripped.endsWith("\n") ? "" : " ") + normalisedId;
    if (endedWithNewline && !withMarker.endsWith("\n")) withMarker += "\n";
    const newText = parsed.text.slice(0, start) + withMarker + parsed.text.slice(end);
    const argsHash = AuditLog.hashArgs(args);
    const out = await persist(ctx, parsed.absPath, newText, {
      tool: "block.replace",
      file,
      args_hash: argsHash,
      before_hash: parsed.contentHash,
      dry_run: dry,
    });
    return {
      file,
      changed: true,
      contentHash: out.contentHash,
      totalLines: out.totalLines,
      dry_run: dry,
    };
  },
};

// ---------------------------------------------------------------------------
// block.rename
// ---------------------------------------------------------------------------

export const blockRenameTool: ToolDefinition = {
  name: "block.rename",
  summary: "Rename a block reference (^old → ^new) on the same line, preserving line content.",
  requiresWrite: true,
  schema: {
    type: "object",
    properties: {
      vault: { type: "string" },
      file: { type: "string" },
      blockId: { type: "string" },
      newId: { type: "string" },
      expected_block_hash: { type: "string" },
      dry_run: { type: "boolean" },
    },
    required: ["file", "blockId", "newId", "expected_block_hash"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const file = reqString(args, "file");
    const blockId = reqString(args, "blockId");
    const newId = reqString(args, "newId");
    if (!/^[A-Za-z0-9-_]+$/.test(newId.replace(/^\^/, ""))) {
      throw new ToolFailure("INVALID_ARGS", "newId must match [A-Za-z0-9-_]+");
    }
    const expected = reqString(args, "expected_block_hash");
    const dry = getBool(args, "dry_run", { optional: true, default: false })!;
    const parsed = await loadFile(ctx, file);
    const matches = findBlocks(parsed.blocks, blockId);
    if (matches.length === 0) throw new ToolFailure("NOT_FOUND", `no block ${blockId}`);
    if (matches.length > 1) {
      throw new ToolFailure("DUPLICATE_TARGET", `${matches.length} blocks match ${blockId}`);
    }
    const target = matches[0];
    assertHash(expected, target.blockHash, "expected_block_hash");
    const newMarker = newId.startsWith("^") ? newId : `^${newId}`;
    const markerLineStart = parsed.lineOffsets[target.line - 1];
    const markerLineEnd = parsed.lineOffsets[target.line];
    const lineText = parsed.text.slice(markerLineStart, markerLineEnd);
    const replaced = lineText.replace(/\^[A-Za-z0-9-_]+(\s*\r?\n?)$/, `${newMarker}$1`);
    if (replaced === lineText) {
      throw new ToolFailure("PARSE_ERROR", `could not locate ^${blockId} on line ${target.line}`);
    }
    const newText =
      parsed.text.slice(0, markerLineStart) + replaced + parsed.text.slice(markerLineEnd);
    const argsHash = AuditLog.hashArgs(args);
    const out = await persist(ctx, parsed.absPath, newText, {
      tool: "block.rename",
      file,
      args_hash: argsHash,
      before_hash: parsed.contentHash,
      dry_run: dry,
    });
    return {
      file,
      changed: true,
      contentHash: out.contentHash,
      totalLines: out.totalLines,
      dry_run: dry,
    };
  },
};

// ---------------------------------------------------------------------------
// frontmatter.set
// ---------------------------------------------------------------------------

export const frontmatterSetTool: ToolDefinition = {
  name: "frontmatter.set",
  summary:
    "Set a (possibly nested via dot-notation) key in the file's frontmatter. Creates the frontmatter block if absent. Requires expected_frontmatter_hash unless file has no frontmatter yet.",
  requiresWrite: true,
  schema: {
    type: "object",
    properties: {
      vault: { type: "string" },
      file: { type: "string" },
      keyPath: { type: "string" },
      value: {},
      expected_frontmatter_hash: { type: "string" },
      dry_run: { type: "boolean" },
    },
    required: ["file", "keyPath", "value"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const file = reqString(args, "file");
    const keyPath = reqString(args, "keyPath");
    const value = args.value;
    const expected = getString(args, "expected_frontmatter_hash", { optional: true });
    const dry = getBool(args, "dry_run", { optional: true, default: false })!;
    const parsed = await loadFile(ctx, file);
    if (parsed.frontmatter) {
      requireHash(expected, parsed.frontmatter.frontmatterHash, "expected_frontmatter_hash");
    }
    const newText = setFrontmatterKey(parsed.text, keyPath, value);
    const argsHash = AuditLog.hashArgs(args);
    const out = await persist(ctx, parsed.absPath, newText, {
      tool: "frontmatter.set",
      file,
      args_hash: argsHash,
      before_hash: parsed.contentHash,
      dry_run: dry,
    });
    return {
      file,
      changed: true,
      contentHash: out.contentHash,
      frontmatterHash: out.frontmatter?.frontmatterHash,
      totalLines: out.totalLines,
      dry_run: dry,
    };
  },
};

// ---------------------------------------------------------------------------
// frontmatter.delete
// ---------------------------------------------------------------------------

export const frontmatterDeleteTool: ToolDefinition = {
  name: "frontmatter.delete",
  summary:
    "Delete a (possibly nested) key from the file's frontmatter. No-op if key absent. Requires expected_frontmatter_hash when frontmatter exists.",
  requiresWrite: true,
  schema: {
    type: "object",
    properties: {
      vault: { type: "string" },
      file: { type: "string" },
      keyPath: { type: "string" },
      expected_frontmatter_hash: { type: "string" },
      dry_run: { type: "boolean" },
    },
    required: ["file", "keyPath"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const file = reqString(args, "file");
    const keyPath = reqString(args, "keyPath");
    const expected = getString(args, "expected_frontmatter_hash", { optional: true });
    const dry = getBool(args, "dry_run", { optional: true, default: false })!;
    const parsed = await loadFile(ctx, file);
    if (parsed.frontmatter) {
      requireHash(expected, parsed.frontmatter.frontmatterHash, "expected_frontmatter_hash");
    }
    const { text: newText, changed } = deleteFrontmatterKey(parsed.text, keyPath);
    if (!changed) {
      return { file, changed: false, contentHash: parsed.contentHash, dry_run: dry };
    }
    const argsHash = AuditLog.hashArgs(args);
    const out = await persist(ctx, parsed.absPath, newText, {
      tool: "frontmatter.delete",
      file,
      args_hash: argsHash,
      before_hash: parsed.contentHash,
      dry_run: dry,
    });
    return {
      file,
      changed: true,
      contentHash: out.contentHash,
      frontmatterHash: out.frontmatter?.frontmatterHash,
      totalLines: out.totalLines,
      dry_run: dry,
    };
  },
};

void rangeHash;
