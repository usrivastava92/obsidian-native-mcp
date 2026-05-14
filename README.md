<div align="center">

# Obsidian Native MCP

**Zero-dependency MCP server for Obsidian vaults**  
Direct filesystem access — no Obsidian process, no REST API plugin required.

[![Build](https://img.shields.io/github/actions/workflow/status/usrivastava92/obsidian-native-mcp/ci.yml?branch=main&label=CI&logo=github)](https://github.com/usrivastava92/obsidian-native-mcp/actions)
[![Release](https://img.shields.io/github/v/release/usrivastava92/obsidian-native-mcp?logo=semanticrelease)](https://github.com/usrivastava92/obsidian-native-mcp/releases)
[![npm](https://img.shields.io/npm/v/obsidian-native-mcp?logo=npm)](https://www.npmjs.com/package/obsidian-native-mcp)
[![npm downloads](https://img.shields.io/npm/dm/obsidian-native-mcp?logo=npm)](https://www.npmjs.com/package/obsidian-native-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](CONTRIBUTING.md)

</div>

Obsidian Native MCP is a [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI assistants (Claude Desktop, etc.) direct, safe access to your Obsidian vaults.

**Two ways to use it:**

- **Obsidian plugin** (recommended) — 1-click install, auto-discovers vaults, settings UI, runs inside Obsidian
- **CLI** — standalone, works without Obsidian running, configured via env var or config file

**Why Obsidian Native MCP over other solutions?**

| Feature            | Obsidian Native MCP                    | obsidian-mcp-tools (archived)             |
| ------------------ | -------------------------------------- | ----------------------------------------- |
| Obsidian required? | **Plugin: no. CLI: no.**               | Yes — must be running with Local REST API |
| Dependencies       | **Zero** — uses only Node.js stdlib    | MCP SDK, arktype, zod, radash, turndown…  |
| Distribution       | Obsidian plugin + npm CLI              | Bun-compiled binary                       |
| Multi-vault        | **Built-in** — one server, many vaults | No                                        |
| Cross-platform     | **1 codebase, runs everywhere (WORA)** | Platform-specific binaries                |
| File patching      | Headings, blocks, frontmatter          | Via REST API                              |
| Setup effort       | Plugin: 1 click. CLI: one command.     | Manual download + config                  |

## Installation

### Obsidian plugin (recommended)

1. Open Obsidian → Settings → Community Plugins → Browse
2. Search for "Obsidian Native MCP" and install
3. Enable the plugin in Community Plugins list
4. Go to plugin settings → toggle which vaults to expose → copy the MCP URL

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

Plugin auto-discovers all your Obsidian vaults from Obsidian's own config. Open plugin settings to select which vaults to expose.

### CLI

Configure vault(s) via environment variable or config file.

```bash
# Single vault
export OBSIDIAN_VAULT_PATHS=/Users/me/my-obsidian-vault

# Multiple vaults (semicolons on all platforms)
export OBSIDIAN_VAULT_PATHS=/Users/me/personal;/Users/me/work

# Windows
set OBSIDIAN_VAULT_PATHS=C:\Users\me\personal;C:\Users\me\work
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

## Usage

### Obsidian plugin

After enabling the plugin, open its settings tab. You'll see a URL like `http://127.0.0.1:9789/sse`. Add it to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "obsidian-native-mcp": {
      "url": "http://127.0.0.1:9789/sse"
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

| Tool             | Description                                             |
| ---------------- | ------------------------------------------------------- |
| `list_vaults`    | List all configured vaults with paths                   |
| `get_vault_info` | Stats per vault (file count, etc.)                      |
| `list_files`     | List files/dirs in a vault directory                    |
| `get_file`       | Read file content (markdown or json with frontmatter)   |
| `create_file`    | Create or overwrite a file                              |
| `append_to_file` | Append content to a file                                |
| `patch_file`     | Patch by heading, block reference, or frontmatter field |
| `delete_file`    | Delete a file                                           |
| `search`         | Full-text search across markdown files                  |

All file tools accept an optional `vault` parameter. When only one vault is configured, it's inferred automatically.

### Prompts

Place markdown files in a `Prompts/` folder in any vault, tagged with `mcp-tools-prompt` in frontmatter:

```markdown
---
tags: [mcp-tools-prompt]
description: Summarize the daily note
---

Summarize what happened on <% tp.mcpTools.prompt("date", "Date to summarize") %>.
```

Prompts appear automatically in your MCP client's prompt selector.

## Roadmap

- [x] Zero-dependency MCP protocol implementation
- [x] Full vault CRUD (list, read, create, append, patch, delete)
- [x] Full-text search across vault
- [x] Multi-vault support
- [x] Cross-platform (runs anywhere Node.js runs)
- [x] Prompt templates from vault's Prompts folder
- [x] Config file support (`~/.config/obsidian-native-mcp/vaults.json`)
- [x] Obsidian community plugin with settings UI
- [x] Vault auto-discovery from Obsidian config
- [x] HTTP/SSE transport for plugin
- [x] Two distribution methods (plugin + CLI)
- [ ] Smart Connections-like semantic search (local embeddings)
- [ ] Vault change watching (file system events)
- [ ] npm publish workflow

## Security

obsidian-native-mcp runs locally on your machine. The plugin exposes vaults over localhost only. The CLI communicates over local stdio. No data is sent to external services. Only vaults you explicitly select/configure are accessible.

For security concerns, please open an issue or see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
