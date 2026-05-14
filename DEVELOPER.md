# Developer Guide

## Architecture

```
src/
  index.ts              Entry point — reads config, starts server
  mcp/
    protocol.ts         JSON-RPC 2.0 types + Content-Length framing
    server.ts           MCP stdio server — message dispatch, tool/prompt routing
  handlers/
    tools.ts            Tool implementations (9 tools)
    prompts.ts          Prompt directory reader + template parser
  utils/
    fs-utils.ts         Bun-native file I/O, frontmatter parsing, heading/block patching
    search.ts           Recursive text search across .md files
    vaults.ts           VaultRegistry — multi-vault config from env + config file
```

### Key Design Decisions

**Zero dependencies.** The MCP protocol (JSON-RPC 2.0 over stdio with Content-Length framing) is implemented from scratch in `protocol.ts`. No npm packages needed at runtime — only `@types/bun` and `typescript` for development.

**Bun-native I/O.** Uses `Bun.file()`, `Bun.write()`, and `Bun.file().exists()` for all file operations. These are compiled into the binary by Bun's bundler — no `fs` overhead at runtime (except `readdirSync`/`statSync` for directory listing where Bun has no equivalent).

**Direct filesystem access.** Unlike `obsidian-mcp-tools` which communicates via HTTP with the Local REST API plugin, this server reads/writes files directly. This means:
- Obsidian doesn't need to be running
- No API key management
- Lower latency (no HTTP round-trip)
- Works on any platform Obsidian supports

**Multi-vault first.** The `VaultRegistry` class supports both env var and config file configuration. Vault names are derived from directory basenames (env) or explicitly set (config file). All tools accept an optional `vault` parameter.

## Development Workflow

```bash
# Install dependencies
bun install

# Run in development mode (watch + hot reload)
bun run dev

# Type-check
bun run check

# Build binary for current platform
bun run build

# Build for all platforms
bun run build:linux
bun run build:mac-arm64
bun run build:mac-x64
bun run build:windows

# Start (run from source)
OBSIDIAN_VAULT_PATHS=/path/to/vault bun run start
```

### Testing

```bash
# Build first
bun run build:mac-arm64

# Run the test script
OBSIDIAN_VAULT_PATHS=/path/to/vault node --input-type=module -e '
const msgs = [
  {jsonrpc:"2.0",id:1,method:"initialize",params:{}},
  {jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"list_vaults",arguments:{}}},
  {jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"list_vault_files",arguments:{vault:"default"}}},
];
let input = "";
for(const m of msgs){ const s = JSON.stringify(m); input += "Content-Length: "+s.length+"\r\n\r\n"+s; }
const {spawn} = await import("child_process");
const child = spawn("./dist/native-mcp", [], {stdio:["pipe","pipe","pipe"]});
let buf = "";
child.stdout.on("data", c => buf += c.toString());
child.on("close", () => {
  let remaining = buf;
  while(true){
    const m = remaining.match(/^Content-Length: (\d+)\r\n\r\n/);
    if(!m) break;
    const len = parseInt(m[1]), start = m[0].length;
    if(remaining.length < start + len) break;
    console.log(JSON.parse(remaining.slice(start, start + len)));
    remaining = remaining.slice(start + len);
  }
});
child.stdin.write(input);
child.stdin.end();
setTimeout(() => process.exit(0), 2000);
'
```

## Adding a New Tool

1. Define the tool schema in `src/mcp/server.ts` — add to the `toolDefinitions` array
2. Implement the handler in `src/handlers/tools.ts` — add to `getHandlers()`
3. Implement the core logic in `src/utils/fs-utils.ts`, `search.ts`, or a new util

## Release Process

```bash
# 1. Update version in package.json
# 2. Build all platform binaries
bun run build:linux
bun run build:mac-arm64
bun run build:mac-x64
bun run build:windows

# 3. Create GitHub release
gh release create v0.2.0 \
  ./dist/native-mcp-linux \
  ./dist/native-mcp-macos-arm64 \
  ./dist/native-mcp-macos-x64 \
  ./dist/native-mcp-windows.exe \
  --title "v0.2.0" \
  --notes "Release notes here"

# 4. Publish to npm
npm publish
```

## Protocol Reference

The server speaks the standard MCP protocol over stdio:

```
Client → Server:  Content-Length: <N>\r\n\r\n<JSON-RPC body>
Server → Client:  Content-Length: <N>\r\n\r\n<JSON-RPC body>
```

### Supported Methods

| Method | Purpose |
|---|---|
| `initialize` | Protocol handshake |
| `tools/list` | List available tools |
| `tools/call` | Execute a tool |
| `prompts/list` | List available prompts |
| `prompts/get` | Get prompt content |
| `notifications/initialized` | Client-ready notification |
