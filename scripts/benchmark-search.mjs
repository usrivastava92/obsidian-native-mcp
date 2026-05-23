#!/usr/bin/env node
/**
 * Benchmark: search.content pre-filter win
 *
 * Measures wall-clock time for search.content across a synthetic vault of
 * N markdown files where only a fraction contain the search term.
 *
 * Two modes are compared:
 *   - "cold"  : fresh LRU cache (simulates first run / cache miss)
 *   - "warm"  : fully-primed LRU cache (simulates repeated searches)
 *
 * The pre-filter (raw readFile + indexOf before mdast parse) means files
 * without a hit never touch the mdast parser. This benchmark shows the
 * wall-clock benefit of that optimization.
 *
 * Usage:
 *   node scripts/benchmark-search.mjs [--files 200] [--hit-rate 0.1] [--runs 3]
 *
 * Options:
 *   --files     Total .md files in synthetic vault (default: 200)
 *   --hit-rate  Fraction of files that contain the query term (default: 0.1)
 *   --runs      Number of timed runs per mode (default: 3)
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Parse CLI flags
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function flag(name, def) {
  const i = args.indexOf(name);
  return i !== -1 ? Number(args[i + 1]) : def;
}
const TOTAL_FILES = flag("--files", 200);
const HIT_RATE = flag("--hit-rate", 0.1);
const RUNS = flag("--runs", 3);
const HIT_COUNT = Math.round(TOTAL_FILES * HIT_RATE);

console.log(`\n📊  Benchmark: search.content pre-filter`);
console.log(`   Vault: ${TOTAL_FILES} files · ${HIT_COUNT} contain the query (${(HIT_RATE * 100).toFixed(0)}% hit rate)`);
console.log(`   Runs per mode: ${RUNS}\n`);

// ---------------------------------------------------------------------------
// Build synthetic vault
// ---------------------------------------------------------------------------
const QUERY = "the_searchable_term_xyz";
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `onv-bench-${randomBytes(4).toString("hex")}-`));

process.on("exit", () => {
  fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});
process.on("SIGINT", () => { process.exit(0); });

console.log(`   Building synthetic vault in ${tmpDir}…`);
const lorem = `Lorem ipsum dolor sit amet, consectetur adipiscing elit. `.repeat(30);
for (let i = 0; i < TOTAL_FILES; i++) {
  const hasHit = i < HIT_COUNT;
  const body = hasHit
    ? `# Note ${i}\n\n${lorem}\n\nThis note contains ${QUERY} somewhere in the middle.\n\n${lorem}`
    : `# Note ${i}\n\n${lorem}`;
  await fs.writeFile(path.join(tmpDir, `note-${i}.md`), body, "utf-8");
}
console.log(`   ✓ ${TOTAL_FILES} files written\n`);

// ---------------------------------------------------------------------------
// Import server internals (ESM dynamic import from built dist)
// ---------------------------------------------------------------------------
const distRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
let VaultRegistry, LRUFileCache, AuditLog, ToolRegistry, registerAll, DEFAULT_CONFIG, Permissions, DEFAULT_PERMISSIONS;
try {
  ({ VaultRegistry } = await import(`${distRoot}/vault/registry.js`));
  ({ LRUFileCache } = await import(`${distRoot}/cache/file-cache.js`));
  ({ AuditLog } = await import(`${distRoot}/audit/log.js`));
  ({ ToolRegistry } = await import(`${distRoot}/handlers/registry.js`));
  ({ registerAll } = await import(`${distRoot}/tools/index.js`));
  ({ DEFAULT_CONFIG } = await import(`${distRoot}/config.js`));
  ({ Permissions, DEFAULT_PERMISSIONS } = await import(`${distRoot}/vault/permissions.js`));
} catch (e) {
  console.error(`\n❌  Could not import from ${distRoot}. Run 'npm run build' first.\n`);
  console.error(e.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeCtx(cache) {
  const vaultReg = new VaultRegistry([{ name: "bench", root: tmpDir }]);
  const vault = vaultReg.resolve(undefined);
  const audit = new AuditLog(tmpDir);
  const perms = new Permissions(DEFAULT_PERMISSIONS);
  const reg = new ToolRegistry();
  registerAll(reg);
  return {
    ctx: {
      vault,
      perms,
      cache,
      audit,
      registry: vaultReg,
      clientId: "bench",
      config: DEFAULT_CONFIG,
      signal: new AbortController().signal,
    },
    reg,
  };
}

async function runSearch(reg, ctx) {
  const result = await reg.invoke("search.content", { query: QUERY, limit: 1000, offset: 0 }, ctx);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.result;
}

async function timedRuns(label, ctxFactory, runs) {
  const times = [];
  let lastResult;
  for (let r = 0; r < runs; r++) {
    const { ctx, reg } = ctxFactory();
    const t0 = performance.now();
    lastResult = await runSearch(reg, ctx);
    const t1 = performance.now();
    times.push(t1 - t0);
    process.stdout.write(`   ${label} run ${r + 1}/${runs}: ${(t1 - t0).toFixed(0)} ms\n`);
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);
  return { avg, min, max, hits: lastResult.hits?.length ?? 0, total: lastResult.total ?? 0 };
}

// ---------------------------------------------------------------------------
// Cold cache runs (new LRU each run)
// ---------------------------------------------------------------------------
console.log(`⏱   Cold cache (new LRU each run):`);
const cold = await timedRuns("cold", () => {
  const cache = new LRUFileCache();
  return makeCtx(cache);
}, RUNS);

// ---------------------------------------------------------------------------
// Warm cache runs (same LRU reused across runs)
// ---------------------------------------------------------------------------
console.log(`\n⏱   Warm cache (same LRU reused):`);
const sharedCache = new LRUFileCache();
// Prime the cache with one un-timed run
{
  const { ctx, reg } = makeCtx(sharedCache);
  await runSearch(reg, ctx);
}
const warm = await timedRuns("warm", () => makeCtx(sharedCache), RUNS);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log(`
┌─────────────────────────────────────────────────────────┐
│  search.content benchmark results                       │
├────────────┬──────────┬──────────┬──────────┬───────────┤
│  Mode      │  avg ms  │  min ms  │  max ms  │  hits     │
├────────────┼──────────┼──────────┼──────────┼───────────┤
│  cold      │  ${cold.avg.toFixed(0).padStart(6)}  │  ${cold.min.toFixed(0).padStart(6)}  │  ${cold.max.toFixed(0).padStart(6)}  │  ${String(cold.hits).padStart(7)}  │
│  warm      │  ${warm.avg.toFixed(0).padStart(6)}  │  ${warm.min.toFixed(0).padStart(6)}  │  ${warm.max.toFixed(0).padStart(6)}  │  ${String(warm.hits).padStart(7)}  │
└────────────┴──────────┴──────────┴──────────┴───────────┘

  Vault: ${TOTAL_FILES} files · ${HIT_COUNT} hits (${(HIT_RATE * 100).toFixed(0)}% hit rate)
  Pre-filter skips mdast parse for ${TOTAL_FILES - HIT_COUNT} files (${((1 - HIT_RATE) * 100).toFixed(0)}% of vault).
  Cold→warm speedup: ${(cold.avg / warm.avg).toFixed(1)}×

  Tip: raise --files and lower --hit-rate for a more dramatic pre-filter win.
       e.g.  node scripts/benchmark-search.mjs --files 500 --hit-rate 0.05
`);

await fs.rm(tmpDir, { recursive: true, force: true });
