import type { JSONRPCRequest, JSONRPCResponse, ToolDefinition } from "./protocol";
import { sendMessage, parseMessages } from "./protocol";
import { VaultFileHandler } from "../handlers/tools";
import { PromptHandler } from "../handlers/prompts";
import type { VaultRegistry } from "../utils/vaults";

const vaultParam = {
  vault: {
    type: "string",
    description:
      "Vault name (derived from the directory name). Required when multiple vaults are configured.",
  },
};

export async function startMcpServer(registry: VaultRegistry) {
  const vaultList = registry.list();
  const vaultNames = vaultList.map((v) => v.name);
  vaultParam.vault.description = `Vault name. Available: ${vaultNames.join(", ")}`;

  const fileHandler = new VaultFileHandler(registry);
  const promptHandler = new PromptHandler(registry);
  const toolHandlers = fileHandler.getHandlers();

  const toolDefinitions: ToolDefinition[] = [
    {
      name: "list_vaults",
      description: "List all configured vaults with their paths.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_vault_info",
      description:
        "Get stats for a vault (file count, path, name).",
      inputSchema: {
        type: "object",
        properties: {
          vault: {
            type: "string",
            description: `Vault name. Available: ${vaultNames.join(", ")}`,
          },
        },
      },
    },
    {
      name: "list_vault_files",
      description:
        "List files in the root directory or a specified subdirectory of your vault.",
      inputSchema: {
        type: "object",
        properties: {
          ...vaultParam,
          directory: {
            type: "string",
            description:
              "Optional subdirectory path relative to vault root",
          },
        },
      },
    },
    {
      name: "get_vault_file",
      description: "Get the content of a file from your vault.",
      inputSchema: {
        type: "object",
        properties: {
          ...vaultParam,
          filename: {
            type: "string",
            description: "Path to the file relative to vault root",
          },
          format: {
            type: "string",
            enum: ["markdown", "json"],
            description: "Return format (json includes frontmatter)",
          },
        },
        required: ["filename"],
      },
    },
    {
      name: "create_vault_file",
      description:
        "Create a new file in your vault or update an existing one.",
      inputSchema: {
        type: "object",
        properties: {
          ...vaultParam,
          filename: {
            type: "string",
            description: "Path to the file relative to vault root",
          },
          content: { type: "string", description: "File content" },
        },
        required: ["filename", "content"],
      },
    },
    {
      name: "append_to_vault_file",
      description: "Append content to a new or existing file.",
      inputSchema: {
        type: "object",
        properties: {
          ...vaultParam,
          filename: {
            type: "string",
            description: "Path to the file relative to vault root",
          },
          content: {
            type: "string",
            description: "Content to append",
          },
        },
        required: ["filename", "content"],
      },
    },
    {
      name: "patch_vault_file",
      description:
        "Insert or modify content in a file relative to a heading, block reference, or frontmatter field.",
      inputSchema: {
        type: "object",
        properties: {
          ...vaultParam,
          filename: { type: "string" },
          operation: {
            type: "string",
            enum: ["append", "prepend", "replace"],
          },
          targetType: {
            type: "string",
            enum: ["heading", "block", "frontmatter"],
          },
          target: { type: "string" },
          content: { type: "string" },
          contentType: {
            type: "string",
            enum: ["text/markdown", "application/json"],
          },
          targetDelimiter: { type: "string", default: "::" },
          trimTargetWhitespace: { type: "boolean", default: true },
        },
        required: [
          "filename",
          "operation",
          "targetType",
          "target",
          "content",
        ],
      },
    },
    {
      name: "delete_vault_file",
      description: "Delete a file from your vault.",
      inputSchema: {
        type: "object",
        properties: {
          ...vaultParam,
          filename: {
            type: "string",
            description: "Path to the file relative to vault root",
          },
        },
        required: ["filename"],
      },
    },
    {
      name: "search_vault",
      description:
        "Search for documents matching a text query in your vault.",
      inputSchema: {
        type: "object",
        properties: {
          ...vaultParam,
          query: { type: "string", description: "Text to search for" },
          directory: {
            type: "string",
            description: "Optional directory to scope the search",
          },
          contextLength: {
            type: "number",
            description: "Characters of context around each match",
          },
        },
        required: ["query"],
      },
    },
  ];

  const stdinBuffer = { buffer: "" };

  process.stdin.on("data", async (chunk: Buffer) => {
    stdinBuffer.buffer += chunk.toString();

    const { messages, remaining } = parseMessages(stdinBuffer.buffer);
    stdinBuffer.buffer = remaining;

    for (const jsonStr of messages) {
      try {
        const msg = JSON.parse(jsonStr);
        if (msg.jsonrpc !== "2.0") continue;

        if ("method" in msg && "id" in msg) {
          const response = await handleRequest(msg as JSONRPCRequest);
          if (response) sendMessage(response);
        }
      } catch (err: any) {
        console.error("Error processing message:", err.message);
      }
    }
  });

  async function handleRequest(
    msg: JSONRPCRequest
  ): Promise<JSONRPCResponse | null> {
    const { method, params, id } = msg;

    switch (method) {
      case "initialize": {
        const clientProtocol = params?.protocolVersion;
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: clientProtocol || "2024-11-05",
            capabilities: { tools: {}, prompts: {} },
            serverInfo: { name: "native-mcp", version: "0.2.0" },
          },
        };
      }

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: { tools: toolDefinitions },
        };

      case "tools/call": {
        const toolName = params?.name;
        const args = params?.arguments || {};
        const handler = toolHandlers[toolName as string];
        if (!handler) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Unknown tool: ${toolName}` },
          };
        }
        try {
          const result = await handler(args);
          return { jsonrpc: "2.0", id, result };
        } catch (err: any) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32603, message: err.message || String(err) },
          };
        }
      }

      case "prompts/list": {
        try {
          const promptVault = params?.arguments?.vault;
          const promptList = await promptHandler.list(promptVault);
          return { jsonrpc: "2.0", id, result: { prompts: promptList } };
        } catch (err: any) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32603, message: err.message || String(err) },
          };
        }
      }

      case "prompts/get": {
        try {
          const promptVault = params?.arguments?.vault;
          const result = await promptHandler.get(
            params?.name,
            promptVault
          );
          return { jsonrpc: "2.0", id, result };
        } catch (err: any) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32603, message: err.message || String(err) },
          };
        }
      }

      case "notifications/initialized":
      case "notifications/cancelled":
      case "notifications/roots/list_changed":
        return null;

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
    }
  }
}
