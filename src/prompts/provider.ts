/**
 * Filesystem-backed prompts provider. Walks each vault's `Prompts/` directory
 * for markdown files tagged `mcp-tools-prompt` in their frontmatter, and
 * exposes them via MCP `prompts/list` / `prompts/get`.
 *
 * Argument substitution: any `<% tp.mcpTools.prompt("name", "desc") %>` token
 * in the prompt body is captured as an argument. On `prompts/get`, we replace
 * each occurrence with the supplied value (or empty string if missing).
 */

import * as path from "node:path";
import { walk } from "../fs/walk.js";
import { readText, fileExists } from "../fs/io.js";
import { parseFrontmatter } from "../markdown/frontmatter.js";
import type { PromptsProvider, PromptDescriptor, PromptMessage } from "../mcp/server.js";
import type { VaultRegistry } from "../vault/registry.js";

const PROMPT_TAG = "mcp-tools-prompt";
const PROMPT_DIR = "Prompts";
const ARG_RE = /<%\s*tp\.mcpTools\.prompt\(\s*"([^"]+)"(?:\s*,\s*"([^"]*)")?\s*\)\s*%>/g;

export class FsPromptsProvider implements PromptsProvider {
  constructor(private registry: VaultRegistry) {}

  async list(): Promise<PromptDescriptor[]> {
    const out: PromptDescriptor[] = [];
    for (const vault of this.registry.list()) {
      const promptsRoot = path.join(vault.root, PROMPT_DIR);
      if (!(await fileExists(promptsRoot))) continue;
      for await (const entry of walk(promptsRoot, { extensions: ["md"] })) {
        if (entry.type !== "file") continue;
        try {
          const text = await readText(entry.absPath);
          const fm = parseFrontmatter(text);
          if (!fm) continue;
          const tags = fm.data.tags;
          if (!isStringArrayLike(tags) || !tags.some((t) => String(t) === PROMPT_TAG)) continue;
          const description =
            typeof fm.data.description === "string" ? fm.data.description : undefined;
          const name = `${vault.name}/${entry.relPath.replace(/\.md$/i, "")}`;
          const args = collectArgs(text);
          out.push({ name, description, arguments: args });
        } catch {
          /* skip malformed prompt */
        }
      }
    }
    return out;
  }

  async get(
    name: string,
    args?: Record<string, string>,
  ): Promise<{ description?: string; messages: PromptMessage[] }> {
    const slash = name.indexOf("/");
    if (slash === -1) throw new Error(`prompt name must be 'vault/relpath': ${name}`);
    const vaultName = name.slice(0, slash);
    const rel = name.slice(slash + 1) + ".md";
    const vault = this.registry.get(vaultName);
    if (!vault) throw new Error(`unknown vault: ${vaultName}`);
    const abs = path.join(vault.root, PROMPT_DIR, rel);
    if (!(await fileExists(abs))) throw new Error(`prompt not found: ${name}`);
    const text = await readText(abs);
    const fm = parseFrontmatter(text);
    const body = stripFrontmatterText(text);
    const substituted = body.replace(ARG_RE, (_, key: string) => args?.[key] ?? "");
    const description =
      fm && typeof fm.data.description === "string" ? fm.data.description : undefined;
    return {
      description,
      messages: [{ role: "user", content: { type: "text", text: substituted.trimStart() } }],
    };
  }
}

function collectArgs(
  text: string,
): Array<{ name: string; description?: string; required?: boolean }> {
  const seen = new Map<string, { name: string; description?: string; required?: boolean }>();
  let m: RegExpExecArray | null;
  ARG_RE.lastIndex = 0;
  while ((m = ARG_RE.exec(text)) !== null) {
    const name = m[1];
    if (!seen.has(name)) seen.set(name, { name, description: m[2], required: true });
  }
  return Array.from(seen.values());
}

function stripFrontmatterText(text: string): string {
  if (!text.startsWith("---")) return text;
  const i = text.indexOf("\n---", 3);
  if (i === -1) return text;
  return text.slice(text.indexOf("\n", i + 1) + 1);
}

function isStringArrayLike(v: unknown): v is unknown[] {
  return Array.isArray(v);
}
