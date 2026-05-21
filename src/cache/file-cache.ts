/**
 * Simple bounded LRU file cache (Design B from DESIGN_V1.md §11).
 *
 * Validation: an entry is reused only if both `mtimeMs` and `size` match the
 * current `fs.stat` result. On any write the server performs, we refresh the
 * entry inline using the post-write text in memory (avoiding a re-parse from
 * disk).
 */

import * as fs from "node:fs/promises";
import type { ParsedFile, RelPath } from "../utils/types.js";
import { readText } from "../fs/io.js";
import { parseFile } from "../markdown/parse-file.js";
import { toPosix } from "../fs/paths.js";
import * as path from "node:path";

export interface IFileCache {
  get(vaultRoot: string, absPath: string): Promise<ParsedFile>;
  invalidate(absPath: string): void;
  refreshAfterWrite(
    vaultRoot: string,
    absPath: string,
    text: string,
    stat: import("node:fs").Stats,
  ): ParsedFile;
  size(): number;
  clear(): void;
}

export class LRUFileCache implements IFileCache {
  private cache: Map<string, ParsedFile> = new Map();
  private maxEntries: number;

  constructor(maxEntries: number = 256) {
    this.maxEntries = maxEntries;
  }

  async get(vaultRoot: string, absPath: string): Promise<ParsedFile> {
    const stat = await fs.stat(absPath);
    const cached = this.cache.get(absPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      this.touch(absPath);
      return cached;
    }
    const rawText = await readText(absPath);
    const relPath: RelPath = toPosix(path.relative(vaultRoot, absPath));
    const parsed = parseFile({ path: relPath, absPath, rawText, stat });
    this.put(absPath, parsed);
    return parsed;
  }

  invalidate(absPath: string): void {
    this.cache.delete(absPath);
  }

  refreshAfterWrite(
    vaultRoot: string,
    absPath: string,
    text: string,
    stat: import("node:fs").Stats,
  ): ParsedFile {
    const relPath: RelPath = toPosix(path.relative(vaultRoot, absPath));
    const parsed = parseFile({ path: relPath, absPath, rawText: text, stat });
    this.put(absPath, parsed);
    return parsed;
  }

  size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }

  private touch(absPath: string): void {
    const v = this.cache.get(absPath);
    if (v === undefined) return;
    this.cache.delete(absPath);
    this.cache.set(absPath, v);
  }

  private put(absPath: string, parsed: ParsedFile): void {
    this.cache.delete(absPath);
    this.cache.set(absPath, parsed);
    while (this.cache.size > this.maxEntries) {
      const firstKey = this.cache.keys().next().value as string | undefined;
      if (firstKey === undefined) break;
      this.cache.delete(firstKey);
    }
  }
}
