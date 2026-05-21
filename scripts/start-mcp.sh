#!/bin/sh
# Wrapper script so MCP clients that can't pass env vars
# (Postman, some Claude Desktop configs) can launch the server.
# Edit OBSIDIAN_VAULT_PATHS to point at your vault(s).
export OBSIDIAN_VAULT_PATHS="/Users/usrivastava/obsidian/global"
exec node "$(dirname "$0")/../dist/cli/index.js" "$@"
