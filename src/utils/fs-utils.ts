import { readdirSync, statSync, unlinkSync, mkdirSync } from "fs";
import { join, dirname, relative } from "path";

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  mtime?: Date;
}

export function listFiles(vaultPath: string, directory?: string): FileEntry[] {
  const targetDir = directory ? join(vaultPath, directory) : vaultPath;

  if (!Bun.file(targetDir).exists()) {
    throw new Error(`Directory not found: ${targetDir}`);
  }

  const entries = readdirSync(targetDir);
  const result: FileEntry[] = [];

  for (const entry of entries) {
    const fullPath = join(targetDir, entry);
    const stat = statSync(fullPath);
    result.push({
      name: entry,
      path: relative(vaultPath, fullPath),
      type: stat.isDirectory() ? "directory" : "file",
      size: stat.size,
      mtime: stat.mtime,
    });
  }

  return result.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export async function readFile(
  vaultPath: string,
  filename: string,
): Promise<{ content: string; frontmatter?: Record<string, any> }> {
  const fullPath = join(vaultPath, filename);
  const bunFile = Bun.file(fullPath);

  if (!(await bunFile.exists())) {
    throw new Error(`File not found: ${filename}`);
  }

  const stat = statSync(fullPath);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${filename}`);
  }

  const content = await bunFile.text();
  const parsed = parseFrontmatter(content);

  return {
    content,
    frontmatter: parsed?.frontmatter,
  };
}

export async function createFile(
  vaultPath: string,
  filename: string,
  content: string,
): Promise<void> {
  const fullPath = join(vaultPath, filename);
  const dir = dirname(fullPath);

  if (!Bun.file(dir).exists()) {
    mkdirSync(dir, { recursive: true });
  }

  await Bun.write(fullPath, content);
}

export async function appendFile(
  vaultPath: string,
  filename: string,
  content: string,
): Promise<void> {
  const fullPath = join(vaultPath, filename);
  const dir = dirname(fullPath);

  if (!Bun.file(dir).exists()) {
    mkdirSync(dir, { recursive: true });
  }

  const bunFile = Bun.file(fullPath);
  let existing = "";
  if (await bunFile.exists()) {
    existing = await bunFile.text();
  }

  await Bun.write(fullPath, existing + content);
}

export function deleteFile(vaultPath: string, filename: string): void {
  const fullPath = join(vaultPath, filename);

  if (!Bun.file(fullPath).exists()) {
    throw new Error(`File not found: ${filename}`);
  }

  unlinkSync(fullPath);
}

export async function patchFile(
  vaultPath: string,
  filename: string,
  operation: "append" | "prepend" | "replace",
  targetType: "heading" | "block" | "frontmatter",
  target: string,
  content: string,
  options?: {
    contentType?: string;
    targetDelimiter?: string;
    trimTargetWhitespace?: boolean;
  },
): Promise<string> {
  const fullPath = join(vaultPath, filename);
  const bunFile = Bun.file(fullPath);

  if (!(await bunFile.exists())) {
    throw new Error(`File not found: ${filename}`);
  }

  const fileContent = await bunFile.text();
  let modified: string;

  if (targetType === "frontmatter") {
    modified = patchFrontmatter(fileContent, operation, target, content);
  } else if (targetType === "heading") {
    modified = patchHeading(fileContent, operation, target, content, options);
  } else if (targetType === "block") {
    modified = patchBlock(fileContent, operation, target, content);
  } else {
    throw new Error(`Unsupported target type: ${targetType}`);
  }

  await Bun.write(fullPath, modified);
  return modified;
}

function parseFrontmatter(
  content: string,
): { frontmatter: Record<string, any>; body: string } | null {
  if (!content.startsWith("---")) return null;

  const endIndex = content.indexOf("---", 3);
  if (endIndex === -1) return null;

  const raw = content.slice(3, endIndex).trim();
  const body = content.slice(endIndex + 3).trim();
  const frontmatter: Record<string, any> = {};

  for (const line of raw.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    let value: any = line.slice(colonIndex + 1).trim();

    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    } else if (value.startsWith("[") && value.endsWith("]")) {
      value = value
        .slice(1, -1)
        .split(",")
        .map((s: string) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    }

    frontmatter[key] = value;
  }

  return { frontmatter, body };
}

function patchFrontmatter(
  content: string,
  operation: "append" | "prepend" | "replace",
  target: string,
  newContent: string,
): string {
  const parsed = parseFrontmatter(content);

  if (operation === "replace" && target === "all") {
    if (parsed) {
      return `---\n${newContent}\n---\n\n${parsed.body}`;
    }
    return `---\n${newContent}\n---\n\n${content}`;
  }

  if (parsed) {
    const lines = content.split("\n");
    let fmEnd = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        fmEnd = i;
        break;
      }
    }

    const fmLines = lines.slice(1, fmEnd);
    const bodyLines = lines.slice(fmEnd + 1);

    if (operation === "replace") {
      const existing = fmLines.findIndex((l) => l.trim().startsWith(target + ":"));
      if (existing !== -1) {
        fmLines[existing] = `${target}: ${newContent}`;
      } else {
        fmLines.push(`${target}: ${newContent}`);
      }
    } else if (operation === "append") {
      fmLines.push(`${target}: ${newContent}`);
    }

    return ["---", ...fmLines, "---", "", ...bodyLines].join("\n");
  }

  if (operation === "replace" || operation === "append") {
    return `---\n${target}: ${newContent}\n---\n\n${content}`;
  }

  return content;
}

function findHeadingLine(
  lines: string[],
  target: string,
  delimiter: string,
): { lineIndex: number; level: number } | null {
  const parts = target.split(delimiter).map((s) => s.trim());

  let currentLine = 0;
  for (const part of parts) {
    let found = false;
    for (let i = currentLine; i < lines.length; i++) {
      const headingMatch = lines[i].match(/^(#{1,6})\s+(.+)$/);
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

function getHeadingContentEnd(lines: string[], startLine: number, level: number): number {
  for (let i = startLine + 1; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s/);
    if (match && match[1].length <= level) {
      return i;
    }
  }
  return lines.length;
}

function patchHeading(
  content: string,
  operation: "append" | "prepend" | "replace",
  target: string,
  newContent: string,
  options?: any,
): string {
  const delimiter = options?.targetDelimiter || "::";
  const lines = content.split("\n");
  const heading = findHeadingLine(lines, target, delimiter);

  if (!heading) {
    if (operation === "replace") return content;
    const targetParts = target.split(delimiter).map((s) => s.trim());
    const lastPart = targetParts[targetParts.length - 1];
    return content + `\n\n## ${lastPart}\n\n${newContent}`;
  }

  const sectionEnd = getHeadingContentEnd(lines, heading.lineIndex, heading.level);

  if (operation === "replace") {
    const newLines = [
      ...lines.slice(0, heading.lineIndex + 1),
      newContent,
      ...lines.slice(sectionEnd),
    ];
    return newLines.join("\n");
  }

  if (operation === "append") {
    const newLines = [...lines.slice(0, sectionEnd), newContent, ...lines.slice(sectionEnd)];
    return newLines.join("\n");
  }

  if (operation === "prepend") {
    const newLines = [
      ...lines.slice(0, heading.lineIndex + 1),
      newContent,
      ...lines.slice(heading.lineIndex + 1),
    ];
    return newLines.join("\n");
  }

  return content;
}

function patchBlock(
  content: string,
  operation: "append" | "prepend" | "replace",
  target: string,
  newContent: string,
): string {
  const blockId = target.startsWith("^") ? target : `^${target}`;
  const lines = content.split("\n");
  const blockIndex = lines.findIndex((l) => l.trim().endsWith(blockId));

  if (blockIndex === -1) {
    if (operation === "replace") return content;
    return content + `\n\n${newContent} ${blockId}`;
  }

  if (operation === "replace") {
    lines[blockIndex] = lines[blockIndex].replace(/^(.*?)(\s+\^\w+)?$/, `${newContent} ${blockId}`);
    return lines.join("\n");
  }

  if (operation === "append") {
    lines.splice(blockIndex + 1, 0, newContent);
    return lines.join("\n");
  }

  if (operation === "prepend") {
    lines.splice(blockIndex, 0, newContent);
    return lines.join("\n");
  }

  return content;
}
