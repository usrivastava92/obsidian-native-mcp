import {
  listFiles,
  readFileHandler,
  createFile,
  appendFile,
  deleteFileHandler,
  patchFile,
} from "../utils/fs-utils";
import { searchInVault } from "../utils/search";
import type { VaultRegistry } from "../utils/vaults";
import type { ToolResult } from "../mcp/protocol";

type ToolHandler = (args: Record<string, any>) => Promise<ToolResult>;

export class VaultFileHandler {
  private registry: VaultRegistry;

  constructor(registry: VaultRegistry) {
    this.registry = registry;
  }

  getHandlers(): Record<string, ToolHandler> {
    return {
      list_vaults: this.handleListVaults.bind(this),
      get_vault_info: this.handleVaultInfo.bind(this),
      list_files: this.handleListFiles.bind(this),
      get_file: this.handleGetFile.bind(this),
      create_file: this.handleCreateFile.bind(this),
      append_to_file: this.handleAppendFile.bind(this),
      patch_file: this.handlePatchFile.bind(this),
      delete_file: this.handleDeleteFile.bind(this),
      search: this.handleSearch.bind(this),
    };
  }

  private resolveVault(args: Record<string, any>): string {
    return this.registry.resolve(args.vault);
  }

  private async handleListVaults(_args: Record<string, any>): Promise<ToolResult> {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(this.registry.list(), null, 2),
        },
      ],
    };
  }

  private async handleVaultInfo(args: Record<string, any>): Promise<ToolResult> {
    const info = this.registry.info(args.vault);
    return {
      content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
    };
  }

  private async handleListFiles(args: Record<string, any>): Promise<ToolResult> {
    const vaultPath = this.resolveVault(args);
    const entries = listFiles(vaultPath, args.directory);
    return {
      content: [{ type: "text", text: JSON.stringify(entries, null, 2) }],
    };
  }

  private async handleGetFile(args: Record<string, any>): Promise<ToolResult> {
    const vaultPath = this.resolveVault(args);
    const result = await readFileHandler(vaultPath, args.filename);

    if (args.format === "json") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                filename: args.filename,
                frontmatter: result.frontmatter,
                content: result.content,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    return { content: [{ type: "text", text: result.content }] };
  }

  private async handleCreateFile(args: Record<string, any>): Promise<ToolResult> {
    const vaultPath = this.resolveVault(args);
    await createFile(vaultPath, args.filename, args.content);
    return {
      content: [{ type: "text", text: "File created successfully" }],
    };
  }

  private async handleAppendFile(args: Record<string, any>): Promise<ToolResult> {
    const vaultPath = this.resolveVault(args);
    await appendFile(vaultPath, args.filename, args.content);
    return {
      content: [{ type: "text", text: "Content appended successfully" }],
    };
  }

  private async handlePatchFile(args: Record<string, any>): Promise<ToolResult> {
    const vaultPath = this.resolveVault(args);
    const result = await patchFile(
      vaultPath,
      args.filename,
      args.operation,
      args.targetType,
      args.target,
      args.content,
      {
        contentType: args.contentType,
        targetDelimiter: args.targetDelimiter,
        trimTargetWhitespace: args.trimTargetWhitespace,
      },
    );
    return {
      content: [
        { type: "text", text: "File patched successfully" },
        { type: "text", text: result },
      ],
    };
  }

  private async handleDeleteFile(args: Record<string, any>): Promise<ToolResult> {
    const vaultPath = this.resolveVault(args);
    deleteFileHandler(vaultPath, args.filename);
    return {
      content: [{ type: "text", text: "File deleted successfully" }],
    };
  }

  private async handleSearch(args: Record<string, any>): Promise<ToolResult> {
    const vaultPath = this.resolveVault(args);
    const matches = await searchInVault(vaultPath, args.query, args.directory, args.contextLength);
    return {
      content: [{ type: "text", text: JSON.stringify(matches, null, 2) }],
    };
  }
}
