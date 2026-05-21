/**
 * Shared types for obsidian-native-mcp v1.0.
 *
 * See DESIGN_V1.md §3 for the authoritative contract.
 */

import type { Root } from "mdast";

export type Hash = string; // "sha256:<hex>"
export type Vault = string;
export type RelPath = string; // POSIX-style, relative to vault root

export interface ParsedFile {
  path: RelPath;
  absPath: string;
  text: string; // canonicalised: BOM stripped, EOL = "\n"
  contentHash: Hash;
  mtimeMs: number;
  size: number;
  ast: Root;
  /** Byte offset of the start of line (i+1). Length = totalLines + 1 (sentinel = text.length). */
  lineOffsets: number[];
  totalLines: number;
  headings: HeadingInfo[];
  blocks: BlockInfo[];
  links: ExtractedLink[];
  tags: string[];
  frontmatter?: ParsedFrontmatter;
}

export interface HeadingInfo {
  id: string; // "h-1", "h-2" — stable for this parse
  /** Canonical "Parent::Child::Leaf" path, with `::` separator. */
  path: string;
  text: string; // raw heading text without leading #s
  level: 1 | 2 | 3 | 4 | 5 | 6;
  line: number; // 1-based, line of the heading itself
  endLine: number; // 1-based, last line belonging to this section (inclusive)
  sectionHash: Hash;
  childrenCount: number;
  /** When path is not unique within the file, the ids of the duplicates. */
  duplicateOf?: string[];
}

export type BlockStructuralType =
  | "paragraph"
  | "list-item"
  | "table-row"
  | "callout"
  | "code"
  | "heading"
  | "other";

export interface BlockInfo {
  id: string; // "^foo" — always normalised to leading-caret form
  line: number; // 1-based line containing the ^id marker
  startLine: number;
  endLine: number;
  blockHash: Hash;
  structuralType: BlockStructuralType;
}

export type ExtractedLink =
  | {
      kind: "wiki";
      target: string;
      alias?: string;
      line: number;
      col: number;
    }
  | {
      kind: "embed";
      target: string;
      alias?: string;
      line: number;
      col: number;
    }
  | {
      kind: "header-ref";
      target: string;
      heading: string;
      alias?: string;
      line: number;
      col: number;
    }
  | {
      kind: "block-ref";
      target: string;
      blockId: string;
      alias?: string;
      line: number;
      col: number;
    }
  | {
      kind: "markdown";
      text: string;
      url: string;
      line: number;
      col: number;
    };

export interface ParsedFrontmatter {
  /** Raw YAML body (without the `---` delimiters). */
  raw: string;
  /** Parsed YAML data. */
  data: Record<string, unknown>;
  /** Hash of the entire frontmatter block including delimiters. */
  frontmatterHash: Hash;
  /** Line range (1-based, inclusive) the frontmatter occupies in the file. */
  startLine: number;
  endLine: number;
}

// ---------------------------------------------------------------------------
// Error envelope returned by every tool handler on failure.
// ---------------------------------------------------------------------------

export type ToolErrorCode =
  | "NOT_FOUND"
  | "DUPLICATE_TARGET"
  | "STALE_PRECONDITION"
  | "PERMISSION_DENIED"
  | "INVALID_ARGS"
  | "DESTINATION_EXISTS"
  | "IO_ERROR"
  | "PARSE_ERROR"
  | "INTERNAL";

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export class ToolFailure extends Error {
  readonly code: ToolErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: ToolErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "ToolFailure";
  }
  toJSON(): ToolError {
    return { code: this.code, message: this.message, details: this.details };
  }
}
