# Developer Guide

## Architecture

```
src/
  cli/index.ts              CLI entry — reads config, starts stdio transport
  plugin/
    main.ts                 Obsidian plugin entry (extends Plugin)
    settings.ts             Settings tab with vault picker + copy URL
  mcp/
    protocol.ts             JSON-RPC 2.0 types + Content-Length framing
    transport.ts            Transport interface
    stdio-transport.ts      Stdio transport (for CLI)
    http-transport.ts       HTTP/SSE transport (for plugin)
    server.ts               Transport-agnostic server — creates handlers + routes requests
  handlers/
    tools.ts                Tool implementations (9 tools)
    prompts.ts              Prompt directory reader + template parser
  utils/
    fs-utils.ts             File I/O, frontmatter parsing, heading/block patching
    search.ts               Recursive text search across .md files
    vaults.ts               VaultRegistry — config from env, file, Obsidian auto-discovery
```

### Key Design Decisions

**Zero dependencies.** The MCP protocol (JSON-RPC 2.0 over stdio with Content-Length framing) is implemented from scratch. No npm packages needed at runtime — only Node.js stdlib.

**Node.js everywhere.** All I/O uses `fs` and `fs/promises` — runs on any platform Node.js supports. Obsidian plugin runs inside Obsidian's Electron. CLI runs standalone.

**Two transports, shared logic.** The `server.ts` exports a `createServer()` factory that returns tool definitions and a `handleRequest()` function. The stdio and HTTP/SSE transports both use the same factory — only the I/O layer differs.

**Direct filesystem access.** Unlike `obsidian-mcp-tools` which communicates via HTTP with the Local REST API plugin, this server reads/writes files directly.

**Multi-vault first.** The `VaultRegistry` supports env var, config file, and Obsidian auto-discovery.

## Development Workflow

```bash
# Install dependencies
npm install

# Run CLI in dev mode (watch + hot reload)
npm run dev

# Type-check
npm run check

# Lint + format
npm run lint
npm run format

# Build TS to dist/
npm run build

# Build plugin bundle for Obsidian
npm run build:plugin

# Run CLI from compiled JS
npm run start

# Test via env var
OBSIDIAN_VAULT_PATHS=/path/to/vault node dist/cli/index.js
```

### Testing the CLI

```bash
OBSIDIAN_VAULT_PATHS=/path/to/vault node --input-type=module -e '
const msgs = [
  {jsonrpc:"2.0",id:1,method:"initialize",params:{}},
  {jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"list_vaults",arguments:{}}},
  {jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"list_files",arguments:{vault:"default"}}},
];
let input = "";
for(const m of msgs){ const s = JSON.stringify(m); input += "Content-Length: "+s.length+"\r\n\r\n"+s; }
const {spawn} = await import("child_process");
const child = spawn("node", ["dist/cli/index.js"], {stdio:["pipe","pipe","pipe"]});
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

### Testing the Plugin

1. Build the plugin: `npm run build:plugin`
2. Copy `dist/plugin/` to `<your-vault>/.obsidian/plugins/obsidian-native-mcp/`
3. Reload Obsidian, enable the plugin in Community Plugins
4. Open plugin settings to see discovered vaults

## Adding a New Tool

1. Define the tool schema in `src/mcp/server.ts` — add to the `toolDefinitions` array
2. Implement the handler in `src/handlers/tools.ts` — add to `getHandlers()`
3. Implement the core logic in `src/utils/fs-utils.ts`, `search.ts`, or a new util

## Release Process

```bash
# 1. Update version in package.json and manifest.json
# 2. Build
npm run build
npm run build:plugin

# 3. Publish to npm
npm publish

# 4. Create GitHub release
gh release create v0.2.0 --title "v0.2.0" --generate-notes

# 5. Submit plugin to Obsidian community plugin list
#    https://github.com/obsidianmd/obsidian-releases
```

## Protocol Reference

The server speaks the standard MCP protocol over stdio (CLI) or HTTP/SSE (plugin):

### Stdio

```
Client → Server:  Content-Length: <N>\r\n\r\n<JSON-RPC body>
Server → Client:  Content-Length: <N>\r\n\r\n<JSON-RPC body>
```

### HTTP/SSE

```
Client → Server:  GET /sse → SSE stream with endpoint event
Client → Server:  POST /message?session_id=<id> → JSON-RPC request
Server → Client:  SSE event "message" with JSON-RPC response
```

### Supported Methods

| Method                      | Purpose                   |
| --------------------------- | ------------------------- |
| `initialize`                | Protocol handshake        |
| `tools/list`                | List available tools      |
| `tools/call`                | Execute a tool            |
| `prompts/list`              | List available prompts    |
| `prompts/get`               | Get prompt content        |
| `notifications/initialized` | Client-ready notification |
