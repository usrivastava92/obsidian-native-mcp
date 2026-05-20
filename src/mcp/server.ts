import type { JSONRPCRequest, JSONRPCResponse, ToolDefinition } from "./protocol";
import { VaultFileHandler } from "../handlers/tools";
import { PromptHandler } from "../handlers/prompts";
import { createLogger, formatError } from "../utils/log";
import type { VaultRegistry } from "../utils/vaults";

const log = createLogger("server");

const vaultParam = {
  vault: {
    type: "string",
    description:
      "Vault name (derived from the directory name). Required when multiple vaults are configured.",
  },
};

export interface ServerInstance {
  toolDefinitions: ToolDefinition[];
  handleRequest(msg: JSONRPCRequest): Promise<JSONRPCResponse | null>;
}

export function createServer(registry: VaultRegistry): ServerInstance {
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
      description: "Get stats for a vault (file count, path, name).",
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
      name: "list_files",
      description: "List files in the root directory or a specified subdirectory of your vault.",
      inputSchema: {
        type: "object",
        properties: {
          ...vaultParam,
          directory: {
            type: "string",
            description: "Optional subdirectory path relative to vault root",
          },
          recursive: {
            type: "boolean",
            description: "Whether to list entries recursively",
          },
        },
      },
    },
    {
      name: "get_file",
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
      name: "create_file",
      description: "Create a new file in your vault or update an existing one.",
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
      name: "append_to_file",
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
      name: "patch_file",
      description:
        "Insert or modify content in a file relative to a heading, block reference, or frontmatter field.",
      inputSchema: {
        type: "object",
        properties: {
          ...vaultParam,
          filename: { type: "string" },
          operation: {
            type: "string",
            enum: ["append", "prepend", "replace", "delete"],
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
          dry_run: { type: "boolean", description: "Preview the patched content without writing" },
        },
        required: ["filename", "operation", "targetType", "target"],
      },
    },
    {
      name: "delete_file",
      description: "Delete a file from your vault.",
      inputSchema: {
        type: "object",
        properties: {
          ...vaultParam,
          filename: {
            type: "string",
            description: "Path to the file relative to vault root",
          },
          trash: {
            type: "boolean",
            description:
              "Move the file into the vault-local .trash directory instead of deleting it",
          },
          dry_run: {
            type: "boolean",
            description: "Preview deletion without mutating the vault",
          },
        },
        required: ["filename"],
      },
    },
    {
      name: "move_file",
      description: "Move or rename a file within your vault and optionally rewrite references.",
      inputSchema: {
        type: "object",
        properties: {
          ...vaultParam,
          from: { type: "string", description: "Existing file path relative to vault root" },
          to: { type: "string", description: "New file path relative to vault root" },
          update_links: {
            type: "boolean",
            description: "Rewrite resolvable links to the moved file",
          },
          dry_run: { type: "boolean", description: "Preview the move without writing changes" },
        },
        required: ["from", "to"],
      },
    },
    {
      name: "replace_file",
      description: "Replace the full content of a file with explicit semantics.",
      inputSchema: {
        type: "object",
        properties: {
          ...vaultParam,
          filename: { type: "string", description: "Path to the file relative to vault root" },
          content: { type: "string", description: "Replacement file content" },
          create_if_missing: {
            type: "boolean",
            description: "Create the file if it does not already exist",
          },
          dry_run: { type: "boolean", description: "Preview replacement without writing changes" },
        },
        required: ["filename", "content"],
      },
    },
    {
      name: "replace_section",
      description: "Replace the body of a heading section while preserving the rest of the file.",
      inputSchema: {
        type: "object",
        properties: {
          ...vaultParam,
          filename: { type: "string" },
          heading: {
            type: "string",
            description: "Heading path to replace, optionally nested with ::",
          },
          content: { type: "string", description: "Replacement section body" },
          create_if_missing: {
            type: "boolean",
            description: "Create the section when it is absent",
          },
          targetDelimiter: { type: "string", default: "::" },
          dry_run: { type: "boolean", description: "Preview the replacement without writing" },
        },
        required: ["filename", "heading", "content"],
      },
    },
    {
      name: "search_files",
      description: "Find files by path, basename, or basename without extension.",
      inputSchema: {
        type: "object",
        properties: {
          ...vaultParam,
          query: { type: "string", description: "Path or filename query" },
          directory: { type: "string", description: "Optional directory to scope the search" },
          mode: {
            type: "string",
            enum: ["exact", "substring", "glob", "regex"],
            description: "Filename matching mode",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "read_metadata",
      description: "Read structured metadata such as frontmatter, headings, tags, and aliases.",
      inputSchema: {
        type: "object",
        properties: {
          ...vaultParam,
          filename: { type: "string", description: "Path to the file relative to vault root" },
        },
        required: ["filename"],
      },
    },
    {
      name: "get_links",
      description: "Read backlinks, outlinks, or both for a note.",
      inputSchema: {
        type: "object",
        properties: {
          ...vaultParam,
          filename: { type: "string", description: "Path to the file relative to vault root" },
          direction: {
            type: "string",
            enum: ["backlinks", "outlinks", "both"],
            description: "Which relationship direction to return",
          },
        },
        required: ["filename"],
      },
    },
    {
      name: "bulk_patch",
      description: "Apply a batch of patch_file-style operations, optionally atomically.",
      inputSchema: {
        type: "object",
        properties: {
          ...vaultParam,
          operations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                filename: { type: "string" },
                operation: { type: "string", enum: ["append", "prepend", "replace", "delete"] },
                targetType: { type: "string", enum: ["heading", "block", "frontmatter"] },
                target: { type: "string" },
                content: { type: "string" },
                contentType: { type: "string", enum: ["text/markdown", "application/json"] },
                targetDelimiter: { type: "string" },
                trimTargetWhitespace: { type: "boolean" },
              },
              required: ["filename", "operation", "targetType", "target"],
            },
          },
          atomic: {
            type: "boolean",
            description: "Apply all patches or none when validation fails",
          },
          dry_run: { type: "boolean", description: "Preview the patch results without writing" },
        },
        required: ["operations"],
      },
    },
    {
      name: "search",
      description: "Search for documents matching a text query in your vault.",
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

  async function handleRequest(msg: JSONRPCRequest): Promise<JSONRPCResponse | null> {
    const { method, params, id } = msg;

    switch (method) {
      case "initialize": {
        const clientProtocol = params?.protocolVersion;
        log.info("client initialized", {
          clientProtocol: clientProtocol || "2024-11-05",
          vaultCount: vaultList.length,
        });
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: clientProtocol || "2024-11-05",
            capabilities: { tools: {}, prompts: {} },
            serverInfo: { name: "obsidian-native-mcp", version: "0.2.0" },
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
          log.error("tool call failed", {
            tool: String(toolName),
            error: formatError(err),
          });
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
          log.error("prompt listing failed", { error: formatError(err) });
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
          const result = await promptHandler.get(params?.name, promptVault);
          return { jsonrpc: "2.0", id, result };
        } catch (err: any) {
          log.error("prompt fetch failed", {
            prompt: typeof params?.name === "string" ? params.name : "",
            error: formatError(err),
          });
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
        log.warn("method not found", { method });
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
    }
  }

  return { toolDefinitions, handleRequest };
}
