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
import { DEFAULT_CONFIG, type ServerConfig } from "../config.js";

export interface ServerOptions {
  version: string;
  registry: VaultRegistry;
  perms: Permissions;
  cache: IFileCache;
  audit: AuditLog;
  tools: ToolRegistry;
  promptsProvider?: PromptsProvider;
  /** Resource budget config. Defaults to all-unlimited if omitted. */
  config?: ServerConfig;
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
  const serverConfig = opts.config ?? DEFAULT_CONFIG;

  // Track in-flight requests so notifications/cancelled can abort them.
  const inFlight = new Map<string | number, AbortController>();

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

          case "notifications/cancelled": {
            // MCP cancellation: abort the matching in-flight request if present.
            const p = (req.params ?? {}) as { requestId?: string | number };
            if (p.requestId != null) {
              inFlight.get(p.requestId)?.abort("cancelled");
            }
            return null;
          }

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

            // Build AbortController: fired by notifications/cancelled or deadline.
            const ac = new AbortController();
            const reqId = req.id;
            if (reqId != null) inFlight.set(reqId, ac);

            // Optional wall-clock deadline — wired to same AbortController.
            let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
            if (serverConfig.deadlineMs > 0) {
              deadlineTimer = setTimeout(() => ac.abort("deadline"), serverConfig.deadlineMs);
            }

            const ctx: ToolContext = {
              vault,
              perms: opts.perms,
              cache: opts.cache,
              audit: opts.audit,
              registry: opts.registry,
              clientId,
              config: serverConfig,
              signal: ac.signal,
            };
            try {
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
            } finally {
              if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
              if (reqId != null) inFlight.delete(reqId);
            }
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
