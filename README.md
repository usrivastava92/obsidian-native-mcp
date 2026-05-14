<div align="center">

# Obsidian Native MCP

**Zero-dependency MCP server for Obsidian vaults**  
Direct filesystem access — no Obsidian process, no REST API plugin required.

[![Build](https://img.shields.io/github/actions/workflow/status/usrivastava92/obsidian-native-mcp/ci.yml?branch=main&label=CI&logo=github)](https://github.com/usrivastava92/obsidian-native-mcp/actions)
[![Release](https://img.shields.io/github/v/release/usrivastava92/obsidian-native-mcp?logo=semanticrelease)](https://github.com/usrivastava92/obsidian-native-mcp/releases)
[![npm](https://img.shields.io/npm/v/obsidian-native-mcp?logo=npm)](https://www.npmjs.com/package/obsidian-native-mcp)
[![npm downloads](https://img.shields.io/npm/dm/obsidian-native-mcp?logo=npm)](https://www.npmjs.com/package/obsidian-native-mcp)
[![License](https://img.shields.io/github/license/usrivastava92/obsidian-native-mcp)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](CONTRIBUTING.md)

</div>

Obsidian Native MCP is a [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI assistants (Claude Desktop, etc.) direct, safe access to your Obsidian vault — without needing Obsidian to be running.

**Why Obsidian Native MCP over other solutions?**

| Feature            | Obsidian Native MCP                    | obsidian-mcp-tools (archived)             |
| ------------------ | -------------------------------------- | ----------------------------------------- |
| Obsidian required? | **No** — pure filesystem               | Yes — must be running with Local REST API |
| Dependencies       | **Zero** — uses only Bun stdlib        | MCP SDK, arktype, zod, radash, turndown…  |
| Build              | **Single compiled binary**             | Bun-compiled binary                       |
| Multi-vault        | **Built-in** — one server, many vaults | No                                        |
| Cross-platform     | **macOS / Linux / Windows**            | Same                                      |
| File patching      | Headings, blocks, frontmatter          | Via REST API                              |

## Installation

### Prerequisites

- [Bun](https://bun.sh) v1.1+ (only needed to build from source)

### Download

Grab the latest binary from [releases](https://github.com/usrivastava92/obsidian-native-mcp/releases):

```bash
# macOS ARM64
curl -L -o obsidian-native-mcp https://github.com/usrivastava92/obsidian-native-mcp/releases/latest/download/obsidian-native-mcp-macos-arm64
chmod +x obsidian-native-mcp

# Linux x64
curl -L -o obsidian-native-mcp https://github.com/usrivastava92/obsidian-native-mcp/releases/latest/download/obsidian-native-mcp-linux
chmod +x obsidian-native-mcp

# Windows (PowerShell)
curl -L -o obsidian-native-mcp.exe https://github.com/usrivastava92/obsidian-native-mcp/releases/latest/download/obsidian-native-mcp-windows.exe
```

### Build from source

```bash
git clone https://github.com/usrivastava92/obsidian-native-mcp.git
cd obsidian-native-mcp
bun install
bun run build
```

### npm

```bash
npm install -g obsidian-native-mcp
```

## Configuration

Configure your vault(s) via **environment variable** or **config file**.

### Env var (quick start)

```bash
# Single vault
export OBSIDIAN_VAULT_PATHS=/Users/me/my-obsidian-vault

# Multiple vaults (semicolons on all platforms)
export OBSIDIAN_VAULT_PATHS=/Users/me/personal;/Users/me/work

# Windows
set OBSIDIAN_VAULT_PATHS=C:\Users\me\personal;C:\Users\me\work
```

### Config file (`~/.config/obsidian-native-mcp/vaults.json`)

```json
{
  "vaults": {
    "personal": "/Users/me/personal-notes",
    "work": "/Users/me/work-vault",
    "recipes": "/Users/me/cooking"
  }
}
```

Vault names are derived from directory names automatically (env var) or set explicitly (config file).

## Usage

### Claude Desktop

Add to your `claude_desktop_config.json`:

**Single vault:**

```json
{
  "mcpServers": {
    "obsidian-native-mcp": {
      "command": "/path/to/obsidian-native-mcp",
      "env": {
        "OBSIDIAN_VAULT_PATHS": "/Users/me/my-obsidian-vault"
      }
    }
  }
}
```

**Multiple vaults:**

```json
{
  "mcpServers": {
    "obsidian-native-mcp": {
      "command": "/path/to/obsidian-native-mcp",
      "env": {
        "OBSIDIAN_VAULT_PATHS": "/Users/me/personal;/Users/me/work"
      }
    }
  }
}
```

Now Claude can read, search, create, and modify your notes across all vaults. When a vault name is needed, use the directory name (e.g., `personal`, `work`).

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
- [x] Cross-platform (macOS, Linux, Windows)
- [x] Prompt templates from vault's Prompts folder
- [x] Config file support (`~/.config/obsidian-native-mcp/vaults.json`)
- [ ] Smart Connections-like semantic search (local embeddings)
- [ ] Vault change watching (file system events)
- [ ] S3/remote vault sync support

## Security

obsidian-native-mcp runs locally on your machine and accesses only the vault paths you explicitly configure. No data is sent to external services. Communication with your AI client happens over local stdio — nothing touches the network.

For security concerns, please open an issue or see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
