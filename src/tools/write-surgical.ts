/**
 * Surgical write tools:
 *   str_replace, apply_edits, lines.replace, lines.insert
 *
 * These are the cheapest, most LLM-context-efficient ways to edit files.
 */

import { ToolFailure } from "../utils/types.js";
import type { ToolDefinition } from "../handlers/registry.js";
import { reqString, getString, getInt, getBool, getArray } from "../handlers/args.js";
import { loadFile, persist, assertHash } from "./common.js";
import { rangeHash, sliceLines } from "../markdown/fingerprint.js";
import { AuditLog } from "../audit/log.js";

interface SingleEdit {
  find: string;
  replace: string;
  occurrence?: "unique" | "all" | number;
}

function applySingleEdit(text: string, edit: SingleEdit): { text: string; replacedCount: number } {
  const occ = edit.occurrence ?? "unique";
  if (edit.find.length === 0) {
    throw new ToolFailure("INVALID_ARGS", "edit.find must be non-empty");
  }
  // Find all match positions
  const positions: number[] = [];
  let idx = 0;
  while ((idx = text.indexOf(edit.find, idx)) !== -1) {
    positions.push(idx);
    idx += edit.find.length;
  }
  if (positions.length === 0) {
    throw new ToolFailure("NOT_FOUND", `find string not present in file`, {
      findPreview: edit.find.slice(0, 80),
    });
  }
  if (occ === "unique") {
    if (positions.length > 1) {
      throw new ToolFailure(
        "DUPLICATE_TARGET",
        `find string appears ${positions.length} times; specify occurrence (1..${positions.length}) or "all"`,
        { occurrences: positions.length },
      );
    }
    return spliceAt(text, positions[0], edit.find.length, edit.replace, 1);
  }
  if (occ === "all") {
    let out = "";
    let cursor = 0;
    for (const p of positions) {
      out += text.slice(cursor, p) + edit.replace;
      cursor = p + edit.find.length;
    }
    out += text.slice(cursor);
    return { text: out, replacedCount: positions.length };
  }
  if (typeof occ === "number" && Number.isInteger(occ) && occ >= 1 && occ <= positions.length) {
    return spliceAt(text, positions[occ - 1], edit.find.length, edit.replace, 1);
  }
  throw new ToolFailure(
    "INVALID_ARGS",
    `edit.occurrence must be "unique", "all", or 1..${positions.length}`,
  );
}

function spliceAt(text: string, start: number, len: number, replacement: string, count: number) {
  return {
    text: text.slice(0, start) + replacement + text.slice(start + len),
    replacedCount: count,
  };
}

// ---------------------------------------------------------------------------
// str_replace
// ---------------------------------------------------------------------------

export const strReplaceTool: ToolDefinition = {
  name: "str_replace",
  summary:
    "Surgical edit: replace a literal substring in a file. Default occurrence='unique' (errors on >1 match). Tiny payload in/out; preferred over file.replace for any edit smaller than the whole file.",
  requiresWrite: true,
  schema: {
    type: "object",
    properties: {
      vault: { type: "string" },
      file: { type: "string" },
      find: { type: "string" },
      replace: { type: "string" },
      occurrence: {},
      expected_content_hash: { type: "string" },
      dry_run: { type: "boolean" },
    },
    required: ["file", "find", "replace"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const file = reqString(args, "file");
    const find = reqString(args, "find");
    const replace = reqString(args, "replace");
    const occRaw = args.occurrence;
    let occurrence: SingleEdit["occurrence"] = "unique";
    if (occRaw !== undefined) {
      if (occRaw === "unique" || occRaw === "all") occurrence = occRaw;
      else if (typeof occRaw === "number" && Number.isInteger(occRaw) && occRaw >= 1)
        occurrence = occRaw;
      else
        throw new ToolFailure(
          "INVALID_ARGS",
          `occurrence must be "unique", "all", or a positive integer`,
        );
    }
    const expectedHash = getString(args, "expected_content_hash", { optional: true });
    const dry = getBool(args, "dry_run", { optional: true, default: false })!;
    const parsed = await loadFile(ctx, file);
    assertHash(expectedHash, parsed.contentHash, "expected_content_hash");
    const { text: newText, replacedCount } = applySingleEdit(parsed.text, {
      find,
      replace,
      occurrence,
    });
    if (newText === parsed.text) {
      return {
        file,
        changed: false,
        replacedCount: 0,
        contentHash: parsed.contentHash,
        dry_run: dry,
      };
    }
    const argsHash = AuditLog.hashArgs(args);
    const out = await persist(ctx, parsed.absPath, newText, {
      tool: "str_replace",
      file,
      args_hash: argsHash,
      before_hash: parsed.contentHash,
      dry_run: dry,
    });
    return {
      file,
      changed: true,
      replacedCount,
      contentHash: out.contentHash,
      totalLines: out.totalLines,
      dry_run: dry,
    };
  },
};

// ---------------------------------------------------------------------------
// apply_edits
// ---------------------------------------------------------------------------

export const applyEditsTool: ToolDefinition = {
  name: "apply_edits",
  summary:
    "Apply a batch of str_replace edits to a single file in one round-trip. Edits applied in order against the running in-memory text; atomic (rolled back in memory if any edit fails).",
  requiresWrite: true,
  schema: {
    type: "object",
    properties: {
      vault: { type: "string" },
      file: { type: "string" },
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            find: { type: "string" },
            replace: { type: "string" },
            occurrence: {},
          },
          required: ["find", "replace"],
        },
      },
      expected_content_hash: { type: "string" },
      dry_run: { type: "boolean" },
    },
    required: ["file", "edits"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const file = reqString(args, "file");
    const editsRaw = getArray<Record<string, unknown>>(args, "edits")!;
    if (editsRaw.length === 0) throw new ToolFailure("INVALID_ARGS", "edits must be non-empty");
    const expectedHash = getString(args, "expected_content_hash", { optional: true });
    const dry = getBool(args, "dry_run", { optional: true, default: false })!;
    const parsed = await loadFile(ctx, file);
    assertHash(expectedHash, parsed.contentHash, "expected_content_hash");
    let cur = parsed.text;
    const perEdit: Array<{ replacedCount: number }> = [];
    for (let i = 0; i < editsRaw.length; i++) {
      const e = editsRaw[i];
      const find = typeof e.find === "string" ? e.find : "";
      const replace = typeof e.replace === "string" ? e.replace : "";
      if (!find)
        throw new ToolFailure("INVALID_ARGS", `edits[${i}].find must be a non-empty string`);
      const occRaw = e.occurrence;
      let occurrence: SingleEdit["occurrence"] = "unique";
      if (occRaw !== undefined) {
        if (occRaw === "unique" || occRaw === "all") occurrence = occRaw;
        else if (typeof occRaw === "number" && Number.isInteger(occRaw) && occRaw >= 1)
          occurrence = occRaw;
        else throw new ToolFailure("INVALID_ARGS", `edits[${i}].occurrence invalid`);
      }
      try {
        const r = applySingleEdit(cur, { find, replace, occurrence });
        cur = r.text;
        perEdit.push({ replacedCount: r.replacedCount });
      } catch (err) {
        if (err instanceof ToolFailure) {
          throw new ToolFailure(err.code, `edits[${i}] failed: ${err.message}`, {
            index: i,
            ...err.details,
          });
        }
        throw err;
      }
    }
    if (cur === parsed.text) {
      return {
        file,
        changed: false,
        edits: perEdit,
        contentHash: parsed.contentHash,
        dry_run: dry,
      };
    }
    const argsHash = AuditLog.hashArgs(args);
    const out = await persist(ctx, parsed.absPath, cur, {
      tool: "apply_edits",
      file,
      args_hash: argsHash,
      before_hash: parsed.contentHash,
      dry_run: dry,
    });
    return {
      file,
      changed: true,
      edits: perEdit,
      contentHash: out.contentHash,
      totalLines: out.totalLines,
      dry_run: dry,
    };
  },
};

// ---------------------------------------------------------------------------
// lines.replace
// ---------------------------------------------------------------------------

export const linesReplaceTool: ToolDefinition = {
  name: "lines.replace",
  summary:
    "Replace a contiguous line range (1-based, inclusive). Requires expected_range_hash returned by file.read_range or outline (section_hash).",
  requiresWrite: true,
  schema: {
    type: "object",
    properties: {
      vault: { type: "string" },
      file: { type: "string" },
      from: { type: "integer", minimum: 1 },
      to: { type: "integer", minimum: 1 },
      content: { type: "string" },
      expected_range_hash: { type: "string" },
      dry_run: { type: "boolean" },
    },
    required: ["file", "from", "to", "content", "expected_range_hash"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const file = reqString(args, "file");
    const from = getInt(args, "from", { min: 1 })!;
    const to = getInt(args, "to", { min: from })!;
    const content = reqString(args, "content");
    const expected = reqString(args, "expected_range_hash");
    const dry = getBool(args, "dry_run", { optional: true, default: false })!;
    const parsed = await loadFile(ctx, file);
    if (from > parsed.totalLines) {
      throw new ToolFailure("INVALID_ARGS", `from (${from}) > totalLines (${parsed.totalLines})`);
    }
    const clampedTo = Math.min(to, parsed.totalLines);
    const actual = rangeHash(parsed.text, parsed.lineOffsets, from, clampedTo);
    assertHash(expected, actual, "expected_range_hash");
    const start = parsed.lineOffsets[from - 1];
    const end = parsed.lineOffsets[clampedTo];
    // Preserve trailing newline if the original range ended on \n boundary
    const originalRange = parsed.text.slice(start, end);
    const endedWithNewline = originalRange.endsWith("\n");
    let replacement = content.replace(/\r\n?/g, "\n");
    if (endedWithNewline && !replacement.endsWith("\n")) replacement += "\n";
    if (!endedWithNewline && replacement.endsWith("\n"))
      replacement = replacement.replace(/\n$/, "");
    const newText = parsed.text.slice(0, start) + replacement + parsed.text.slice(end);
    const argsHash = AuditLog.hashArgs(args);
    const out = await persist(ctx, parsed.absPath, newText, {
      tool: "lines.replace",
      file,
      args_hash: argsHash,
      before_hash: parsed.contentHash,
      dry_run: dry,
    });
    // New range hash for the replaced region
    const newFrom = from;
    const newToApprox =
      newFrom + (replacement.split("\n").length - (replacement.endsWith("\n") ? 1 : 0)) - 1;
    return {
      file,
      changed: true,
      contentHash: out.contentHash,
      totalLines: out.totalLines,
      newRange: { from: newFrom, to: Math.max(newFrom, newToApprox) },
      dry_run: dry,
    };
  },
};

// ---------------------------------------------------------------------------
// lines.insert
// ---------------------------------------------------------------------------

export const linesInsertTool: ToolDefinition = {
  name: "lines.insert",
  summary:
    "Insert content before line N (1-based). Use line=totalLines+1 to append. No hash precondition required.",
  requiresWrite: true,
  schema: {
    type: "object",
    properties: {
      vault: { type: "string" },
      file: { type: "string" },
      line: { type: "integer", minimum: 1 },
      content: { type: "string" },
      dry_run: { type: "boolean" },
    },
    required: ["file", "line", "content"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const file = reqString(args, "file");
    const line = getInt(args, "line", { min: 1 })!;
    const content = reqString(args, "content");
    const dry = getBool(args, "dry_run", { optional: true, default: false })!;
    const parsed = await loadFile(ctx, file);
    if (line > parsed.totalLines + 1) {
      throw new ToolFailure(
        "INVALID_ARGS",
        `line (${line}) > totalLines+1 (${parsed.totalLines + 1})`,
      );
    }
    let insertText = content.replace(/\r\n?/g, "\n");
    if (!insertText.endsWith("\n")) insertText += "\n";
    const offset = line <= parsed.totalLines ? parsed.lineOffsets[line - 1] : parsed.text.length;
    let newText = parsed.text.slice(0, offset) + insertText + parsed.text.slice(offset);
    // If we're appending past the last line without a trailing newline, splice carefully
    if (line === parsed.totalLines + 1 && parsed.text.length > 0 && !parsed.text.endsWith("\n")) {
      newText = parsed.text + "\n" + insertText;
    }
    const argsHash = AuditLog.hashArgs(args);
    const out = await persist(ctx, parsed.absPath, newText, {
      tool: "lines.insert",
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

// silence unused
void sliceLines;
