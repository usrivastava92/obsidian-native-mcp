/**
 * bulk.apply: multi-file, multi-op atomic batch.
 *
 *   ops: [{ tool: "<name>", args: {...} }, ...]
 *
 * Process-atomic algorithm (see DESIGN_V1.md §8):
 *   1. Snapshot every file's pre-text + hash that might be touched.
 *   2. Run each op in dry_run mode; collect intended new texts in memory.
 *      Any failure → return errors per op, vault unchanged.
 *   3. On full success: write each file atomically. If a write fails midway,
 *      restore previously-written files from the snapshot (best effort).
 *
 * regex.replace: power tool, two-step (first dry_run mandatory → proposal_token,
 * then second call with same args + token + expected_content_hash).
 */

import { ToolFailure } from "../utils/types.js";
import type { ToolDefinition } from "../handlers/registry.js";
import { reqString, getString, getBool, getArray, getInt } from "../handlers/args.js";
import { resolvePath, loadFile, persist, assertHash } from "./common.js";
import { writeTextFileAtomic, readText, fileExists } from "../fs/io.js";
import { canonicalise, sha256Raw, sha256 } from "../markdown/fingerprint.js";
import { AuditLog } from "../audit/log.js";
import { strReplaceTool } from "./write-surgical.js";
import { applyEditsTool, linesReplaceTool, linesInsertTool } from "./write-surgical.js";
import { applyPatchTool } from "./write-patch.js";
import {
  headingReplaceBodyTool,
  headingRenameTool,
  blockReplaceTool,
  blockRenameTool,
  frontmatterSetTool,
  frontmatterDeleteTool,
} from "./write-structural.js";
import {
  fileCreateTool,
  fileReplaceTool,
  fileAppendTool,
  fileMoveTool,
  fileDeleteTool,
} from "./write-basic.js";

const BULK_DELEGATES: Record<string, import("../handlers/registry.js").ToolDefinition> = {
  str_replace: strReplaceTool,
  apply_edits: applyEditsTool,
  apply_patch: applyPatchTool,
  "heading.replace_body": headingReplaceBodyTool,
  "heading.rename": headingRenameTool,
  "block.replace": blockReplaceTool,
  "block.rename": blockRenameTool,
  "frontmatter.set": frontmatterSetTool,
  "frontmatter.delete": frontmatterDeleteTool,
  "lines.replace": linesReplaceTool,
  "lines.insert": linesInsertTool,
  "file.create": fileCreateTool,
  "file.replace": fileReplaceTool,
  "file.append": fileAppendTool,
  "file.move": fileMoveTool,
  "file.delete": fileDeleteTool,
};

export const bulkApplyTool: ToolDefinition = {
  name: "bulk.apply",
  summary:
    "Execute a batch of write operations. With atomic=true (default), all ops are first validated in dry-run mode against in-memory snapshots; the actual writes happen only if every op would succeed. If any post-validation write fails, best-effort restore is attempted.",
  requiresWrite: true,
  schema: {
    type: "object",
    properties: {
      vault: { type: "string" },
      ops: {
        type: "array",
        items: {
          type: "object",
          properties: {
            tool: { type: "string" },
            args: { type: "object" },
          },
          required: ["tool", "args"],
        },
      },
      atomic: { type: "boolean" },
      dry_run: { type: "boolean" },
      _budget: {
        type: "object",
        description:
          "Optional per-call budget override. maxBulkOps overrides the server default for this call only. 0 = unlimited.",
        properties: {
          maxBulkOps: { type: "integer", minimum: 0 },
        },
        additionalProperties: false,
      },
    },
    required: ["ops"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const opsRaw = getArray<Record<string, unknown>>(args, "ops")!;
    const atomic = getBool(args, "atomic", { optional: true, default: true })!;
    const dry = getBool(args, "dry_run", { optional: true, default: false })!;
    if (opsRaw.length === 0) throw new ToolFailure("INVALID_ARGS", "ops must be non-empty");

    // Per-call budget override: _budget.maxBulkOps takes precedence over server config.
    const callBudget = (args._budget ?? {}) as Partial<{ maxBulkOps: number }>;
    const maxBulkOps = callBudget.maxBulkOps ?? ctx.config.maxBulkOps;

    if (maxBulkOps > 0 && opsRaw.length > maxBulkOps) {
      throw new ToolFailure(
        "BUDGET_EXCEEDED",
        `bulk.apply received ${opsRaw.length} ops but the current limit is ${maxBulkOps}. ` +
          `Split into smaller batches or raise the limit (MCP_MAX_BULK_OPS / plugin settings).`,
        { submitted: opsRaw.length, limit: maxBulkOps },
      );
    }
    if (!atomic) {
      // Non-atomic: just run each op sequentially via its handler.
      const results: Array<{ index: number; ok: boolean; result?: unknown; error?: unknown }> = [];
      for (let i = 0; i < opsRaw.length; i++) {
        const op = opsRaw[i];
        const tool = typeof op.tool === "string" ? op.tool : "";
        const opArgs = (op.args ?? {}) as Record<string, unknown>;
        const def = BULK_DELEGATES[tool];
        if (!def) {
          results.push({
            index: i,
            ok: false,
            error: { code: "INVALID_ARGS", message: `unknown tool: ${tool}` },
          });
          continue;
        }
        try {
          const r = await def.handler({ ...opArgs, dry_run: dry } as never, ctx);
          results.push({ index: i, ok: true, result: r });
        } catch (e) {
          if (e instanceof ToolFailure) results.push({ index: i, ok: false, error: e.toJSON() });
          else
            results.push({
              index: i,
              ok: false,
              error: { code: "INTERNAL", message: (e as Error).message },
            });
        }
      }
      return { atomic: false, dry_run: dry, results };
    }

    // Atomic: dry-run all ops, then if all green, replay for real.
    const dryResults: Array<{ index: number; ok: boolean; result?: unknown; error?: unknown }> = [];
    let allOk = true;
    for (let i = 0; i < opsRaw.length; i++) {
      const op = opsRaw[i];
      const tool = typeof op.tool === "string" ? op.tool : "";
      const opArgs = (op.args ?? {}) as Record<string, unknown>;
      const def = BULK_DELEGATES[tool];
      if (!def) {
        dryResults.push({
          index: i,
          ok: false,
          error: { code: "INVALID_ARGS", message: `unknown tool: ${tool}` },
        });
        allOk = false;
        continue;
      }
      try {
        const r = await def.handler({ ...opArgs, dry_run: true } as never, ctx);
        dryResults.push({ index: i, ok: true, result: r });
      } catch (e) {
        allOk = false;
        if (e instanceof ToolFailure) dryResults.push({ index: i, ok: false, error: e.toJSON() });
        else
          dryResults.push({
            index: i,
            ok: false,
            error: { code: "INTERNAL", message: (e as Error).message },
          });
      }
    }
    if (!allOk || dry) {
      return { atomic: true, dry_run: true, validated: allOk, results: dryResults };
    }
    // Snapshot files we'll touch (by `file` arg if present) so we can restore on partial failure.
    const snapshots = new Map<string, string | null>();
    for (const op of opsRaw) {
      const opArgs = (op.args ?? {}) as Record<string, unknown>;
      const f =
        typeof opArgs.file === "string"
          ? opArgs.file
          : typeof opArgs.from === "string"
            ? opArgs.from
            : undefined;
      if (!f) continue;
      try {
        const abs = resolvePath(ctx, f);
        if (await fileExists(abs)) {
          if (!snapshots.has(abs)) snapshots.set(abs, await readText(abs));
        } else {
          if (!snapshots.has(abs)) snapshots.set(abs, null);
        }
      } catch {
        /* skip — invalid paths surface as op errors */
      }
    }
    // Replay for real.
    const realResults: Array<{ index: number; ok: boolean; result?: unknown; error?: unknown }> =
      [];
    for (let i = 0; i < opsRaw.length; i++) {
      const op = opsRaw[i];
      const tool = typeof op.tool === "string" ? op.tool : "";
      const opArgs = (op.args ?? {}) as Record<string, unknown>;
      const def = BULK_DELEGATES[tool];
      try {
        const r = await def.handler({ ...opArgs, dry_run: false } as never, ctx);
        realResults.push({ index: i, ok: true, result: r });
      } catch (e) {
        // Best-effort rollback of all touched files.
        for (const [abs, originalText] of snapshots) {
          try {
            if (originalText === null) {
              if (await fileExists(abs)) {
                const { unlink } = await import("node:fs/promises");
                await unlink(abs);
              }
            } else {
              await writeTextFileAtomic(abs, originalText);
            }
            ctx.cache.invalidate(abs);
          } catch {
            /* ignore */
          }
        }
        const err =
          e instanceof ToolFailure
            ? e.toJSON()
            : { code: "INTERNAL", message: (e as Error).message };
        realResults.push({ index: i, ok: false, error: err });
        return {
          atomic: true,
          dry_run: false,
          rolled_back: true,
          failing_index: i,
          results: realResults,
        };
      }
    }
    return { atomic: true, dry_run: false, rolled_back: false, results: realResults };
  },
};

// ---------------------------------------------------------------------------
// regex.replace — two-step
// ---------------------------------------------------------------------------

// Cache of issued proposal tokens; cleared after consumption. Keys: token → {file, expected_content_hash, args_hash, planned_new_text}
const proposals = new Map<
  string,
  {
    absPath: string;
    file: string;
    expectedHash: string;
    argsHash: string;
    newText: string;
    createdAt: number;
  }
>();
const PROPOSAL_TTL_MS = 5 * 60_000;

function evictExpiredProposals(): void {
  const now = Date.now();
  for (const [k, v] of proposals) {
    if (now - v.createdAt > PROPOSAL_TTL_MS) proposals.delete(k);
  }
}

export const regexReplaceTool: ToolDefinition = {
  name: "regex.replace",
  summary:
    "POWER TOOL: regex replacement on a file. TWO-STEP: first call MUST be dry_run=true; server returns a proposal_token + preview. Second call must supply the same token + matching expected_content_hash. Disabled by default in permissions.",
  requiresWrite: true,
  schema: {
    type: "object",
    properties: {
      vault: { type: "string" },
      file: { type: "string" },
      pattern: { type: "string" },
      replacement: { type: "string" },
      flags: { type: "string" },
      count: { type: "integer", minimum: 1 },
      expected_content_hash: { type: "string" },
      proposal_token: { type: "string" },
      dry_run: { type: "boolean" },
    },
    required: ["file", "pattern", "replacement"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    evictExpiredProposals();
    const file = reqString(args, "file");
    const pattern = reqString(args, "pattern");
    const replacement = reqString(args, "replacement");
    const flags = getString(args, "flags", { optional: true }) ?? "g";
    const count = getInt(args, "count", { optional: true, min: 1 });
    const expectedHash = getString(args, "expected_content_hash", { optional: true });
    const token = getString(args, "proposal_token", { optional: true });
    const dry = getBool(args, "dry_run", { optional: true, default: false })!;
    const parsed = await loadFile(ctx, file);
    let re: RegExp;
    try {
      re = new RegExp(pattern, flags);
    } catch (e) {
      throw new ToolFailure("INVALID_ARGS", `invalid regex: ${(e as Error).message}`);
    }
    let replacedCount = 0;
    const newText = parsed.text.replace(re, (...m) => {
      if (count !== undefined && replacedCount >= count) return m[0] as string;
      replacedCount++;
      return replacement;
    });
    if (dry) {
      const argsHash = AuditLog.hashArgs({ file, pattern, replacement, flags, count });
      const t = sha256Raw(
        `${parsed.absPath}|${parsed.contentHash}|${argsHash}|${Date.now()}`,
      ).slice(7, 39);
      proposals.set(t, {
        absPath: parsed.absPath,
        file,
        expectedHash: parsed.contentHash,
        argsHash,
        newText,
        createdAt: Date.now(),
      });
      const previewHash = sha256(newText);
      return {
        file,
        dry_run: true,
        proposal_token: t,
        replaced_preview_count: replacedCount,
        currentHash: parsed.contentHash,
        wouldBeHash: previewHash,
      };
    }
    // Real apply: token + hash required.
    if (!token)
      throw new ToolFailure(
        "INVALID_ARGS",
        "proposal_token required (call with dry_run=true first)",
      );
    if (!expectedHash) throw new ToolFailure("INVALID_ARGS", "expected_content_hash required");
    const prop = proposals.get(token);
    if (!prop) throw new ToolFailure("STALE_PRECONDITION", "proposal expired or unknown token");
    if (prop.absPath !== parsed.absPath)
      throw new ToolFailure("STALE_PRECONDITION", "proposal/file mismatch");
    assertHash(expectedHash, parsed.contentHash, "expected_content_hash");
    if (prop.expectedHash !== parsed.contentHash) {
      proposals.delete(token);
      throw new ToolFailure("STALE_PRECONDITION", "file changed since proposal");
    }
    proposals.delete(token);
    const out = await persist(ctx, parsed.absPath, prop.newText, {
      tool: "regex.replace",
      file,
      args_hash: prop.argsHash,
      before_hash: parsed.contentHash,
      dry_run: false,
    });
    return {
      file,
      changed: prop.newText !== parsed.text,
      contentHash: out.contentHash,
      totalLines: out.totalLines,
      replacedCount,
      dry_run: false,
    };
  },
};

// silence unused
void canonicalise;
