/**
 * Move a file into the Obsidian-compatible trash directory:
 *   <vault>/.obsidian/trash/<relative-path>
 *
 * Preserves the path structure so Obsidian's UI can restore correctly.
 * Collisions are resolved by `uniquePath`.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ensureDir, uniquePath } from "./io.js";

const TRASH_REL = ".obsidian/trash";

export async function moveToTrash(vaultRoot: string, absPath: string): Promise<string> {
  const relFromVault = path.relative(vaultRoot, absPath);
  const trashTarget = path.join(vaultRoot, TRASH_REL, relFromVault);
  await ensureDir(path.dirname(trashTarget));
  const finalTarget = await uniquePath(trashTarget);
  await fs.rename(absPath, finalTarget);
  return finalTarget;
}
