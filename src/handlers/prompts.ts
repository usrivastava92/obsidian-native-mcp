import { readdirSync, statSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import type { PromptDefinition } from "../mcp/protocol";
import { parseFrontmatter } from "../utils/markdown";
import type { VaultRegistry } from "../utils/vaults";

export class PromptHandler {
  private registry: VaultRegistry;
  private promptDir = "Prompts";

  constructor(registry: VaultRegistry) {
    this.registry = registry;
  }

  async list(vaultName?: string): Promise<PromptDefinition[]> {
    const vaultPath = this.registry.resolve(vaultName);
    const promptPath = join(vaultPath, this.promptDir);

    let entries: string[];
    try {
      entries = readdirSync(promptPath);
    } catch {
      return [];
    }

    const prompts: PromptDefinition[] = [];

    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;

      const fullPath = join(promptPath, entry);
      const stat = statSync(fullPath);
      if (!stat.isFile()) continue;

      try {
        const content = await readFile(fullPath, "utf-8");
        const parsed = parseFrontmatter(content);
        const tags: string[] = parsed?.frontmatter?.tags || [];

        if (!tags.includes("mcp-tools-prompt")) continue;

        const promptArgs = parsePromptParameters(parsed?.body || content);
        prompts.push({
          name: entry,
          description: parsed?.frontmatter?.description || entry.replace(".md", ""),
          arguments: promptArgs,
        });
      } catch {
        continue;
      }
    }

    return prompts;
  }

  async get(
    name: string,
    vaultName?: string,
  ): Promise<{
    messages: Array<{ role: string; content: { type: string; text: string } }>;
  }> {
    const vaultPath = this.registry.resolve(vaultName);
    const promptPath = join(vaultPath, this.promptDir, name);

    let content: string;
    try {
      content = await readFile(promptPath, "utf-8");
    } catch {
      throw new Error(`Prompt not found: ${name}`);
    }

    const parsed = parseFrontmatter(content);
    const body = parsed?.body || content;
    const withoutFrontmatter = body.trim();

    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: withoutFrontmatter,
          },
        },
      ],
    };
  }
}

interface PromptParameter {
  name: string;
  description?: string;
  required?: boolean;
}

function parsePromptParameters(content: string): PromptParameter[] {
  const regex = /<%[-_*]*\s*tp\.mcpTools\.prompt\(([^)]+)\)\s*[-_]*%>/g;
  const params: PromptParameter[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    try {
      const argsStr = match[1];
      const args = argsStr.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));

      if (args.length >= 1) {
        params.push({
          name: args[0],
          description: args[1],
          required: true,
        });
      }
    } catch {
      continue;
    }
  }

  return params;
}
