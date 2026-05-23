/**
 * Server-wide resource budget configuration.
 *
 * All limits default to 0 which means "unlimited". Operators set them via:
 *   - CLI: environment variables (MCP_MAX_FILES_SCANNED, etc.)
 *   - Plugin: PluginSettings.budgets (stored in Obsidian data.json)
 *
 * These are *defaults* — users are free to raise or lower them. We never
 * enforce an upper bound on a user-supplied value.
 */

export interface ServerConfig {
  /**
   * Maximum number of markdown files scanned per search.content / vault.info
   * call. 0 = unlimited.
   */
  maxFilesScanned: number;

  /**
   * Maximum total bytes of file content read (raw, before parsing) per
   * search.content / vault.info call. 0 = unlimited.
   */
  maxBytesRead: number;

  /**
   * Maximum number of ops accepted by a single bulk.apply call. 0 = unlimited.
   */
  maxBulkOps: number;

  /**
   * Wall-clock deadline in milliseconds for long-walk tools
   * (search.content, vault.info, bulk.apply). 0 = unlimited.
   * Best-effort: CPU-bound work may exceed this until the next cooperative
   * checkpoint (once per file).
   */
  deadlineMs: number;
}

export const DEFAULT_CONFIG: ServerConfig = {
  maxFilesScanned: 0,
  maxBytesRead: 0,
  maxBulkOps: 0,
  deadlineMs: 0,
};

/**
 * Read config from environment variables. Missing / non-numeric values fall
 * back to the supplied defaults (typically DEFAULT_CONFIG).
 */
export function configFromEnv(base: ServerConfig = DEFAULT_CONFIG): ServerConfig {
  function readInt(key: string, fallback: number): number {
    const raw = process.env[key];
    if (raw === undefined || raw === "") return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }
  return {
    maxFilesScanned: readInt("MCP_MAX_FILES_SCANNED", base.maxFilesScanned),
    maxBytesRead: readInt("MCP_MAX_BYTES_READ", base.maxBytesRead),
    maxBulkOps: readInt("MCP_MAX_BULK_OPS", base.maxBulkOps),
    deadlineMs: readInt("MCP_DEADLINE_MS", base.deadlineMs),
  };
}
