/**
 * Async file I/O primitives.
 *
 * All writes go through `writeTextFileAtomic` (temp file + rename) so a crash
 * mid-write leaves the original intact.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

export async function fileExists(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
}

export async function readText(absPath: string): Promise<string> {
  return fs.readFile(absPath, "utf-8");
}

export async function readBytes(absPath: string): Promise<Buffer> {
  return fs.readFile(absPath);
}

export async function ensureDir(absPath: string): Promise<void> {
  await fs.mkdir(absPath, { recursive: true });
}

export async function writeTextFileAtomic(absPath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(absPath));
  const tmp = `${absPath}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    await fs.writeFile(tmp, content, "utf-8");
    await fs.rename(tmp, absPath);
  } catch (err) {
    // Best-effort cleanup; never throw from cleanup.
    try {
      await fs.unlink(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export async function statSafe(absPath: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.stat(absPath);
  } catch {
    return null;
  }
}

/** Return a path that does not exist by suffixing " (n)" before the extension. */
export async function uniquePath(absPath: string): Promise<string> {
  if (!(await fileExists(absPath))) return absPath;
  const dir = path.dirname(absPath);
  const ext = path.extname(absPath);
  const base = path.basename(absPath, ext);
  for (let i = 1; i < 10_000; i++) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!(await fileExists(candidate))) return candidate;
  }
  throw new Error(`unable to find a unique path for ${absPath} after 10000 tries`);
}
