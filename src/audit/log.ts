/**
 * JSONL audit log for mutating tool calls.
 *
 *   <vault>/.obsidian/plugins/obsidian-native-mcp/audit.log
 *
 * Each entry contains: ts, tool, vault, file, args_hash, before_hash,
 * after_hash, dry_run, client_id. We don't log raw args (could leak note
 * bodies); we hash them.
 *
 * Rotation: when the file exceeds 10MB, rename to `audit.log.1` (keep up to
 * 5 rotations).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { ensureDir } from "../fs/io.js";
import type { Hash } from "../utils/types.js";

const REL = ".obsidian/plugins/obsidian-native-mcp/audit.log";
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ROTATIONS = 5;

export interface AuditEntry {
  ts: string;
  tool: string;
  vault: string;
  file?: string;
  args_hash?: Hash;
  before_hash?: Hash;
  after_hash?: Hash;
  dry_run?: boolean;
  client_id?: string;
  error_code?: string;
  /** Telemetry fields written by long-walk tools. */
  duration_ms?: number;
  files_scanned?: number;
  bytes_read?: number;
  truncated?: boolean;
  abort_reason?: "deadline" | "budget" | "cancelled";
}

export class AuditLog {
  constructor(private vaultRoot: string) {}

  async append(entry: Omit<AuditEntry, "ts">): Promise<void> {
    const filePath = path.join(this.vaultRoot, REL);
    await ensureDir(path.dirname(filePath));
    await this.rotateIfNeeded(filePath);
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    await fs.appendFile(filePath, line, "utf-8");
  }

  async tail(n: number = 100): Promise<AuditEntry[]> {
    const filePath = path.join(this.vaultRoot, REL);
    let text: string;
    try {
      text = await fs.readFile(filePath, "utf-8");
    } catch {
      return [];
    }
    const lines = text.split("\n").filter((l) => l.length > 0);
    const slice = lines.slice(-n);
    const out: AuditEntry[] = [];
    for (const l of slice) {
      try {
        out.push(JSON.parse(l) as AuditEntry);
      } catch {
        /* skip malformed line */
      }
    }
    return out;
  }

  static hashArgs(args: unknown): Hash {
    const stable = stableStringify(args);
    const h = createHash("sha256");
    h.update(stable, "utf-8");
    return `sha256:${h.digest("hex")}`;
  }

  private async rotateIfNeeded(filePath: string): Promise<void> {
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return;
    }
    if (stat.size < MAX_BYTES) return;
    // Shift .N → .(N+1)
    for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
      const from = `${filePath}.${i}`;
      const to = `${filePath}.${i + 1}`;
      try {
        await fs.rename(from, to);
      } catch {
        /* ignore */
      }
    }
    try {
      await fs.rename(filePath, `${filePath}.1`);
    } catch {
      /* ignore */
    }
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringify(v)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}
