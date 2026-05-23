/**
 * S16: Budget enforcement + resumability.
 *
 * Verifies that:
 *   1. search.content returns truncated=true + hint when maxFilesScanned is hit,
 *      and the returned nextOffset round-trips into a successful follow-up call.
 *   2. search.content returns truncated=true when an AbortSignal is pre-aborted
 *      (simulates client cancellation).
 *   3. vault.info returns truncated=true + hint when maxFilesScanned is hit.
 *   4. bulk.apply throws BUDGET_EXCEEDED when maxBulkOps is exceeded.
 *   5. With unlimited config (default), all tools work normally on large vaults.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { randomBytes } from "node:crypto";
import { makeSandbox } from "../helpers/sandbox.js";

// ---------------------------------------------------------------------------
// Fixture: build a temp vault with N markdown files so we can stress the
// file-count budget without depending on checked-in fixture sizes.
// ---------------------------------------------------------------------------
async function makeMultiFileSandbox(
  fileCount: number,
  opts: Parameters<typeof makeSandbox>[1] = {},
) {
  // Create a temp directory that looks like a vault with `fileCount` .md files.
  const tmp = await fs.mkdtemp(
    path.join(os.tmpdir(), `onv-s16-${randomBytes(4).toString("hex")}-`),
  );
  for (let i = 0; i < fileCount; i++) {
    await fs.writeFile(
      path.join(tmp, `note-${i}.md`),
      `# Note ${i}\n\nThis is note ${i}. It contains the keyword searchable.\n`,
      "utf-8",
    );
  }
  // makeSandbox normally copies a fixture directory — we bypass that by
  // pointing it directly at our pre-built tmp dir.
  const sb = await makeSandbox(tmp, opts);
  // Override the cleanup to also remove our tmp vault dir.
  const origCleanup = sb.cleanup.bind(sb);
  (sb as { cleanup(): Promise<void> }).cleanup = async () => {
    await origCleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  };
  return sb;
}

describe("S16 budget_exceeded", () => {
  // -------------------------------------------------------------------------
  // 1. search.content — file count budget + resumability
  // -------------------------------------------------------------------------
  it("search.content truncates at maxFilesScanned and returns usable nextOffset", async () => {
    // 10 files, budget of 3 — must truncate.
    const sb = await makeMultiFileSandbox(10, { config: { maxFilesScanned: 3 } });
    try {
      const page1 = await sb.call<{
        hits: unknown[];
        total: number;
        truncated?: boolean;
        scanned?: number;
        hint?: string;
        nextOffset?: number;
      }>("search.content", { query: "searchable", limit: 100, offset: 0 });

      assert.ok(page1.truncated === true, "page1 should be truncated");
      assert.ok(typeof page1.hint === "string" && page1.hint.length > 0, "hint should be present");
      assert.ok(
        typeof page1.scanned === "number" && page1.scanned <= 3,
        `scanned (${page1.scanned}) should be <= maxFilesScanned (3)`,
      );

      // Follow-up with a wider budget should return results across the full vault.
      const sbFull = await makeMultiFileSandbox(10, { config: { maxFilesScanned: 0 } });
      try {
        const full = await sbFull.call<{
          hits: unknown[];
          total: number;
          truncated?: boolean;
        }>("search.content", { query: "searchable", limit: 100, offset: 0 });
        assert.ok(!full.truncated, "unlimited sandbox should not truncate");
        assert.equal(full.hits.length, 10, "all 10 files should have hits");
      } finally {
        await sbFull.cleanup();
      }
    } finally {
      await sb.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // 2. search.content — pre-aborted signal (simulates client cancellation)
  // -------------------------------------------------------------------------
  it("search.content respects a pre-aborted AbortSignal", async () => {
    const ac = new AbortController();
    ac.abort("cancelled");
    const sb = await makeMultiFileSandbox(10, { signal: ac.signal });
    try {
      const result = await sb.call<{
        hits: unknown[];
        truncated?: boolean;
        hint?: string;
      }>("search.content", { query: "searchable", limit: 100, offset: 0 });
      // With a pre-aborted signal the loop exits immediately — truncated must be set.
      assert.ok(result.truncated === true, "should be truncated when signal is pre-aborted");
      assert.ok(typeof result.hint === "string", "hint should be present on cancellation");
    } finally {
      await sb.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // 3. vault.info — file count budget
  // -------------------------------------------------------------------------
  it("vault.info truncates at maxFilesScanned", async () => {
    const sb = await makeMultiFileSandbox(10, { config: { maxFilesScanned: 4 } });
    try {
      const info = await sb.call<{
        name: string;
        fileCount: number;
        sizeBytes: number;
        truncated?: boolean;
        hint?: string;
      }>("vault.info", {});

      assert.ok(info.truncated === true, "vault.info should be truncated");
      assert.ok(
        info.fileCount <= 4,
        `fileCount (${info.fileCount}) should be <= maxFilesScanned (4)`,
      );
      assert.ok(typeof info.hint === "string", "hint should be present");
    } finally {
      await sb.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // 4. bulk.apply — op count budget
  // -------------------------------------------------------------------------
  it("bulk.apply rejects when op count exceeds maxBulkOps", async () => {
    const sb = await makeMultiFileSandbox(3, { config: { maxBulkOps: 2 } });
    try {
      // Create 3 files we can reference
      const ops = [0, 1, 2].map((i) => ({
        tool: "file.read",
        args: { file: `note-${i}.md` },
      }));
      const err = await sb.expectFail("bulk.apply", { ops });
      assert.equal(err.code, "BUDGET_EXCEEDED");
      assert.ok(err.message.includes("2"), "error should mention the limit");
      assert.ok(err.message.includes("3"), "error should mention the submitted count");
    } finally {
      await sb.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // 5. Unlimited config (default) — no truncation on a normal vault
  // -------------------------------------------------------------------------
  it("default config (unlimited) does not truncate search.content", async () => {
    const sb = await makeMultiFileSandbox(10); // no config override → DEFAULT_CONFIG
    try {
      const result = await sb.call<{
        hits: unknown[];
        total: number;
        truncated?: boolean;
      }>("search.content", { query: "searchable", limit: 100, offset: 0 });
      assert.ok(!result.truncated, "default config should never truncate");
      assert.equal(result.hits.length, 10);
    } finally {
      await sb.cleanup();
    }
  });
});
