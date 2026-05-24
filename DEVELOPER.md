# Developer Guide

Engineering reference for **obsidian-native-mcp v1.0**. For the user-facing tool surface, see `README.md`. For design rationale and invariants, see `DESIGN_V1.md`.

## Architecture

```
src/
  cli/index.ts           # CLI entry — reads config, starts stdio transport
  plugin/
    main.ts              # Obsidian plugin entry (extends Plugin)
    settings.ts          # Settings tab: vault picker, token, per-tool toggles, audit viewer
  mcp/
    framing.ts           # Content-Length framing (encode + buffered decode)
    protocol.ts          # JSON-RPC 2.0 types + standard error codes
    transport.ts         # Transport interface
    stdio.ts             # Stdio transport (CLI)
    http.ts              # HTTP/SSE transport with bearer token, origin allowlist,
                         #   body cap, max-sessions, idle TTL, heartbeat, /healthz
    server.ts            # createServer() factory — transport-agnostic request router
  handlers/
    registry.ts          # Declarative tool registry (no boilerplate per tool)
    args.ts              # Typed argument parsers per tool kind
  tools/
    common.ts            # Shared types: ToolContext, ToolResult envelope
    read.ts              # 14 read tools
    write-basic.ts       # file.create, file.replace, file.append, file.move, file.delete
    write-surgical.ts    # str_replace, apply_edits, lines.replace, lines.insert
    write-structural.ts  # heading.*, block.*, frontmatter.set/delete
    write-patch.ts       # apply_patch (unified diff parser)
    write-bulk.ts        # bulk.apply (atomic), regex.replace (proposal-token)
    index.ts             # Aggregate registry of all tools
  prompts/
    provider.ts          # Vault Prompts/ scanner + Templater-style arg parser
  markdown/
    parse.ts             # mdast parsing (gfm + frontmatter, no broken wiki-link dep)
    parse-file.ts        # Glue: text → ParsedFile (ast + headings + blocks + links + tags + frontmatter + hashes)
    fingerprint.ts       # Canonical normalization + sha256 helpers, lineOffsets
    headings.ts          # AST-aware heading extraction, section bounds, disambiguation
    blocks.ts            # ^block-id extraction with structural-type classification
    links.ts             # Typed link extraction (wiki/embed/header/block/markdown) — fence-blind
    tags.ts              # Tag extraction — fence-blind, URL-fragment-blind
    frontmatter.ts       # YAML-backed nested get/set/delete preserving formatting
    outline.ts           # Skeleton derivation from HeadingInfo
  cache/
    file-cache.ts        # LRU<path, ParsedFile> with mtime+size invalidation, write-through
  fs/
    io.ts                # readText, writeTextAtomic, ensureDir, uniquePath, fileExists
    walk.ts              # Async recursive walker with ignore patterns
    trash.ts             # <vault>/.obsidian/trash/ move with structure preserved
    paths.ts             # Path-traversal guard, posix/native normalization
  vault/
    registry.ts          # VaultRegistry: env + config file + Obsidian auto-discovery
    permissions.ts       # Read-only mode, per-tool toggle, per-vault subdir rules
  audit/
    log.ts               # JSONL audit log + sha256 args hashing + 5MB rotation
  utils/
    types.ts             # Canonical types: ParsedFile, HeadingInfo, BlockInfo, ExtractedLink, ToolError, etc.
    log.ts               # Structured stderr logger (key=value)
```

### Layering rules

1. `markdown/` and `fs/` are leaf modules — no dependencies on `tools/`, `handlers/`, or `mcp/`.
2. `cache/` depends only on `markdown/` and `fs/`.
3. `tools/` depends on `markdown/`, `fs/`, `cache/`, `audit/`, `vault/` — never on `mcp/` or `handlers/`.
4. `handlers/` orchestrates `tools/` and wraps results into MCP responses.
5. `mcp/` knows nothing about tools — just transports and JSON-RPC.

### Key design decisions

- **Surgical-first edits.** `str_replace` / `apply_patch` / `apply_edits` are the workhorses. Whole-file `file.replace` is the documented escape hatch.
- **Hash-based concurrency.** Every read returns content hashes (file, range, section, block, frontmatter, line). Every write that targets an existing range requires the matching `expected_*_hash`. Stale precondition → structured `STALE_PRECONDITION` error with current hashes, never silent clobbering.
- **Server is source of truth for hashes.** Clients echo opaque strings the server gave them. We never trust client-computed hashes.
- **AST-aware everywhere.** mdast classifies code-fenced text as `code` nodes, HTML-commented blocks as `html` nodes — so heading/block/tag/link extractors get fence-safety _for free_.
- **Real YAML for frontmatter.** We use the `yaml` package for round-trip preserving nested get/set/delete. No more hand-rolled line matching.
- **Two transports, shared core.** `createServer()` returns `{handleRequest, toolDefinitions}`. Stdio and HTTP/SSE differ only in I/O layer.
- **Process-atomic bulk writes.** `bulk.apply` with `atomic: true` snapshots originals in memory, applies all ops, writes, and restores on any failure.

## Development workflow

```bash
npm install
npm run dev              # tsx watch on the CLI
npm run check            # tsc --noEmit
npm run lint             # eslint src/
npm run format           # prettier --write src/
npm test                 # node:test runner across tests/**/*.test.ts
npm run test:coverage    # c8 with --check-coverage thresholds
npm run build            # tsc → dist/
npm run build:plugin     # esbuild plugin bundle for Obsidian
```

### Testing the CLI manually

```bash
OBSIDIAN_VAULT_PATHS=/path/to/vault node dist/cli/index.js
```

Then pipe in Content-Length framed JSON-RPC requests on stdin. The `tests/helpers/sandbox.ts` helper does this programmatically for tests.

### Testing the Plugin

1. `npm run build:plugin`
2. Copy `dist/plugin/` to `<your-vault>/.obsidian/plugins/native-mcp/`
3. Reload Obsidian, enable in Community Plugins, open settings tab.

## Adding a new tool

1. Decide its layer: read-only, surgical write, structural write, whole-file write, or batch.
2. Add the implementation to the right file under `src/tools/` (`read.ts`, `write-surgical.ts`, etc.).
3. Export it via `src/tools/index.ts` so the aggregate registry picks it up.
4. Add an argument parser in `src/handlers/args.ts` if its shape doesn't fit an existing one.
5. Write tests:
   - **Unit** for any pure helper logic (`tests/unit/...`).
   - **Integration** for the tool itself (`tests/integration/<tool>.test.ts`).
   - **Scenario** if it changes a multi-step LLM flow (`tests/scenarios/...`).
6. Update the relevant table in `README.md` and the schema list in `src/tools/index.ts`.

### Tool contract checklist

- Reads must return hashes the corresponding write expects (`contentHash`, `rangeHash`, `sectionHash`, `blockHash`, `frontmatterHash`, `lineHash`).
- Writes that target existing ranges must accept `expected_*_hash` and return `STALE_PRECONDITION` on mismatch.
- Mutating tools must support `dry_run: true` returning the _would-be_ new hashes without touching disk.
- Errors must be `{ok: false, error: {code, message, ...details}}` — never throw across the JSON-RPC boundary.
- Every mutating tool appends one audit-log line via `AuditLog`.

## Test strategy

| Layer       | Location             | What                                                                                                                                                                                                                                                                                           |
| ----------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | `tests/unit/`        | Pure-function correctness for `markdown/`, `fingerprint`, `frontmatter`, `headings`                                                                                                                                                                                                            |
| Integration | `tests/integration/` | One file per tool family — permissions, blocks, apply_edits, audit, links, file-ops                                                                                                                                                                                                            |
| Scenario    | `tests/scenarios/`   | Multi-tool LLM flows: S1 mark-tasks-done, S2 refactor section, S4/S5 concurrency, S6/S7 large file, S8 bulk rollback, S9 nested frontmatter, S10 code-fence safety, S11 no-fabrication, S12 apply_patch validation, S13 search pagination, S14 read-write roundtrip, S15 byte-budget benchmark |
| Property    | (inline in unit)     | Round-trip and hash-stability invariants                                                                                                                                                                                                                                                       |

The headline benchmark (`S15`) asserts that a surgical workflow uses ≤ 30 % of the byte budget of the equivalent whole-file rewrite — that's the v1.0 thesis in test form.

### Fixtures

Under `tests/fixtures/vaults/`:

- `tiny/` — smoke
- `agents/` — realistic AGENTS.md shape
- `daily-note/` — task lists, headings, frontmatter
- `code-heavy/` — fenced code with heading- and tag-looking content inside (the single biggest historical bug source)
- `dup-headings/` — multiple `## Tasks` plus `### Tasks` for disambiguation tests
- `frontmatter-stress/` — block scalars, nested maps, similar key names
- `links-zoo/` — wiki, embed, header-ref, block-ref, aliased, markdown
- `large-kb/` — 5,500-line generated file for outline + search perf

Add more fixtures whenever you find a new edge class — the test suite rewards breadth.

## Release process

```bash
# Bump version in package.json + manifest.json (the prepare hook + sync-version.cjs keep them aligned)
npm run check && npm run lint && npm test && npm run build && npm run build:plugin
npm publish
gh release create vX.Y.Z --title "vX.Y.Z" --generate-notes
# Plugin: submit dist/plugin/ to https://github.com/obsidianmd/obsidian-releases
```

CI uses semantic-release on the `main` branch.

## Protocol reference

The server speaks standard MCP over stdio (CLI) or HTTP/SSE (plugin).

### Stdio framing

The CLI uses the official `@modelcontextprotocol/sdk` (`StdioServerTransport`), which as of v1.29.0 uses **newline-delimited JSON**:

```
Client → Server:  {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}\n
Server → Client:  {"jsonrpc":"2.0","id":1,"result":{...}}\n
```

Note: The MCP spec originally described Content-Length framing (LSP-style). The official SDK switched to newline-delimited JSON in recent versions. We follow the SDK — not our own framing implementation. `src/mcp/framing.ts` and `src/mcp/stdio.ts` are retained for the HTTP/SSE plugin transport but are not used by the CLI.

### HTTP/SSE

```
Client → Server:  GET /sse?token=<bearer> → SSE stream starts; first event is "endpoint" with the POST URL
Client → Server:  POST /message?session_id=<id> → JSON-RPC request (body capped at 5 MB)
Server → Client:  SSE event "message" with the JSON-RPC response
Server → Client:  Heartbeat events keep the connection alive; idle sessions are GC'd
```

`/healthz` returns `{ok: true, sessions: N, version: "X.Y.Z"}`.

### Supported methods

| Method                      | Purpose                                                |
| --------------------------- | ------------------------------------------------------ |
| `initialize`                | Protocol handshake                                     |
| `tools/list`                | List available tools (filtered by current permissions) |
| `tools/call`                | Execute a tool                                         |
| `prompts/list`              | List available prompts (from vault Prompts/ folders)   |
| `prompts/get`               | Get prompt content with arguments substituted          |
| `notifications/initialized` | Client-ready notification                              |

## Logs and auditing

- **Stderr logs** are key=value structured (`component=http session=abc msg="…"`), safe to ship to journald, OpsAgent, etc.
- **Audit log** is JSONL at `<vault>/.obsidian/plugins/native-mcp/audit.log`, one line per mutating call. Use it for forensic analysis and regression replays.

## See also

- `DESIGN_V1.md` — design rationale, invariants, tool surface, and roadmap.
