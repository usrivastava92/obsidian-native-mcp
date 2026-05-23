/**
 * Async directory walker.
 *
 * - Skips entries matching `ignore` (defaults: `.git`, `.obsidian`, `node_modules`).
 * - Does NOT follow symlinks (security).
 * - Yields entries with their vault-relative POSIX path.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { toPosix } from "./paths.js";

export interface WalkEntry {
  /** Vault-relative POSIX path. */
  relPath: string;
  absPath: string;
  type: "file" | "directory";
  size: number;
  mtimeMs: number;
}

export interface WalkOptions {
  /** Directory names to skip entirely. */
  ignore?: Set<string>;
  /** Maximum recursion depth (0 = just root). */
  maxDepth?: number;
  /** If true, restrict to files matching this extension list (no leading dot). */
  extensions?: string[];
  /** Optional predicate to filter entries before yielding. */
  filter?: (e: WalkEntry) => boolean;
  /** If provided, the walk stops yielding as soon as the signal is aborted. */
  signal?: AbortSignal;
}

const DEFAULT_IGNORE = new Set([".git", ".obsidian", "node_modules", ".trash"]);

export async function* walk(rootAbs: string, options: WalkOptions = {}): AsyncGenerator<WalkEntry> {
  const ignore = options.ignore ?? DEFAULT_IGNORE;
  const maxDepth = options.maxDepth ?? Infinity;
  const extSet = options.extensions
    ? new Set(options.extensions.map((e) => e.toLowerCase().replace(/^\./, "")))
    : null;
  yield* walkInner(rootAbs, rootAbs, 0, ignore, maxDepth, extSet, options.filter, options.signal);
}

async function* walkInner(
  rootAbs: string,
  curAbs: string,
  depth: number,
  ignore: Set<string>,
  maxDepth: number,
  extSet: Set<string> | null,
  filter?: (e: WalkEntry) => boolean,
  signal?: AbortSignal,
): AsyncGenerator<WalkEntry> {
  if (signal?.aborted) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(curAbs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (signal?.aborted) return;
    if (ignore.has(ent.name)) continue;
    const childAbs = path.join(curAbs, ent.name);
    const relPath = toPosix(path.relative(rootAbs, childAbs));
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) {
      const stat = await fs.stat(childAbs).catch(() => null);
      if (stat === null) continue;
      const e: WalkEntry = {
        relPath,
        absPath: childAbs,
        type: "directory",
        size: 0,
        mtimeMs: stat.mtimeMs,
      };
      if (!filter || filter(e)) yield e;
      if (depth < maxDepth) {
        yield* walkInner(rootAbs, childAbs, depth + 1, ignore, maxDepth, extSet, filter, signal);
      }
    } else if (ent.isFile()) {
      if (extSet) {
        const ext = path.extname(ent.name).slice(1).toLowerCase();
        if (!extSet.has(ext)) continue;
      }
      const stat = await fs.stat(childAbs).catch(() => null);
      if (stat === null) continue;
      const e: WalkEntry = {
        relPath,
        absPath: childAbs,
        type: "file",
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
      if (!filter || filter(e)) yield e;
    }
  }
}
