/**
 * Whole-file / metadata write tools:
 *   file.create, file.replace, file.append, file.move, file.delete
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ToolFailure } from "../utils/types.js";
import type { ToolDefinition } from "../handlers/registry.js";
import { reqString, getString, getBool, getEnum } from "../handlers/args.js";
import { loadFile, resolvePath, persist, requireHash, assertHash } from "./common.js";
import {
  fileExists,
  uniquePath,
  writeTextFileAtomic,
  statSafe,
  readText,
  ensureDir,
} from "../fs/io.js";
import { moveToTrash } from "../fs/trash.js";
import { canonicalise, sha256Raw } from "../markdown/fingerprint.js";
import { AuditLog } from "../audit/log.js";
import { toPosix } from "../fs/paths.js";

export const fileCreateTool: ToolDefinition = {
  name: "file.create",
  summary:
    "Create a NEW file with the given content. Errors if the file already exists; use file.replace for overwrite.",
  requiresWrite: true,
  schema: {
    type: "object",
    properties: {
      vault: { type: "string" },
      file: { type: "string" },
      content: { type: "string" },
      dry_run: { type: "boolean" },
    },
    required: ["file", "content"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const file = reqString(args, "file");
    const content = reqString(args, "content");
    const dry = getBool(args, "dry_run", { optional: true, default: false })!;
    const abs = resolvePath(ctx, file);
    if (await fileExists(abs)) {
      throw new ToolFailure("DESTINATION_EXISTS", `file already exists: ${file}`, { path: file });
    }
    const argsHash = AuditLog.hashArgs(args);
    const parsed = await persist(ctx, abs, canonicalise(content), {
      tool: "file.create",
      file,
      args_hash: argsHash,
      dry_run: dry,
    });
    return {
      file,
      created: true,
      contentHash: parsed.contentHash,
      totalLines: parsed.totalLines,
      dry_run: dry,
    };
  },
};

export const fileReplaceTool: ToolDefinition = {
  name: "file.replace",
  summary:
    "HEAVY: replace the entire content of a file. Prefer str_replace / apply_patch / heading.replace_body / block.replace / frontmatter.set / lines.replace for surgical edits. Requires expected_content_hash unless create_if_missing is true and the file does not exist.",
  requiresWrite: true,
  schema: {
    type: "object",
    properties: {
      vault: { type: "string" },
      file: { type: "string" },
      content: { type: "string" },
      expected_content_hash: { type: "string" },
      create_if_missing: { type: "boolean" },
      dry_run: { type: "boolean" },
    },
    required: ["file", "content"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const file = reqString(args, "file");
    const content = reqString(args, "content");
    const expectedHash = getString(args, "expected_content_hash", { optional: true });
    const createIfMissing = getBool(args, "create_if_missing", { optional: true, default: false })!;
    const dry = getBool(args, "dry_run", { optional: true, default: false })!;
    const abs = resolvePath(ctx, file);
    const argsHash = AuditLog.hashArgs(args);
    const exists = await fileExists(abs);
    let beforeHash: string | undefined;
    if (exists) {
      const parsed = await loadFile(ctx, file);
      beforeHash = parsed.contentHash;
      requireHash(expectedHash, parsed.contentHash, "expected_content_hash");
    } else {
      if (!createIfMissing) {
        throw new ToolFailure("NOT_FOUND", `file does not exist: ${file}`);
      }
    }
    const parsed = await persist(ctx, abs, canonicalise(content), {
      tool: "file.replace",
      file,
      args_hash: argsHash,
      before_hash: beforeHash,
      dry_run: dry,
    });
    return {
      file,
      created: !exists,
      contentHash: parsed.contentHash,
      totalLines: parsed.totalLines,
      dry_run: dry,
    };
  },
};

export const fileAppendTool: ToolDefinition = {
  name: "file.append",
  summary:
    "Append text to a file (creating it if missing). Cheap: no read of existing content required.",
  requiresWrite: true,
  schema: {
    type: "object",
    properties: {
      vault: { type: "string" },
      file: { type: "string" },
      content: { type: "string" },
      ensureTrailingNewline: { type: "boolean" },
      dry_run: { type: "boolean" },
    },
    required: ["file", "content"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const file = reqString(args, "file");
    const content = reqString(args, "content");
    const ensureTrailing = getBool(args, "ensureTrailingNewline", {
      optional: true,
      default: true,
    })!;
    const dry = getBool(args, "dry_run", { optional: true, default: false })!;
    const abs = resolvePath(ctx, file);
    const argsHash = AuditLog.hashArgs(args);
    let existing = "";
    let beforeHash: string | undefined;
    if (await fileExists(abs)) {
      existing = canonicalise(await readText(abs));
      beforeHash = sha256Raw(existing);
    }
    let append = canonicalise(content);
    if (ensureTrailing && existing.length > 0 && !existing.endsWith("\n")) existing += "\n";
    if (ensureTrailing && !append.endsWith("\n")) append += "\n";
    const newText = existing + append;
    const parsed = await persist(ctx, abs, newText, {
      tool: "file.append",
      file,
      args_hash: argsHash,
      before_hash: beforeHash,
      dry_run: dry,
    });
    return {
      file,
      contentHash: parsed.contentHash,
      totalLines: parsed.totalLines,
      dry_run: dry,
    };
  },
};

export const fileMoveTool: ToolDefinition = {
  name: "file.move",
  summary: "Move or rename a file. Defaults to on_conflict='error' — never silently overwrites.",
  requiresWrite: true,
  schema: {
    type: "object",
    properties: {
      vault: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      on_conflict: { type: "string", enum: ["error", "overwrite", "rename"] },
      update_links: { type: "boolean" },
      dry_run: { type: "boolean" },
    },
    required: ["from", "to"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const fromRel = reqString(args, "from");
    const toRel = reqString(args, "to");
    const conflict = getEnum(args, "on_conflict", ["error", "overwrite", "rename"] as const, {
      optional: true,
      default: "error",
    })!;
    const dry = getBool(args, "dry_run", { optional: true, default: false })!;
    const fromAbs = resolvePath(ctx, fromRel);
    const toAbs = resolvePath(ctx, toRel);
    if (!(await fileExists(fromAbs))) {
      throw new ToolFailure("NOT_FOUND", `source does not exist: ${fromRel}`);
    }
    let finalTo = toAbs;
    if (await fileExists(toAbs)) {
      if (conflict === "error") {
        throw new ToolFailure("DESTINATION_EXISTS", `destination exists: ${toRel}`);
      } else if (conflict === "rename") {
        finalTo = await uniquePath(toAbs);
      } // overwrite: leave as-is
    }
    const argsHash = AuditLog.hashArgs(args);
    if (dry) {
      await ctx.audit.append({
        tool: "file.move",
        vault: ctx.vault.name,
        file: fromRel,
        args_hash: argsHash,
        dry_run: true,
        client_id: ctx.clientId,
      });
      return {
        from: fromRel,
        to: toPosix(path.relative(ctx.vault.root, finalTo)),
        moved: false,
        dry_run: true,
      };
    }
    await ensureDir(path.dirname(finalTo));
    await fs.rename(fromAbs, finalTo);
    ctx.cache.invalidate(fromAbs);
    ctx.cache.invalidate(finalTo);
    await ctx.audit.append({
      tool: "file.move",
      vault: ctx.vault.name,
      file: fromRel,
      args_hash: argsHash,
      dry_run: false,
      client_id: ctx.clientId,
    });
    return {
      from: fromRel,
      to: toPosix(path.relative(ctx.vault.root, finalTo)),
      moved: true,
      dry_run: false,
    };
  },
};

export const fileDeleteTool: ToolDefinition = {
  name: "file.delete",
  summary:
    "Delete a file. Default trash=true → moved to <vault>/.obsidian/trash. Hard delete (trash=false) requires expected_content_hash.",
  requiresWrite: true,
  schema: {
    type: "object",
    properties: {
      vault: { type: "string" },
      file: { type: "string" },
      trash: { type: "boolean" },
      expected_content_hash: { type: "string" },
      dry_run: { type: "boolean" },
    },
    required: ["file"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const file = reqString(args, "file");
    const trash = getBool(args, "trash", { optional: true, default: true })!;
    const expectedHash = getString(args, "expected_content_hash", { optional: true });
    const dry = getBool(args, "dry_run", { optional: true, default: false })!;
    const abs = resolvePath(ctx, file);
    if (!(await fileExists(abs))) {
      throw new ToolFailure("NOT_FOUND", `file not found: ${file}`);
    }
    let beforeHash: string | undefined;
    if (file.toLowerCase().endsWith(".md")) {
      const parsed = await loadFile(ctx, file);
      beforeHash = parsed.contentHash;
    } else {
      beforeHash = sha256Raw(canonicalise(await readText(abs)));
    }
    if (!trash) {
      // Hard delete requires hash confirmation
      requireHash(expectedHash, beforeHash, "expected_content_hash");
    } else if (expectedHash !== undefined) {
      assertHash(expectedHash, beforeHash, "expected_content_hash");
    }
    const argsHash = AuditLog.hashArgs(args);
    if (dry) {
      await ctx.audit.append({
        tool: "file.delete",
        vault: ctx.vault.name,
        file,
        args_hash: argsHash,
        before_hash: beforeHash,
        dry_run: true,
        client_id: ctx.clientId,
      });
      return { file, deleted: false, trashed: trash, dry_run: true };
    }
    let trashedTo: string | undefined;
    if (trash) {
      const dest = await moveToTrash(ctx.vault.root, abs);
      trashedTo = toPosix(path.relative(ctx.vault.root, dest));
    } else {
      await fs.unlink(abs);
    }
    ctx.cache.invalidate(abs);
    await ctx.audit.append({
      tool: "file.delete",
      vault: ctx.vault.name,
      file,
      args_hash: argsHash,
      before_hash: beforeHash,
      dry_run: false,
      client_id: ctx.clientId,
    });
    return {
      file,
      deleted: !trash,
      trashed: trash,
      trashedTo,
      dry_run: false,
    };
  },
};

// silence unused-import warnings on platforms where helpers aren't tree-shaken
void writeTextFileAtomic;
void statSafe;
