/**
 * apply_patch: apply a unified-diff to a single file with strict context-line
 * validation (the diff's context lines ARE the content precondition).
 */

import { ToolFailure } from "../utils/types.js";
import type { ToolDefinition } from "../handlers/registry.js";
import { reqString, getString, getBool } from "../handlers/args.js";
import { loadFile, persist, assertHash } from "./common.js";
import { AuditLog } from "../audit/log.js";

interface Hunk {
  oldStart: number; // 1-based
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[]; // each begins with " ", "-", "+", or "\\" (no-newline)
}

function parseUnifiedDiff(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  const allLines = patch.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  // Skip optional file headers (--- a/...  +++ b/...)
  while (i < allLines.length && !allLines[i].startsWith("@@")) i++;
  while (i < allLines.length) {
    const header = allLines[i];
    if (!header.startsWith("@@")) {
      i++;
      continue;
    }
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
    if (!m) throw new ToolFailure("INVALID_ARGS", `bad hunk header: ${header}`);
    const oldStart = parseInt(m[1], 10);
    const oldCount = m[2] !== undefined ? parseInt(m[2], 10) : 1;
    const newStart = parseInt(m[3], 10);
    const newCount = m[4] !== undefined ? parseInt(m[4], 10) : 1;
    i++;
    const lines: string[] = [];
    while (i < allLines.length && !allLines[i].startsWith("@@")) {
      lines.push(allLines[i]);
      i++;
    }
    // Drop trailing empty line produced by split if patch ends with \n
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    hunks.push({ oldStart, oldCount, newStart, newCount, lines });
  }
  if (hunks.length === 0) {
    throw new ToolFailure("INVALID_ARGS", "patch contained no hunks");
  }
  return hunks;
}

function applyHunks(originalText: string, hunks: Hunk[]): string {
  const original = originalText.split("\n");
  // Note: split on "\n" yields N+1 elements when text ends with "\n" (trailing "").
  // We'll work with this representation and re-join with "\n".
  // Result lines accumulated in order
  const result: string[] = [];
  let cursor = 0; // 0-based index into `original`
  for (let h = 0; h < hunks.length; h++) {
    const hunk = hunks[h];
    const targetIdx = hunk.oldStart - 1; // 0-based
    if (targetIdx < cursor) {
      throw new ToolFailure("INVALID_ARGS", `hunk ${h} oldStart precedes previous hunk`);
    }
    // Copy unchanged lines up to hunk
    while (cursor < targetIdx) {
      result.push(original[cursor]);
      cursor++;
    }
    // Validate + apply hunk body
    let inHunkOldOffset = 0;
    for (const ln of hunk.lines) {
      if (ln.startsWith("\\")) continue; // "\ No newline at end of file"
      const tag = ln.charAt(0);
      const text = ln.slice(1);
      if (tag === " ") {
        const orig = original[cursor + inHunkOldOffset];
        if (orig !== text) {
          throw new ToolFailure(
            "STALE_PRECONDITION",
            `context mismatch in hunk ${h} at line ${cursor + inHunkOldOffset + 1}`,
            { expected: text, actual: orig },
          );
        }
        result.push(text);
        inHunkOldOffset++;
      } else if (tag === "-") {
        const orig = original[cursor + inHunkOldOffset];
        if (orig !== text) {
          throw new ToolFailure(
            "STALE_PRECONDITION",
            `delete mismatch in hunk ${h} at line ${cursor + inHunkOldOffset + 1}`,
            { expected: text, actual: orig },
          );
        }
        inHunkOldOffset++;
      } else if (tag === "+") {
        result.push(text);
      } else {
        throw new ToolFailure("INVALID_ARGS", `unknown hunk-line tag in hunk ${h}: ${tag}`);
      }
    }
    cursor += inHunkOldOffset;
  }
  while (cursor < original.length) {
    result.push(original[cursor]);
    cursor++;
  }
  return result.join("\n");
}

export const applyPatchTool: ToolDefinition = {
  name: "apply_patch",
  summary:
    "Apply a unified diff to a file. Context lines (' ' prefix) are validated verbatim per hunk — the diff IS the content precondition. expected_content_hash is optional belt-and-suspenders. Use this for multi-hunk surgical edits.",
  requiresWrite: true,
  schema: {
    type: "object",
    properties: {
      vault: { type: "string" },
      file: { type: "string" },
      patch: { type: "string" },
      expected_content_hash: { type: "string" },
      dry_run: { type: "boolean" },
    },
    required: ["file", "patch"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const file = reqString(args, "file");
    const patch = reqString(args, "patch");
    const expected = getString(args, "expected_content_hash", { optional: true });
    const dry = getBool(args, "dry_run", { optional: true, default: false })!;
    const parsed = await loadFile(ctx, file);
    assertHash(expected, parsed.contentHash, "expected_content_hash");
    const hunks = parseUnifiedDiff(patch);
    const newText = applyHunks(parsed.text, hunks);
    if (newText === parsed.text) {
      return {
        file,
        changed: false,
        hunks: hunks.length,
        contentHash: parsed.contentHash,
        dry_run: dry,
      };
    }
    const argsHash = AuditLog.hashArgs(args);
    const out = await persist(ctx, parsed.absPath, newText, {
      tool: "apply_patch",
      file,
      args_hash: argsHash,
      before_hash: parsed.contentHash,
      dry_run: dry,
    });
    return {
      file,
      changed: true,
      hunks: hunks.length,
      contentHash: out.contentHash,
      totalLines: out.totalLines,
      dry_run: dry,
    };
  },
};
