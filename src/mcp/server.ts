/**
 * Transport-agnostic MCP server factory.
 *
 *   createServer({ registry, perms, cache, audit, tools, version })
 *     → { handleRequest }
 *
 * Implements the JSON-RPC methods MCP clients expect:
 *   - initialize
 *   - notifications/initialized
 *   - tools/list
 *   - tools/call
 *   - prompts/list
 *   - prompts/get
 */

import {
  failure,
  success,
  ErrorCode,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./protocol.js";
import { ToolRegistry, type ToolContext } from "../handlers/registry.js";
import type { VaultRegistry } from "../vault/registry.js";
import type { Permissions } from "../vault/permissions.js";
import type { IFileCache } from "../cache/file-cache.js";
import type { AuditLog } from "../audit/log.js";

export interface ServerOptions {
  version: string;
  registry: VaultRegistry;
  perms: Permissions;
  cache: IFileCache;
  audit: AuditLog;
  tools: ToolRegistry;
  promptsProvider?: PromptsProvider;
}

export interface PromptDescriptor {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface PromptMessage {
  role: "user" | "assistant";
  content: { type: "text"; text: string };
}

export interface PromptsProvider {
  list(): Promise<PromptDescriptor[]>;
  get(
    name: string,
    args?: Record<string, string>,
  ): Promise<{ description?: string; messages: PromptMessage[] }>;
}

export interface ServerHandle {
  handleRequest(req: JsonRpcRequest, clientId: string): Promise<JsonRpcResponse | null>;
}

export function createServer(opts: ServerOptions): ServerHandle {
  return {
    async handleRequest(req, clientId) {
      // Notifications: respond with null (transport will ack but not send).
      const isNotification = req.id === undefined || req.id === null;
      try {
        switch (req.method) {
          case "initialize":
            return isNotification
              ? null
              : success(req.id ?? null, {
                  protocolVersion: "2024-11-05",
                  serverInfo: { name: "obsidian-native-mcp", version: opts.version },
                  capabilities: {
                    tools: { listChanged: false },
                    prompts: opts.promptsProvider ? { listChanged: false } : undefined,
                  },
                });
          case "notifications/initialized":
            return null;
          case "tools/list": {
            const tools = opts.tools
              .list((name) => opts.perms.isToolEnabled(name))
              .map((t) => ({
                name: t.name,
                description: t.summary,
                inputSchema: t.schema,
              }));
            return success(req.id ?? null, { tools });
          }
          case "tools/call": {
            const params = (req.params ?? {}) as {
              name?: string;
              arguments?: Record<string, unknown>;
            };
            const name = typeof params.name === "string" ? params.name : "";
            const args = params.arguments ?? {};
            // Resolve vault from args (or sole vault inference)
            const vaultName = typeof args.vault === "string" ? args.vault : undefined;
            let vault;
            try {
              vault = opts.registry.resolve(vaultName);
            } catch (e) {
              return failure(req.id ?? null, ErrorCode.InvalidParams, (e as Error).message);
            }
            const ctx: ToolContext = {
              vault,
              perms: opts.perms,
              cache: opts.cache,
              audit: opts.audit,
              registry: opts.registry,
              clientId,
            };
            const result = await opts.tools.invoke(name, args, ctx);
            if (!result.ok) {
              return success(req.id ?? null, {
                isError: true,
                content: [{ type: "text", text: JSON.stringify(result.error) }],
              });
            }
            return success(req.id ?? null, {
              content: [{ type: "text", text: JSON.stringify(result.result) }],
            });
          }
          case "prompts/list": {
            if (!opts.promptsProvider) {
              return success(req.id ?? null, { prompts: [] });
            }
            const prompts = await opts.promptsProvider.list();
            return success(req.id ?? null, { prompts });
          }
          case "prompts/get": {
            if (!opts.promptsProvider) {
              return failure(req.id ?? null, ErrorCode.MethodNotFound, "prompts not supported");
            }
            const params = (req.params ?? {}) as {
              name?: string;
              arguments?: Record<string, string>;
            };
            if (typeof params.name !== "string") {
              return failure(req.id ?? null, ErrorCode.InvalidParams, "missing name");
            }
            const out = await opts.promptsProvider.get(params.name, params.arguments);
            return success(req.id ?? null, out);
          }
          default:
            if (isNotification) return null;
            return failure(
              req.id ?? null,
              ErrorCode.MethodNotFound,
              `method not found: ${req.method}`,
            );
        }
      } catch (e) {
        if (isNotification) return null;
        return failure(req.id ?? null, ErrorCode.InternalError, (e as Error).message);
      }
    },
  };
}
