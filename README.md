<div align="center">

<img src="assets/banner.png" alt="Obsidian Native MCP banner" width="800" />

**LLM-optimized MCP server for Obsidian vaults**
Surgical edits, hash-based concurrency safety, no whole-file rewrites.

[![Build](https://img.shields.io/github/actions/workflow/status/usrivastava92/obsidian-native-mcp/ci.yml?branch=main&label=CI&logo=github)](https://github.com/usrivastava92/obsidian-native-mcp/actions)
[![Release](https://img.shields.io/github/v/release/usrivastava92/obsidian-native-mcp?logo=semanticrelease)](https://github.com/usrivastava92/obsidian-native-mcp/releases)
[![npm](https://img.shields.io/npm/v/obsidian-native-mcp?logo=npm)](https://www.npmjs.com/package/obsidian-native-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI assistants (Claude Desktop, Cursor, Rovo Dev, etc.) direct, safe, **context-efficient** access to your Obsidian vaults.

**Two ways to use it:**

- **Obsidian plugin** — 1-click install, auto-discovers vaults, settings UI for per-tool toggles, runs inside Obsidian over HTTP/SSE with a bearer token.
- **CLI** — standalone Node binary, configured via env var or config file, speaks JSON-RPC over stdio with Content-Length framing.

## Why Obsidian Native MCP

The defining design goal is **minimize how many bytes the LLM has to push around per edit.** Every read returns content **plus cryptographic hashes**; every write declares the precondition hash it expects. The result: most edits become tiny `str_replace`s or unified-diff patches instead of full file rewrites.

| Feature                  | Obsidian Native MCP                                               | Typical Obsidian MCP server          |
| ------------------------ | ----------------------------------------------------------------- | ------------------------------------ |
| **Edit model**           | `str_replace`, `apply_patch`, `apply_edits` — surgical by default | Read whole file → write whole file   |
| **Concurrency safety**   | Cryptographic preconditions (`expected_*_hash`) on every write    | None — silent clobbering             |
| **Structural awareness** | mdast-AST: code-fenced "headings" never treated as headings       | Regex hacks that corrupt code blocks |
| **Frontmatter**          | Real YAML parser with nested key paths                            | Hand-rolled line matching            |
| **Atomicity**            | Multi-file `bulk.apply` with rollback                             | None                                 |
| **Permissions**          | Read-only mode + per-tool toggle + per-vault subdir allow/deny    | All-or-nothing                       |
| **Audit trail**          | JSONL log with content hashes before/after every mutation         | None                                 |
| **Multi-vault**          | First-class                                                       | Usually one vault                    |

## Installation

### Obsidian plugin (recommended)

1. Open Obsidian → Settings → Community Plugins → Browse
2. Search for "Native MCP" and install
3. Enable in Community Plugins
4. Open plugin settings: select which vaults to expose, optionally toggle per-tool permissions, copy the MCP URL

### CLI (standalone)

```bash
npm install -g obsidian-native-mcp
```

### Build from source

```bash
git clone https://github.com/usrivastava92/obsidian-native-mcp.git
cd obsidian-native-mcp
npm install
npm run build
```

## Configuration

### Plugin

Auto-discovers all your Obsidian vaults from Obsidian's own config. Pick which to expose in plugin settings. Plugin also surfaces a bearer token and the MCP URL.

A **Performance budgets** section in plugin settings lets you cap long-running operations. All limits default to `0 = unlimited` — raise or lower them freely without restriction.

| Setting           | Description                                                                    |
| ----------------- | ------------------------------------------------------------------------------ |
| Max files scanned | Max `.md` files scanned per `search.content` / `vault.info` call               |
| Max bytes read    | Max raw bytes of file content read per call                                    |
| Max bulk ops      | Max ops accepted by a single `bulk.apply` call                                 |
| Deadline (ms)     | Wall-clock time limit for long-walk tools (best-effort; checked once per file) |

### CLI

Either an env var or a config file.

```bash
# Single vault
export OBSIDIAN_VAULT_PATHS=/Users/me/my-obsidian-vault

# Multiple vaults (semicolons on all platforms)
export OBSIDIAN_VAULT_PATHS=/Users/me/personal;/Users/me/work
```

Config file at `~/.config/obsidian-native-mcp/vaults.json`:

```json
{
  "vaults": {
    "personal": "/Users/me/personal-notes",
    "work": "/Users/me/work-vault"
  }
}
```

Optional flags:

```bash
obsidian-native-mcp --read-only            # all write tools disabled
obsidian-native-mcp --vault notes=/path    # ad-hoc named vault
obsidian-native-mcp --config ./my.json     # explicit config file
```

#### Performance budget env vars

All default to `0` (unlimited). Set any to a positive integer to cap that resource:

```bash
MCP_MAX_FILES_SCANNED=500    # files per search.content / vault.info call
MCP_MAX_BYTES_READ=10000000  # raw bytes per call (~10 MB)
MCP_MAX_BULK_OPS=50          # ops per bulk.apply call
MCP_DEADLINE_MS=30000        # wall-clock ms ceiling for long-walk tools
```

These are _defaults_ — they are never enforced as hard system limits. Set them to whatever makes sense for your vault and workflow.

## Usage

### Obsidian plugin

Add the URL from plugin settings to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "obsidian-native-mcp": {
      "url": "http://127.0.0.1:9789/sse?token=YOUR_TOKEN"
    }
  }
}
```

### CLI

```json
{
  "mcpServers": {
    "obsidian-native-mcp": {
      "command": "obsidian-native-mcp",
      "env": {
        "OBSIDIAN_VAULT_PATHS": "/Users/me/my-obsidian-vault"
      }
    }
  }
}
```

## Tools

All tools accept an optional `vault` parameter; with a single vault configured, it's inferred. Every read returns hashes used by writes as preconditions.

### Read tools

| Tool              | What it returns                                  | Notes                                            |
| ----------------- | ------------------------------------------------ | ------------------------------------------------ |
| `vault.list`      | All configured vaults                            | —                                                |
| `vault.info`      | Stats per vault                                  | `_budget` supported                              |
| `file.list`       | Paged file listing                               | `recursive`, `pattern` (glob), `limit`, `offset` |
| `file.find`       | Find files by name                               | exact / substring / glob / regex                 |
| `file.read`       | Full file content + `contentHash` + `totalLines` | Use freely — guidelines/AGENTS.md/etc.           |
| `file.read_range` | Line range + `rangeHash`                         | Cheaper for big files                            |
| `outline`         | Heading skeleton + `sectionHash` per heading     | Sub-KB even for 5000-line files                  |
| `heading.find`    | All matches (line, level, `sectionHash`)         | Returns all — caller disambiguates               |
| `block.find`      | Block ref location + `blockHash`                 | Structural-type aware (list/table/paragraph)     |
| `frontmatter.get` | Whole frontmatter or single nested key           | YAML-aware                                       |
| `tags.list`       | Tags from frontmatter + body                     | Code-fence aware                                 |
| `links.get`       | Outlinks, backlinks, or both                     | Typed: wiki/embed/header/block/markdown          |
| `metadata.read`   | Frontmatter + headings + tags + links + hashes   | One-shot context dump                            |
| `search.content`  | Paged full-text matches with per-line hashes     | `_budget` supported; pre-filters before parse    |

### Write tools — surgical primaries

| Tool          | Shape                                                        | Why                                                              |
| ------------- | ------------------------------------------------------------ | ---------------------------------------------------------------- |
| `str_replace` | `{file, find, replace, occurrence?, expected_content_hash?}` | The default editing verb — quote what you see                    |
| `apply_patch` | Unified diff                                                 | Multi-hunk edits in one shot; context lines act as preconditions |
| `apply_edits` | `[{find, replace, occurrence?}, ...]`                        | Multi-edit, atomic per file                                      |

### Write tools — structural (when you have the address)

| Tool                   | Notes                                                       |
| ---------------------- | ----------------------------------------------------------- |
| `heading.replace_body` | Requires `expected_section_hash`                            |
| `heading.rename`       | Optionally update wiki-link references                      |
| `block.replace`        | Requires `expected_block_hash`; preserves list/table prefix |
| `block.rename`         | Renames a `^id` and updates references                      |
| `frontmatter.set`      | Nested key path; YAML-safe round-trip                       |
| `frontmatter.delete`   | Nested key path                                             |
| `lines.replace`        | Requires `expected_range_hash`                              |
| `lines.insert`         | Insert at line N                                            |

### Write tools — whole-file & metadata

| Tool           | Notes                                                                       |
| -------------- | --------------------------------------------------------------------------- |
| `file.create`  | Create-only — errors if file exists                                         |
| `file.replace` | Whole-file rewrite — heavy, requires `expected_content_hash`                |
| `file.append`  | Cheap, no read needed                                                       |
| `file.move`    | Default `on_conflict: error`; alternatives: `overwrite`, `rename`           |
| `file.delete`  | Defaults to `.obsidian/trash`; hard delete requires `expected_content_hash` |

### Power & batch

| Tool            | Notes                                                                                 |
| --------------- | ------------------------------------------------------------------------------------- |
| `bulk.apply`    | Multi-file, multi-op batch. `atomic: true` → snapshot + rollback. `_budget` supported |
| `regex.replace` | Two-step: server returns proposal token + diff → caller confirms                      |
| `file.diff`     | Diff between two `contentHash` versions (when cache has them)                         |

### Per-call budget overrides (`_budget`)

`vault.info`, `search.content`, and `bulk.apply` all accept an optional `_budget` object that overrides the server-level config **for that single call only**. This lets an AI agent tighten or relax limits based on what it knows about the task:

```json
{
  "tool": "search.content",
  "arguments": {
    "query": "important term",
    "directory": "Projects/",
    "_budget": {
      "maxFilesScanned": 200,
      "maxBytesRead": 5000000,
      "deadlineMs": 10000
    }
  }
}
```

| Field             | Applies to                     | Description                                         |
| ----------------- | ------------------------------ | --------------------------------------------------- |
| `maxFilesScanned` | `vault.info`, `search.content` | Max `.md` files to scan this call (0 = unlimited)   |
| `maxBytesRead`    | `vault.info`, `search.content` | Max raw bytes to read this call (0 = unlimited)     |
| `deadlineMs`      | `vault.info`, `search.content` | Wall-clock limit in ms for this call (0 = no limit) |
| `maxBulkOps`      | `bulk.apply`                   | Max ops for this batch (0 = unlimited)              |

When a budget is hit, the tool returns `truncated: true` with a `hint` and (for `search.content`) a `nextOffset` the agent can use to resume pagination. No error is thrown — the agent gets partial results and can decide what to do next.

### Prompts

Place markdown in any vault's `Prompts/` folder with `mcp-tools-prompt` in the frontmatter; Templater-style `<% tp.mcpTools.prompt(name, hint) %>` placeholders become MCP prompt arguments automatically.

## Concurrency safety

Every read returns one or more hashes. Every write that operates on an existing range requires the matching `expected_*_hash`. If the file changed underneath you (a human edit in Obsidian, a parallel tool call, etc.), the write returns:

```json
{
  "ok": false,
  "error": {
    "code": "STALE_PRECONDITION",
    "current_content_hash": "sha256:…",
    "current_section_hash": "sha256:…"
  }
}
```

The model refreshes from the new hash and retries. No silent clobbering.

## Permissions

- **Read-only mode** — plugin toggle or CLI `--read-only` flag disables every write tool.
- **Per-tool toggle** — disable individual tools (e.g., turn off `file.delete` for less-trusted clients).
- **Per-vault subdir allow/deny** — limit a client to a vault subtree.

## Audit log

Every mutating call appends one JSONL line to `<vault>/.obsidian/plugins/native-mcp/audit.log`:

```json
{
  "ts": "2026-05-21T13:00:00Z",
  "tool": "str_replace",
  "vault": "notes",
  "file": "Daily/2026-05-21.md",
  "args_hash": "sha256:…",
  "before_hash": "sha256:…",
  "after_hash": "sha256:…",
  "dry_run": false,
  "ok": true
}
```

Long-walk tools (`search.content`, `vault.info`) also emit telemetry fields:

```json
{
  "ts": "2026-05-21T13:00:01Z",
  "tool": "search.content",
  "vault": "notes",
  "duration_ms": 412,
  "files_scanned": 347,
  "bytes_read": 2891024,
  "truncated": true,
  "abort_reason": "budget"
}
```

| Field           | Description                                                                  |
| --------------- | ---------------------------------------------------------------------------- |
| `duration_ms`   | Wall-clock time for the operation in milliseconds                            |
| `files_scanned` | Number of `.md` files read (after pre-filter; excludes cache hits on misses) |
| `bytes_read`    | Raw bytes of file content read before mdast parsing                          |
| `truncated`     | `true` if the operation was cut short by a budget or deadline                |
| `abort_reason`  | `"budget"` · `"deadline"` · `"cancelled"` — why it stopped early             |

Rotates at 5 MB by default.

## Security

- Runs locally only — loopback (`127.0.0.1`) for HTTP, stdio for CLI.
- HTTP transport requires a startup-generated bearer token in the SSE URL.
- Origin header allowlist enforced; CORS is not `*`.
- Request bodies capped at 5 MB; max-sessions and idle TTL applied.
- Path-traversal protection on every vault-relative path.
- Only vaults you explicitly select are accessible.

## License

[MIT](LICENSE)
