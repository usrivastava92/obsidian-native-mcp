import { basename, dirname, extname, posix } from "path";

export interface FrontmatterData {
  [key: string]: any;
}

export interface ParsedFrontmatter {
  frontmatter: FrontmatterData;
  body: string;
  frontmatterLines: string[];
  bodyLines: string[];
}

export interface HeadingInfo {
  heading: string;
  level: number;
  startLine: number;
  endLine: number;
}

export interface HeadingMatch {
  lineIndex: number;
  level: number;
}

export interface LinkTargetParts {
  path: string;
  suffix: string;
}

export interface ExtractedLink {
  raw: string;
  target: string;
  display?: string;
  format: "wikilink" | "markdown";
}

export function splitLines(content: string): string[] {
  return content.split("\n");
}

export function lineCount(content: string): number {
  return content.length === 0 ? 0 : splitLines(content).length;
}

export function parseFrontmatter(content: string): ParsedFrontmatter | null {
  const lines = splitLines(content);
  if (lines[0]?.trim() !== "---") return null;

  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) return null;

  const frontmatterLines = lines.slice(1, endIndex);
  const bodyLines = lines.slice(endIndex + 1);
  const frontmatter: FrontmatterData = {};

  for (const line of frontmatterLines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    const rawValue = line.slice(colonIndex + 1).trim();
    frontmatter[key] = parseFrontmatterValue(rawValue);
  }

  return {
    frontmatter,
    body: bodyLines.join("\n"),
    frontmatterLines,
    bodyLines,
  };
}

export function serializeFrontmatterValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeFrontmatterScalar(item)).join(", ")}]`;
  }

  return serializeFrontmatterScalar(value);
}

function serializeFrontmatterScalar(value: unknown): string {
  if (typeof value === "string") {
    if (/[[\],:#]|^\s|\s$/.test(value)) {
      return JSON.stringify(value);
    }
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value == null) {
    return '""';
  }

  return JSON.stringify(value);
}

function parseFrontmatterValue(value: string): any {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }

  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);

  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => item.replace(/^["']|["']$/g, ""));
  }

  return value;
}

export function buildFrontmatter(frontmatterLines: string[], bodyLines: string[]): string {
  return ["---", ...frontmatterLines, "---", ...bodyLines].join("\n");
}

export function extractHeadings(content: string): HeadingInfo[] {
  const lines = splitLines(content);
  const matches: Array<{ lineIndex: number; level: number; heading: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!match) continue;

    matches.push({
      lineIndex: i,
      level: match[1].length,
      heading: match[2].trim(),
    });
  }

  return matches.map((match, index) => ({
    heading: match.heading,
    level: match.level,
    startLine: match.lineIndex + 1,
    endLine: findHeadingContentEnd(
      lines,
      match.lineIndex,
      match.level,
      index < matches.length - 1 ? matches[index + 1].lineIndex : undefined,
    ),
  }));
}

export function findHeadingLine(
  lines: string[],
  target: string,
  delimiter: string,
): HeadingMatch | null {
  const parts = target.split(delimiter).map((part) => part.trim());

  let currentLine = 0;
  for (const part of parts) {
    let found = false;
    for (let i = currentLine; i < lines.length; i++) {
      const headingMatch = lines[i].match(/^(#{1,6})\s+(.+?)\s*$/);
      if (headingMatch && headingMatch[2].trim() === part) {
        currentLine = i;
        found = true;
        break;
      }
    }

    if (!found) return null;
  }

  const match = lines[currentLine].match(/^(#{1,6})\s/);
  return { lineIndex: currentLine, level: match ? match[1].length : 1 };
}

export function getHeadingContentEnd(lines: string[], startLine: number, level: number): number {
  return findHeadingContentEnd(lines, startLine, level);
}

function findHeadingContentEnd(
  lines: string[],
  startLine: number,
  level: number,
  nextHeadingIndex?: number,
): number {
  if (typeof nextHeadingIndex === "number") {
    return nextHeadingIndex;
  }

  for (let i = startLine + 1; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s/);
    if (match && match[1].length <= level) {
      return i;
    }
  }

  return lines.length;
}

export function findBlockLine(lines: string[], target: string): number {
  const blockId = target.startsWith("^") ? target : `^${target}`;
  return lines.findIndex((line) => line.trim().endsWith(blockId));
}

export function extractTags(content: string): string[] {
  const tags = new Set<string>();
  const parsed = parseFrontmatter(content);
  const frontmatterTags = parsed?.frontmatter?.tags;

  if (Array.isArray(frontmatterTags)) {
    for (const tag of frontmatterTags) {
      if (typeof tag === "string" && tag.trim()) tags.add(normalizeTag(tag));
    }
  } else if (typeof frontmatterTags === "string" && frontmatterTags.trim()) {
    tags.add(normalizeTag(frontmatterTags));
  }

  const inlineMatches = content.match(/(^|[\s(])#([A-Za-z0-9/_-]+)/g) || [];
  for (const match of inlineMatches) {
    const normalized = match.trim().replace(/^[^(#\s]*/, "");
    tags.add(normalizeTag(normalized));
  }

  return Array.from(tags).sort();
}

export function extractAliases(frontmatter?: FrontmatterData): string[] {
  const aliases = frontmatter?.aliases;
  if (Array.isArray(aliases)) {
    return aliases.filter((value): value is string => typeof value === "string");
  }
  if (typeof aliases === "string" && aliases.trim()) {
    return [aliases];
  }
  return [];
}

export function extractLinks(content: string): ExtractedLink[] {
  const links: ExtractedLink[] = [];

  const wikilinkRegex = /\[\[([^\]|#]+(?:[#^][^\]|]+)?)(?:\|([^\]]+))?\]\]/g;
  let wikilinkMatch: RegExpExecArray | null;
  while ((wikilinkMatch = wikilinkRegex.exec(content)) !== null) {
    links.push({
      raw: wikilinkMatch[0],
      target: wikilinkMatch[1].trim(),
      display: wikilinkMatch[2]?.trim(),
      format: "wikilink",
    });
  }

  const markdownRegex = /\[([^\]]*)\]\(([^)\s]+(?:\s+"[^"]*")?)\)/g;
  let markdownMatch: RegExpExecArray | null;
  while ((markdownMatch = markdownRegex.exec(content)) !== null) {
    const target = markdownMatch[2].trim().split(/\s+"/)[0];
    links.push({
      raw: markdownMatch[0],
      target,
      display: markdownMatch[1],
      format: "markdown",
    });
  }

  return links;
}

export function splitLinkTarget(target: string): LinkTargetParts {
  const hashIndex = target.indexOf("#");
  const blockIndex = target.indexOf("^");
  const candidates = [hashIndex, blockIndex].filter((index) => index >= 0);

  if (candidates.length === 0) {
    return { path: target, suffix: "" };
  }

  const splitIndex = Math.min(...candidates);
  return {
    path: target.slice(0, splitIndex),
    suffix: target.slice(splitIndex),
  };
}

export function notePathCandidates(notePath: string): string[] {
  const normalized = toPosixPath(notePath);
  const noExt = stripMarkdownExtension(normalized);
  const base = basename(noExt);

  return Array.from(new Set([normalized, noExt, base]));
}

export function stripMarkdownExtension(filePath: string): string {
  return filePath.endsWith(".md") ? filePath.slice(0, -3) : filePath;
}

export function toPosixPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function relativeMarkdownLink(fromFile: string, toFile: string): string {
  const fromDir = dirname(toPosixPath(fromFile));
  const rel = posix.relative(fromDir === "." ? "" : fromDir, toPosixPath(toFile));
  return rel || basename(toFile);
}

export function vaultRelativeLinkTarget(filePath: string): string {
  return stripMarkdownExtension(toPosixPath(filePath));
}

export function basenameWithoutExtension(filePath: string): string {
  return basename(filePath, extname(filePath));
}

function normalizeTag(tag: string): string {
  return tag.startsWith("#") ? tag : `#${tag}`;
}
