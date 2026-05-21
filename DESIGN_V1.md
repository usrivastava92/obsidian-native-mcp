# obsidian-native-mcp — v1.0 Design Document

> **Status:** Canonical plan. Re-read this file before resuming work.
> **Audience:** Future maintainers + any AI coding agent picking up the build.
> **Decision authority:** Anything contradicting this doc is wrong unless this doc is updated first.

---

## 0. North Star

Build a **correct, surgically-editable, LLM-context-efficient** MCP server for Obsidian
vaults.

Three non-negotiables, in priority order:

1. **Correctness.** No tool ever silently corrupts data. Structural operations are
   AST-aware. Frontmatter goes through a real YAML library. Concurrent edits are
   detected via hash preconditions.
2. **LLM efficiency.** Writes are surgical by default. Whole-file rewrites exist
   but are an explicit, documented-heavy escape hatch. Reads return hashes so the
   next edit can be tiny.
3. **Honest scope.** Reads are first-class at any size (AGENTS.md, rules,
   guidelines must "just work"). Writes are surgical-first.

---

## 1. Architecture

```
src/
  cli/
    index.ts                   # stdio entry; reads config; --read-only flag

  plugin/
    main.ts                    # Obsidian Plugin entry
    settings.ts                # Vault picker + token + read-only toggle + per-tool toggles

  mcp/
    framing.ts                 # Content-Length framing (encode/decode)
    protocol.ts                # JSON-RPC types
    server.ts                  # Factory: createServer(deps) → {tools, handleRequest}
    transport.ts               # Transport interface
    stdio.ts                   # Stdio impl (uses framing — honestly)
    http.ts                    # HTTP/SSE: bearer token, origin allowlist, body cap, session TTL

  vault/
    registry.ts                # VaultRegistry (env + config file + Obsidian discovery)
    permissions.ts             # Read-only mode, per-tool toggles, per-vault subdir allow/deny

  fs/
    io.ts                      # readText, writeTextAtomic, ensureDir, fileExists
    walk.ts                    # Async walker with ignores, depth control
    trash.ts                   # Obsidian-compatible <vault>/.obsidian/trash with unique naming
    paths.ts                   # resolveVaultPath, traversal guards

  markdown/
    parse.ts                   # mdast parse (GFM + frontmatter + wikilink plugin)
    serialize.ts               # mdast → markdown (round-trip safe)
    fingerprint.ts             # sha256 helpers: contentHash, rangeHash, sectionHash, blockHash
    outline.ts                 # buildOutline(parsed) → heading tree
    headings.ts                # findAll, sectionBounds, rename, replaceBody
    blocks.ts                  # find, replace (prefix-preserving), rename
    links.ts                   # typed extraction (wiki/embed/header/block/md/aliased)
    tags.ts                    # fence-aware tag extraction
    frontmatter.ts             # yaml-lib backed get/set/delete with nested keys

  search/
    query.ts                   # DSL parser: tag:, path:, field:, "phrase", AND/OR/NOT, since:
    execute.ts                 # Query → paginated results with snippets + per-line hashes

  cache/
    file-cache.ts              # LRUCache<filePath, ParsedFile> with mtime+size invalidation
    index.ts                   # IIndex interface (Design B now; Design C swap-in later)

  audit/
    log.ts                     # JSONL audit append; size-based rotation

  handlers/
    register.ts                # Declarative tool registry; permission gating; error envelope
    args.ts                    # Per-tool discriminated-union arg parsing

  tools/
    read/*.ts                  # One file per read tool
    write/*.ts                 # One file per write tool

  utils/
    log.ts                     # Structured stderr logger (already good)
    types.ts                   # Shared TS types
```

---

## 2. Dependencies (Honest List)

Runtime:

| Dep                                            | Purpose                                                  | Approx size |
| ---------------------------------------------- | -------------------------------------------------------- | ----------- |
| `mdast-util-from-markdown`                     | Parse markdown → mdast                                   | ~150KB      |
| `mdast-util-to-markdown`                       | mdast → markdown (round-trip safe)                       | ~120KB      |
| `mdast-util-gfm`                               | Tables, task lists, strikethrough, autolinks             | ~80KB       |
| `mdast-util-frontmatter`                       | Frontmatter as AST node                                  | ~10KB       |
| `micromark-extension-wiki-link` (+ mdast util) | `[[wikilinks]]` + `![[embeds]]`                          | ~30KB       |
| `yaml`                                         | Frontmatter read/write (block scalars, nested, comments) | ~250KB      |
| `picomatch`                                    | Glob support in `file.list`, `file.find`, allow/deny     | ~60KB       |

Dev only: `esbuild`, `typescript`, `eslint`, `prettier`, `husky`, `lint-staged`,
`semantic-release`, `tsx`, `obsidian` (types), `@types/node`.

README will read:

> Minimal, auditable runtime dependencies: a small set of well-known packages
> for markdown AST (`mdast`), YAML (`yaml`), and globs (`picomatch`). MCP
> framing and transport are implemented from scratch — zero MCP-layer
> dependencies.

---

## 3. Core Type Contract

```ts
// src/utils/types.ts

export type Hash = string; // "sha256:<hex>"
export type Vault = string; // vault name
export type RelPath = string; // path relative to vault root, POSIX-style

export interface ParsedFile {
  path: RelPath;
  text: string; // canonicalised: BOM stripped, EOL = "\n"
  contentHash: Hash;
  mtimeMs: number;
  size: number;
  ast: import("mdast").Root;
  lineOffsets: number[]; // index i = byte offset of line (i+1)
  headings: HeadingInfo[];
  blocks: BlockInfo[];
  links: ExtractedLink[];
  tags: string[];
  frontmatter?: ParsedFrontmatter;
}

export interface HeadingInfo {
  id: string; // "h-1", "h-2", ... stable for this parse
  path: string; // e.g. "Tasks::Backlog::P0"
  level: 1 | 2 | 3 | 4 | 5 | 6;
  line: number;
  endLine: number;
  sectionHash: Hash; // hash of the bytes belonging to this section
  childrenCount: number;
  duplicateOf?: string[]; // other heading ids with same path, if any
}

export interface BlockInfo {
  id: string; // "^foo"
  line: number;
  blockHash: Hash; // hash of the entire structural block
  structuralType: "paragraph" | "list-item" | "table-row" | "callout" | "code" | "other";
}

export type ExtractedLink =
  | { kind: "wiki"; target: string; alias?: string; line: number; col: number }
  | { kind: "embed"; target: string; alias?: string; line: number; col: number }
  | { kind: "header-ref"; target: string; heading: string; line: number; col: number }
  | { kind: "block-ref"; target: string; blockId: string; line: number; col: number }
  | { kind: "markdown"; text: string; url: string; line: number; col: number };

export interface ParsedFrontmatter {
  raw: string; // original yaml text
  data: Record<string, unknown>; // parsed
  comments?: string[]; // preserved where lib allows
}

export type ToolError =
  | { code: "NOT_FOUND"; message: string; details?: any }
  | {
      code: "DUPLICATE_TARGET";
      message: string;
      matches: Array<{ id: string; line: number; path?: string }>;
    }
  | { code: "STALE_PRECONDITION"; message: string; expected: Hash; actual: Hash; refreshHint?: any }
  | { code: "PERMISSION_DENIED"; message: string; tool: string }
  | { code: "INVALID_ARGS"; message: string; details?: any }
  | { code: "DESTINATION_EXISTS"; message: string; path: RelPath }
  | { code: "IO_ERROR"; message: string }
  | { code: "PARSE_ERROR"; message: string; line?: number; col?: number }
  | { code: "INTERNAL"; message: string };
```

---

## 4. Hash Algorithms (canonical)

All hashes are `sha256:<hex>`. Inputs are **canonicalised** before hashing so that
hash equality is exactly the equivalence relation we want:

- Strip UTF-8 BOM.
- Normalise line endings to `\n` (CRLF, CR → LF).
- No trailing newline normalisation: we hash the canonicalised bytes verbatim.
  (`writeTextFileAtomic` preserves whatever the caller wrote.)

| Hash                        | Input                                                                                                     |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| `contentHash`               | Canonicalised file bytes                                                                                  |
| `rangeHash(file, from, to)` | Canonicalised bytes of lines `from..to` inclusive                                                         |
| `sectionHash(heading)`      | Bytes of `from = heading line` to `to = endLine` inclusive                                                |
| `blockHash(block)`          | Bytes of the structural block (entire paragraph / list item / table row / etc., not just the marker line) |
| `frontmatterHash`           | Canonicalised raw frontmatter text including delimiters                                                   |

Server is the **sole** producer of hashes. Clients echo what they were given.

---

## 5. Precondition Model

Tools fall into four precondition categories:

| Category                | Tools                                                                                                                                                  | Precondition                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| **Hash-required**       | `file.replace`, `lines.replace`, `heading.replace_body`, `block.replace`, `frontmatter.set`, `frontmatter.delete`, `regex.replace`, hard `file.delete` | Caller MUST supply the matching `expected_*_hash`. Mismatch → `STALE_PRECONDITION` with current hash.                 |
| **Hash-optional**       | `str_replace`, `apply_patch`, `apply_edits`                                                                                                            | `find`/diff context lines act as content preconditions. `expected_content_hash` accepted as belt-and-suspenders.      |
| **Hash-not-applicable** | `file.append`, `file.create`, `file.move` (`on_conflict: error`), all read tools                                                                       | No content precondition required (or N/A).                                                                            |
| **Two-step**            | `regex.replace`                                                                                                                                        | Step 1 MUST be `dry_run: true` and returns a `proposal_token`; step 2 supplies the token AND `expected_content_hash`. |

`STALE_PRECONDITION` response always includes the **current** hash so the LLM
can refresh just the affected range and retry without an extra round trip.

---

## 6. Tool Reference

Naming convention: dotted noun-verb (`heading.replace_body`, `file.read_range`).
Tool names are the JSON-RPC `name` values for `tools/call`.

### 6.1 Read tools (no write permission needed)

| Tool                      | Args                                                                                          | Returns                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `vault.list`              | `{}`                                                                                          | `{ vaults: [{name, path, fileCount?}] }`                                                          |
| `vault.info`              | `{ vault? }`                                                                                  | `{ name, path, fileCount, sizeBytes }`                                                            |
| `file.list`               | `{ vault?, directory?, recursive?, glob?, limit?, offset?, sort? }`                           | `{ entries: [{path, type, sizeBytes, mtimeMs}], total, nextOffset? }`                             |
| `file.find`               | `{ vault?, query, mode: "exact"\|"substring"\|"glob"\|"regex", directory?, limit?, offset? }` | `{ matches: [{path, why}], total, nextOffset? }`                                                  |
| `file.read`               | `{ vault?, file, format?: "markdown"\|"json" }`                                               | `{ file, content, contentHash, totalLines, frontmatter? }`                                        |
| `file.read_range`         | `{ vault?, file, from, to }`                                                                  | `{ file, from, to, lines, rangeHash, contentHash, totalLines }`                                   |
| `file.head` / `file.tail` | `{ vault?, file, lines?: int }`                                                               | `{ file, lines, contentHash, totalLines }`                                                        |
| `outline`                 | `{ vault?, file, maxDepth? }`                                                                 | `{ file, contentHash, totalLines, headings: HeadingInfo[] }`                                      |
| `heading.find`            | `{ vault?, file, heading, delimiter?: "::" }`                                                 | `{ matches: HeadingInfo[], contentHash }` (returns ALL matches)                                   |
| `block.find`              | `{ vault?, file, blockId }`                                                                   | `{ matches: BlockInfo[], contentHash }`                                                           |
| `frontmatter.get`         | `{ vault?, file, keyPath? }`                                                                  | `{ data, frontmatterHash, contentHash }`                                                          |
| `tags.list`               | `{ vault?, file?, prefix? }`                                                                  | `{ tags: [{tag, count, files?}] }`                                                                |
| `links.get`               | `{ vault?, file, direction: "backlinks"\|"outlinks"\|"both" }`                                | `{ backlinks: LinkRecord[], outlinks: LinkRecord[] }`                                             |
| `metadata.read`           | `{ vault?, file }`                                                                            | `{ file, contentHash, frontmatter, headings, tags, aliases, counts }`                             |
| `search.content`          | `{ vault?, query, directory?, limit?, offset?, contextLines? }`                               | `{ hits: [{file, line, lineHash, snippet, before[], after[], contentHash}], total, nextOffset? }` |
| `file.diff`               | `{ vault?, file, fromHash, toHash? }`                                                         | `{ unifiedDiff, fromHash, toHash }` (toHash defaults to current)                                  |
| `prompts.list`            | `{ vault? }`                                                                                  | `{ prompts: [{name, description, arguments?[]}] }`                                                |
| `prompts.get`             | `{ name, vault?, arguments? }`                                                                | `{ description, messages }` (Templater args substituted)                                          |

### 6.2 Write tools (write permission required)

**Surgical primaries (the workhorses):**

| Tool          | Args                                                                                                   | Notes                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `str_replace` | `{ vault?, file, find, replace, occurrence?: "unique"\|int\|"all", expected_content_hash?, dry_run? }` | Default `occurrence: "unique"` → errors if `find` not unique.   |
| `apply_patch` | `{ vault?, file, patch, expected_content_hash?, dry_run? }`                                            | Unified-diff format. Validates context lines verbatim per hunk. |
| `apply_edits` | `{ vault?, file, edits: [{find, replace, occurrence?}, ...], expected_content_hash?, dry_run? }`       | Single read, single write, atomic in memory.                    |

**Structural (use returned `*_hash` from a `find`/`outline` call):**

| Tool                   | Args                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `heading.replace_body` | `{ vault?, file, heading, expected_section_hash, content, delimiter?, dry_run? }`  |
| `heading.rename`       | `{ vault?, file, heading, newText, expected_section_hash, updateRefs?, dry_run? }` |
| `block.replace`        | `{ vault?, file, blockId, expected_block_hash, content, dry_run? }`                |
| `block.rename`         | `{ vault?, file, blockId, newId, expected_block_hash, updateRefs?, dry_run? }`     |
| `lines.replace`        | `{ vault?, file, from, to, content, expected_range_hash, dry_run? }`               |
| `lines.insert`         | `{ vault?, file, line, content, dry_run? }`                                        |
| `frontmatter.set`      | `{ vault?, file, keyPath, value, expected_frontmatter_hash, dry_run? }`            |
| `frontmatter.delete`   | `{ vault?, file, keyPath, expected_frontmatter_hash, dry_run? }`                   |

**Whole-file / metadata:**

| Tool           | Args                                                                                          | Notes                                                                                                                                             |
| -------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file.create`  | `{ vault?, file, content }`                                                                   | **Create-only**. Errors if exists.                                                                                                                |
| `file.replace` | `{ vault?, file, content, expected_content_hash?, create_if_missing?, dry_run? }`             | Description explicitly says "prefer surgical tools". `expected_content_hash` required unless `create_if_missing` is true and file does not exist. |
| `file.append`  | `{ vault?, file, content, ensureTrailingNewline?, dry_run? }`                                 |
| `file.move`    | `{ vault?, from, to, on_conflict?: "error"\|"overwrite"\|"rename", update_links?, dry_run? }` | Default `on_conflict: "error"`.                                                                                                                   |
| `file.delete`  | `{ vault?, file, trash?: bool, expected_content_hash?, dry_run? }`                            | `trash: true` → `<vault>/.obsidian/trash`. Hard delete requires `expected_content_hash`.                                                          |

**Batch + power:**

| Tool            | Args                                                                                             | Notes                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bulk.apply`    | `{ vault?, ops: [{tool, args}, ...], atomic?: bool, dry_run? }`                                  | Real atomic: snapshot all → apply all in memory → write all → rollback any on failure.                                                            |
| `regex.replace` | `{ vault?, file, pattern, replacement, flags?, count?, expected_content_hash, proposal_token? }` | **Two-step**: first call must be `dry_run: true` and returns `proposal_token`; second call supplies the token + matching `expected_content_hash`. |

### 6.3 Removed tools

Removed without shim (pre-1.0, no users to migrate):

- `patch_file` — split into `str_replace`, `apply_patch`, `heading.replace_body`, `block.replace`, `frontmatter.set/delete`, `lines.replace`.
- `replace_section` — folded into `heading.replace_body` (no fabrication).
- `create_file`-as-overwrite — `file.create` is create-only; use `file.replace`.
- `search` (renamed to `search.content` with DSL).

---

## 7. Permission Model

Three orthogonal axes:

1. **Server-level read-only mode.** CLI flag `--read-only`, plugin setting toggle.
   When on, all `requiresWrite: true` tools return `PERMISSION_DENIED`.
2. **Per-tool enable/disable.** Plugin settings expose every tool with a
   checkbox. Server config (`~/.config/obsidian-native-mcp/permissions.json`)
   for CLI. Disabled tools are absent from `tools/list`.
3. **Per-vault subdir allow/deny.** Optional `allow_paths: [glob,...]`,
   `deny_paths: [glob,...]` per vault. Checked at every path resolution.

---

## 8. Concurrency / Atomicity

- Single-file writes: always `writeTextFileAtomic` (temp file + rename).
- `apply_edits`: read once, all edits applied in memory, single atomic write.
- `bulk.apply`:
  - Snapshot every affected file's text + hash in memory.
  - Apply every op against in-memory state; abort on first failure.
  - On full success: write each file atomically in order.
  - On failure: nothing has been written yet — return errors per op.
  - Documented as "process-atomic" — not crash-atomic across files.
- Hash preconditions are the cross-process concurrency guard. There is no
  vault-wide lock.

---

## 9. Audit Log

`<vault>/.obsidian/plugins/obsidian-native-mcp/audit.log` — JSONL. One line per
mutating tool call:

```json
{
  "ts": "2026-05-21T13:45:12.000Z",
  "tool": "str_replace",
  "vault": "personal",
  "file": "Daily/2026-05-21.md",
  "args_hash": "sha256:...",
  "before_hash": "sha256:...",
  "after_hash": "sha256:...",
  "dry_run": false,
  "client_id": "session-7f3c..."
}
```

- No raw args logged (avoids leaking sensitive note bodies).
- Rotation: when file size > 10 MB, rename to `audit.log.1` (keep 5 rotations).
- Read-only mode and dry-runs still log (with `dry_run: true`) for visibility.

---

## 10. Transports

### 10.1 Stdio

- Real Content-Length framing both directions.
- Stream parser tolerates partial reads and concatenated messages.
- stderr for logs; stdout reserved for JSON-RPC.

### 10.2 HTTP/SSE

- `GET /sse?token=<bearer>` → SSE stream; `event: endpoint` carries
  `/message?session_id=<sid>&token=<bearer>`.
- `POST /message` requires:
  - Matching bearer token.
  - `Origin` header in allowlist (default: empty/none/`null`/loopback).
  - Body ≤ 5 MB.
- Session limits: max 16 concurrent SSE sessions; idle timeout 5 min; heartbeat
  every 30 s.
- `GET /healthz` → `{ ok: true, version, vaults, readOnly }`.
- Token regeneration via plugin settings ("Rotate token" button).
- CORS: only configured origins; never `*`.

---

## 11. Caching (Design B)

```ts
class LRUFileIndex implements IIndex {
  private cache = new Map<RelPath, ParsedFile>(); // simple LRU
  private maxEntries = 256;

  async getFile(absPath: string): Promise<ParsedFile> {
    const stat = await fs.stat(absPath);
    const cached = this.cache.get(absPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      this.touch(absPath);
      return cached;
    }
    const text = await fs.readFile(absPath, "utf-8");
    const parsed = parseMarkdown(absPath, text, stat);
    this.put(absPath, parsed);
    return parsed;
  }

  invalidate(absPath: string): void {
    this.cache.delete(absPath);
  }
  refreshAfterWrite(absPath: string, text: string, stat: Stats): void {
    this.put(absPath, parseMarkdown(absPath, text, stat));
  }
}
```

After any successful write, refresh the cache entry inline using the post-write
text already in memory (avoid a re-parse from disk).

The `IIndex` interface keeps the seam open to swap to a watched, vault-wide
index later (Design C) without changing tool code.

---

## 12. Test Strategy

### 12.1 Fixtures (`tests/fixtures/vaults/`)

`tiny`, `agents` (~250 LoC), `daily-note`, `large-kb` (~5,000 LoC),
`code-heavy`, `frontmatter-stress`, `links-zoo`, `dup-headings`, `setext`,
`bom-crlf`, `unicode`, `huge-line`, `pathological-fm`, `obsidian-features`.

Each fixture has a sibling `EXPECTED.md` documenting what's deliberately weird
about it.

### 12.2 Test layers

1. **Unit tests** — `tests/unit/<module>/*.test.ts` — small, fast, one concern
   each.
2. **Integration tests** — `tests/integration/tools/<tool>.test.ts` — happy
   path, missing target, duplicate target, dry-run, hash mismatch, permission
   denied, audit-log entry.
3. **Property tests** — invariants over fixtures + fuzzed inputs:
   - parse-serialize round-trip preserves AST equivalence;
   - hash is deterministic for canonical input;
   - surgical edits don't change unaffected files' hashes;
   - bulk-apply rollback leaves every file byte-identical to pre-state.
4. **Scenario tests** — `tests/scenarios/S*.test.ts` — long multi-step flows
   listed in §12.3.
5. **E2E** — spawn CLI subprocess, full JSON-RPC roundtrip; mock-Obsidian
   plugin load + HTTP roundtrip.

### 12.3 Required scenarios

S1 mark-tasks-done · S2 refactor-section · S3 rename-heading-update-refs ·
S4 concurrent-human-edit-conflict · S5 concurrent-unrelated-edit-no-conflict ·
S6 giant-file-outline-perf · S7 giant-file-surgical-edit-cost ·
S8 bulk-atomic-rollback · S9 frontmatter-nested-set · S10 code-fence-safety ·
S11 no-fabrication-on-missing-heading · S12 apply-patch-context-validation ·
S13 large-vault-search-pagination · S14 edit-then-diff-roundtrip ·
S15 context-byte-budget-v0-vs-v1.

### 12.4 CI

Matrix: `{ubuntu, macos, windows} × {Node 20, 22}`.

Coverage gate (c8): fail CI if `src/{markdown,fs,tools,mcp,cache}/*` line
coverage < 85% or branch coverage < 80%.

---

## 13. Plugin Settings UI

- Per-vault enable toggle (unchanged).
- Display server URL with bearer token; copy button.
- "Rotate token" button.
- "Read-only mode" toggle.
- Collapsible per-tool enable list (defaults all on except `regex.replace` off).
- Optional per-vault `allow_paths`/`deny_paths` text fields.
- Audit log tail viewer (last 100 entries, copy-to-clipboard).
- "Test connection" button — issues `initialize` to its own server.

---

## 14. CLI Surface

```
obsidian-native-mcp [--read-only] [--config <path>] [--vault <name=path>]...
```

Config resolution order: `--vault` flags → `--config` JSON → `$OBSIDIAN_VAULT_PATHS` env → `~/.config/obsidian-native-mcp/vaults.json` → Obsidian auto-discovery.

---

## 15. Build Order (executable plan)

Each step is a green-tests-required gate.

1. Design freeze → this document committed.
2. `package.json` updates: add `mdast-util-from-markdown`,
   `mdast-util-to-markdown`, `mdast-util-gfm`, `mdast-util-frontmatter`,
   `micromark-extension-wiki-link`, `mdast-util-wiki-link`, `yaml`,
   `picomatch`. Move `obsidian` to peerDep where it isn't already.
3. `src/utils/types.ts` + `src/markdown/fingerprint.ts` (pure, no deps).
4. `src/markdown/parse.ts` + `serialize.ts` (mdast wiring + plugin set).
5. `src/markdown/frontmatter.ts` (yaml-lib wrapper) → unit tests vs
   `frontmatter-stress` fixture.
6. `src/markdown/headings.ts`, `blocks.ts`, `links.ts`, `tags.ts`,
   `outline.ts` → unit tests vs `code-heavy`, `dup-headings`, `setext`,
   `links-zoo`.
7. `src/fs/{io,walk,trash,paths}.ts` async + traversal-safe.
8. `src/cache/file-cache.ts` (Design B) + invariants.
9. `src/audit/log.ts`.
10. `src/vault/{registry,permissions}.ts` + tests for cross-platform discovery.
11. `src/mcp/{framing,protocol,server,transport,stdio,http}.ts` with token /
    origin / size-cap / SSE session limits.
12. `src/handlers/{register,args}.ts` declarative tool registry + error envelope.
13. `src/tools/read/*` — implement all read tools; integration tests each.
14. `src/tools/write/*` — implement write tools in this order:
    `file.create`, `file.append`, `file.replace`, `file.move`, `file.delete`,
    `lines.replace`, `lines.insert`, `str_replace`, `apply_edits`,
    `apply_patch`, `heading.replace_body`, `heading.rename`, `block.replace`,
    `block.rename`, `frontmatter.set`, `frontmatter.delete`, `regex.replace`,
    `bulk.apply`.
15. Wire `src/cli/index.ts` and `src/plugin/{main,settings}.ts` to the new
    server.
16. Build fixtures + property + scenario tests; achieve coverage gates.
17. Cross-platform CI matrix + coverage reporting.
18. Rewrite `README.md`, `DEVELOPER.md`; write `BREAKING.md` (v0 → v1 tool
    migration table).
19. Bump to `1.0.0`; semantic-release ships it.

---

## 16. Non-Goals for v1.0

- Local semantic search (post-1.0 feature, requires optional dep, separate package).
- File-watcher-backed full vault index (post-1.0 — `IIndex` seam is ready).
- Mobile (Obsidian iOS/Android) — `isDesktopOnly: true` stays.
- Multi-user / OAuth — local-loopback only.
- Real-time push notifications to MCP clients beyond standard MCP semantics.

---

## 17. Versioning Policy

- Pre-1.0: no backward compatibility promises (we're cutting clean now).
- 1.0+: semantic versioning. Tool schema changes are SemVer-breaking unless
  additive (new optional fields).

---

## 18. Definition of Done for v1.0

A release qualifies as v1.0 only if **all** of:

- [ ] Every tool in §6 implemented, schema-validated, with integration tests.
- [ ] Every scenario in §12.3 green on all CI matrix cells.
- [ ] Coverage gates met on the targeted modules.
- [ ] No `any` in tool argument or result types.
- [ ] Stdio transport actually emits Content-Length framing (lint-style test
      asserts this).
- [ ] HTTP transport rejects: missing token, wrong token, disallowed Origin,
      body > 5 MB.
- [ ] Bulk-atomic scenario S8 demonstrates byte-identical rollback.
- [ ] Scenario S15 demonstrates ≥ 5× context-byte reduction vs v0.x on a
      recorded edit session.
- [ ] README + DEVELOPER.md + BREAKING.md reflect v1.0 reality.
- [ ] `npm run lint && npm run format:check && npm test && npm run check &&
    npm run build && npm run build:plugin` all green.

---

## 19. Open Decisions (deferred but tracked)

- Whether `outline` should accept `maxDepth` filtering server-side (likely yes).
- Whether `search.content` should return `lineHash` for every snippet (cost:
  one sha per snippet; benefit: surgical fixup paths).
- Whether to expose a `cache.stats` admin tool for debugging.
- Whether `apply_patch` should accept GitHub-style `diff --git` headers or only
  raw hunks.

These are recorded so they don't get forgotten; default = yes for the first
three, raw hunks only for the last.
