/**
 * Declarative tool registry. Each tool registers a {name, schema, handler,
 * requiresWrite, summary}. The MCP server iterates the registry for
 * `tools/list` and dispatches `tools/call` through it.
 *
 * The registry owns error wrapping: handlers may throw `ToolFailure`, which
 * is captured and rendered as the canonical error envelope.
 */

import { ToolFailure } from "../utils/types.js";
import type { ToolError } from "../utils/types.js";

export interface ToolContext {
  vault: import("../vault/registry.js").VaultEntry;
  perms: import("../vault/permissions.js").Permissions;
  cache: import("../cache/file-cache.js").IFileCache;
  audit: import("../audit/log.js").AuditLog;
  registry: import("../vault/registry.js").VaultRegistry;
  clientId: string;
}

/** A JSON schema fragment for an MCP tool's input. */
export interface JsonSchema {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  description?: string;
  items?: JsonSchema;
  additionalProperties?: boolean;
  minimum?: number;
  maximum?: number;
}

export interface ToolDefinition<Args = Record<string, unknown>, Result = Record<string, unknown>> {
  name: string;
  summary: string;
  requiresWrite: boolean;
  /** JSON schema for tool inputs. */
  schema: JsonSchema;
  /** Handler invoked with parsed args + a resolved tool context. */
  handler: (args: Args, ctx: ToolContext) => Promise<Result>;
}

export interface ToolCallResult {
  ok: boolean;
  result?: unknown;
  error?: ToolError;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register<A, R>(def: ToolDefinition<A, R>): void {
    if (this.tools.has(def.name)) {
      throw new Error(`duplicate tool: ${def.name}`);
    }
    this.tools.set(def.name, def as unknown as ToolDefinition);
  }

  list(filterEnabled?: (name: string) => boolean): ToolDefinition[] {
    const out: ToolDefinition[] = [];
    for (const t of this.tools.values()) {
      if (filterEnabled && !filterEnabled(t.name)) continue;
      out.push(t);
    }
    return out;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  async invoke(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolCallResult> {
    const def = this.tools.get(name);
    if (!def) {
      return {
        ok: false,
        error: { code: "INVALID_ARGS", message: `unknown tool: ${name}` },
      };
    }
    try {
      ctx.perms.assertTool(def.name, def.requiresWrite);
      const result = await def.handler(args as never, ctx);
      return { ok: true, result };
    } catch (err) {
      if (err instanceof ToolFailure) {
        return { ok: false, error: err.toJSON() };
      }
      return {
        ok: false,
        error: { code: "INTERNAL", message: (err as Error).message },
      };
    }
  }
}
