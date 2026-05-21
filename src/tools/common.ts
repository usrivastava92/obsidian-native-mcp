/**
 * Shared helpers for tool handlers.
 */

import { ToolFailure } from "../utils/types.js";
import type { Hash, RelPath } from "../utils/types.js";
import type { ToolContext } from "../handlers/registry.js";
import { resolveVaultPath } from "../fs/paths.js";
import { writeTextFileAtomic, statSafe, fileExists } from "../fs/io.js";
import type { ParsedFile } from "../utils/types.js";

/** Resolve a file argument: returns absPath + parsed file (loaded from cache). */
export async function loadFile(ctx: ToolContext, file: RelPath): Promise<ParsedFile> {
  ctx.perms.assertPath(ctx.vault.name, file);
  const abs = resolveVaultPath(ctx.vault.root, file);
  return ctx.cache.get(ctx.vault.root, abs);
}

/** Resolve a file path (does not require the file to exist or be parseable). */
export function resolvePath(ctx: ToolContext, file: RelPath): string {
  ctx.perms.assertPath(ctx.vault.name, file);
  return resolveVaultPath(ctx.vault.root, file);
}

/** Verify hash precondition. Throws STALE_PRECONDITION on mismatch. */
export function assertHash(expected: Hash | undefined, actual: Hash, label = "content_hash"): void {
  if (expected === undefined) return;
  if (expected !== actual) {
    throw new ToolFailure("STALE_PRECONDITION", `${label} mismatch`, {
      expected,
      actual,
    });
  }
}

export function requireHash(
  expected: Hash | undefined,
  actual: Hash,
  label = "content_hash",
): void {
  if (expected === undefined) {
    throw new ToolFailure("INVALID_ARGS", `${label} is required`);
  }
  assertHash(expected, actual, label);
}

/**
 * Persist a new text to disk atomically, then refresh the cache and append an
 * audit log entry. Returns the post-write `ParsedFile`.
 */
export async function persist(
  ctx: ToolContext,
  abs: string,
  newText: string,
  audit: {
    tool: string;
    file: RelPath;
    args_hash?: Hash;
    before_hash?: Hash;
    dry_run?: boolean;
  },
): Promise<ParsedFile> {
  if (audit.dry_run) {
    // Compute what the post-write parse would look like, without touching disk.
    const fakeStat = {
      mtimeMs: Date.now(),
      size: Buffer.byteLength(newText, "utf-8"),
    } as import("node:fs").Stats;
    const parsed = ctx.cache.refreshAfterWrite(ctx.vault.root, abs, newText, fakeStat);
    await ctx.audit.append({
      tool: audit.tool,
      vault: ctx.vault.name,
      file: audit.file,
      args_hash: audit.args_hash,
      before_hash: audit.before_hash,
      after_hash: parsed.contentHash,
      dry_run: true,
      client_id: ctx.clientId,
    });
    // We did not really write; invalidate to force re-read on next access.
    ctx.cache.invalidate(abs);
    return parsed;
  }
  await writeTextFileAtomic(abs, newText);
  const stat = await statSafe(abs);
  if (!stat) throw new ToolFailure("IO_ERROR", `failed to stat after write: ${abs}`);
  const parsed = ctx.cache.refreshAfterWrite(ctx.vault.root, abs, newText, stat);
  await ctx.audit.append({
    tool: audit.tool,
    vault: ctx.vault.name,
    file: audit.file,
    args_hash: audit.args_hash,
    before_hash: audit.before_hash,
    after_hash: parsed.contentHash,
    dry_run: false,
    client_id: ctx.clientId,
  });
  return parsed;
}

/** Throw NOT_FOUND if path does not exist. */
export async function assertExists(absPath: string, label = "file"): Promise<void> {
  if (!(await fileExists(absPath))) {
    throw new ToolFailure("NOT_FOUND", `${label} does not exist`, { path: absPath });
  }
}
