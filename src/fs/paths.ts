/**
 * Vault-relative path utilities + traversal guards.
 *
 * All public paths in the tool surface are POSIX-style (forward slashes) and
 * MUST be contained within the vault root. We refuse anything containing `..`
 * segments, absolute paths, or null bytes.
 */

import * as path from "node:path";
import { ToolFailure } from "../utils/types.js";
import type { RelPath } from "../utils/types.js";

/** Convert any path to POSIX form ("\\" → "/"). */
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Convert a POSIX vault path to a native absolute path under `vaultRoot`. */
export function resolveVaultPath(vaultRoot: string, relPath: RelPath): string {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new ToolFailure("INVALID_ARGS", "file path must be a non-empty string");
  }
  if (relPath.indexOf("\0") !== -1) {
    throw new ToolFailure("INVALID_ARGS", "file path contains a null byte");
  }
  const normalised = toPosix(relPath).replace(/^\/+/, "");
  const segments = normalised.split("/");
  for (const seg of segments) {
    if (seg === "..") {
      throw new ToolFailure("INVALID_ARGS", `path traversal not permitted: ${relPath}`);
    }
  }
  const abs = path.resolve(vaultRoot, ...segments);
  const rel = path.relative(vaultRoot, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ToolFailure("INVALID_ARGS", `path escapes vault root: ${relPath}`);
  }
  return abs;
}

/** Vault-relative POSIX path for an absolute path under `vaultRoot`. */
export function relativeVaultPath(vaultRoot: string, absPath: string): RelPath {
  const rel = path.relative(vaultRoot, absPath);
  return toPosix(rel);
}
