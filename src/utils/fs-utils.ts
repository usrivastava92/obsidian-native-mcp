import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { access, readFile, rename, rm, writeFile } from "fs/promises";
import { basename, dirname, extname, join, posix, relative, resolve } from "path";
import {
  buildFrontmatter,
  extractAliases,
  extractHeadings,
  extractLinks,
  extractTags,
  findBlockLine,
  findHeadingLine,
  getHeadingContentEnd,
  lineCount,
  notePathCandidates,
  parseFrontmatter,
  relativeMarkdownLink,
  serializeFrontmatterValue,
  splitLines,
  splitLinkTarget,
  stripMarkdownExtension,
  toPosixPath,
  vaultRelativeLinkTarget,
} from "./markdown";

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
  modifiedTime: string;
}

export interface FileReadResult {
  content: string;
  frontmatter?: Record<string, any>;
}

export interface DeleteFileResult {
  existed: boolean;
  deleted: boolean;
  trashed: boolean;
  path: string;
}

export interface ReplaceFileResult {
  action: "created" | "replaced";
  linesBefore: number;
  linesAfter: number;
  path: string;
}

export interface PatchFileResult {
  changed: boolean;
  targetFound: boolean;
  path: string;
  operation: "append" | "prepend" | "replace" | "delete";
  targetType: "heading" | "block" | "frontmatter";
  patchedContent?: string;
}

export interface MoveFileResult {
  oldPath: string;
  newPath: string;
  updatedReferences: number;
  skippedAmbiguousReferences: number;
}

export interface SearchFileMatch {
  path: string;
  name: string;
}

export interface MetadataResult {
  path: string;
  frontmatter: Record<string, any>;
  headings: Array<{ heading: string; level: number; startLine: number; endLine: number }>;
  tags: string[];
  aliases: string[];
  wordCount: number;
  modifiedTime: string;
}

export interface LinkRecord {
  source: string;
  target: string;
  raw: string;
  resolvedPath?: string;
  kind: "wikilink" | "markdown";
}

export interface LinkQueryResult {
  path: string;
  backlinks?: { resolved: LinkRecord[]; unresolved: LinkRecord[] };
  outlinks?: { resolved: LinkRecord[]; unresolved: LinkRecord[] };
}

export interface BulkPatchOperation {
  filename: string;
  operation: "append" | "prepend" | "replace" | "delete";
  targetType: "heading" | "block" | "frontmatter";
  target: string;
  content?: string;
  contentType?: string;
  targetDelimiter?: string;
  trimTargetWhitespace?: boolean;
}

export interface BulkPatchResult {
  atomic: boolean;
  successCount: number;
  failureCount: number;
  results: Array<PatchFileResult & { error?: string }>;
}

interface PatchOptions {
  contentType?: string;
  targetDelimiter?: string;
  trimTargetWhitespace?: boolean;
  dryRun?: boolean;
}

interface PatchComputationResult extends PatchFileResult {
  nextContent: string;
}

const TRASH_DIRECTORY = ".trash";

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readTextFile(path: string): Promise<string> {
  return readFile(path, "utf-8");
}

async function writeTextFileAtomic(path: string, content: string): Promise<void> {
  const dir = dirname(path);
  await ensureDirectory(dir);
  const tempPath = join(
    dir,
    `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await writeFile(tempPath, content, "utf-8");
  await rename(tempPath, path);
}

async function ensureDirectory(path: string): Promise<void> {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function ensureDirectorySync(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function toRelativePath(vaultPath: string, targetPath: string): string {
  return toPosixPath(relative(vaultPath, targetPath));
}

export function resolveVaultPath(vaultPath: string, relativePath: string): string {
  const root = resolve(vaultPath);
  const target = resolve(root, relativePath);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`Path escapes vault root: ${relativePath}`);
  }
  if (rel === "" && relativePath.includes("..")) {
    throw new Error(`Path escapes vault root: ${relativePath}`);
  }

  return target;
}

function assertFile(fullPath: string, label: string): void {
  const stat = statSync(fullPath);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${label}`);
  }
}

export function listFiles(
  vaultPath: string,
  directory?: string,
  recursive: boolean = false,
): FileEntry[] {
  const targetDir = directory ? resolveVaultPath(vaultPath, directory) : resolve(vaultPath);

  if (!existsSync(targetDir)) {
    throw new Error(`Directory not found: ${directory || "."}`);
  }

  if (!statSync(targetDir).isDirectory()) {
    throw new Error(`Not a directory: ${directory || "."}`);
  }

  const result: FileEntry[] = [];
  collectEntries(vaultPath, targetDir, recursive, result);

  return result.sort((a, b) => a.path.localeCompare(b.path));
}

function collectEntries(
  vaultPath: string,
  dirPath: string,
  recursive: boolean,
  result: FileEntry[],
): void {
  for (const entry of readdirSync(dirPath)) {
    const fullPath = join(dirPath, entry);
    const stat = statSync(fullPath);
    const fileEntry: FileEntry = {
      name: entry,
      path: toRelativePath(vaultPath, fullPath),
      type: stat.isDirectory() ? "directory" : "file",
      size: stat.size,
      modifiedTime: stat.mtime.toISOString(),
    };
    result.push(fileEntry);

    if (recursive && stat.isDirectory() && !entry.startsWith(".")) {
      collectEntries(vaultPath, fullPath, true, result);
    }
  }
}

export async function readFileHandler(
  vaultPath: string,
  filename: string,
): Promise<FileReadResult> {
  const fullPath = resolveVaultPath(vaultPath, filename);

  if (!(await fileExists(fullPath))) {
    throw new Error(`File not found: ${filename}`);
  }

  assertFile(fullPath, filename);

  const content = await readTextFile(fullPath);
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
  const fullPath = resolveVaultPath(vaultPath, filename);
  await ensureDirectory(dirname(fullPath));
  await writeTextFileAtomic(fullPath, content);
}

export async function appendFile(
  vaultPath: string,
  filename: string,
  content: string,
): Promise<void> {
  const fullPath = resolveVaultPath(vaultPath, filename);
  await ensureDirectory(dirname(fullPath));

  let existing = "";
  if (await fileExists(fullPath)) {
    assertFile(fullPath, filename);
    existing = await readTextFile(fullPath);
  }

  await writeTextFileAtomic(fullPath, existing + content);
}

export async function deleteFileHandler(
  vaultPath: string,
  filename: string,
  options?: { trash?: boolean; dryRun?: boolean },
): Promise<DeleteFileResult> {
  const fullPath = resolveVaultPath(vaultPath, filename);
  const normalizedPath = toRelativePath(vaultPath, fullPath);
  const exists = existsSync(fullPath);

  if (!exists) {
    return {
      existed: false,
      deleted: false,
      trashed: false,
      path: normalizedPath,
    };
  }

  assertFile(fullPath, filename);

  if (options?.dryRun) {
    return {
      existed: true,
      deleted: false,
      trashed: Boolean(options.trash),
      path: normalizedPath,
    };
  }

  if (options?.trash) {
    const trashDir = resolveVaultPath(vaultPath, TRASH_DIRECTORY);
    ensureDirectorySync(trashDir);
    const trashTarget = uniquePath(join(trashDir, basename(fullPath)));
    renameSync(fullPath, trashTarget);
    return {
      existed: true,
      deleted: true,
      trashed: true,
      path: normalizedPath,
    };
  }

  unlinkSync(fullPath);
  return {
    existed: true,
    deleted: true,
    trashed: false,
    path: normalizedPath,
  };
}

export async function replaceFile(
  vaultPath: string,
  filename: string,
  content: string,
  options?: { createIfMissing?: boolean; dryRun?: boolean },
): Promise<ReplaceFileResult> {
  const fullPath = resolveVaultPath(vaultPath, filename);
  const exists = await fileExists(fullPath);

  if (!exists && !options?.createIfMissing) {
    throw new Error(`File not found: ${filename}`);
  }

  let before = 0;
  if (exists) {
    assertFile(fullPath, filename);
    before = lineCount(await readTextFile(fullPath));
  }

  if (!options?.dryRun) {
    await ensureDirectory(dirname(fullPath));
    await writeTextFileAtomic(fullPath, content);
  }

  return {
    action: exists ? "replaced" : "created",
    linesBefore: before,
    linesAfter: lineCount(content),
    path: toRelativePath(vaultPath, fullPath),
  };
}

export async function patchFile(
  vaultPath: string,
  filename: string,
  operation: "append" | "prepend" | "replace" | "delete",
  targetType: "heading" | "block" | "frontmatter",
  target: string,
  content: string = "",
  options?: PatchOptions,
): Promise<PatchFileResult> {
  const fullPath = resolveVaultPath(vaultPath, filename);
  const result = await computePatch(
    vaultPath,
    fullPath,
    filename,
    operation,
    targetType,
    target,
    content,
    options,
  );

  if (!options?.dryRun && result.changed) {
    await writeTextFileAtomic(fullPath, result.nextContent);
  }

  return stripPatchComputation(result, options?.dryRun);
}

async function computePatch(
  vaultPath: string,
  fullPath: string,
  filename: string,
  operation: "append" | "prepend" | "replace" | "delete",
  targetType: "heading" | "block" | "frontmatter",
  target: string,
  content: string,
  options?: PatchOptions,
): Promise<PatchComputationResult> {
  if (!(await fileExists(fullPath))) {
    throw new Error(`File not found: ${filename}`);
  }

  assertFile(fullPath, filename);

  const fileContent = await readTextFile(fullPath);
  const patchResult =
    targetType === "frontmatter"
      ? patchFrontmatter(fileContent, operation, target, content)
      : targetType === "heading"
        ? patchHeading(fileContent, operation, target, content, options)
        : patchBlock(fileContent, operation, target, content);

  return {
    changed: patchResult.content !== fileContent,
    targetFound: patchResult.targetFound,
    path: toRelativePath(vaultPath, fullPath),
    operation,
    targetType,
    patchedContent: options?.dryRun ? patchResult.content : undefined,
    nextContent: patchResult.content,
  };
}

function stripPatchComputation(
  result: PatchComputationResult,
  dryRun: boolean | undefined,
): PatchFileResult {
  return {
    changed: result.changed,
    targetFound: result.targetFound,
    path: result.path,
    operation: result.operation,
    targetType: result.targetType,
    patchedContent: dryRun ? result.patchedContent : undefined,
  };
}

function patchFrontmatter(
  content: string,
  operation: "append" | "prepend" | "replace" | "delete",
  target: string,
  newContent: string,
): { content: string; targetFound: boolean } {
  const parsed = parseFrontmatter(content);

  if (operation === "replace" && target === "all") {
    if (parsed) {
      return {
        content: buildFrontmatter(splitLines(newContent), parsed.bodyLines),
        targetFound: true,
      };
    }

    return {
      content: buildFrontmatter(splitLines(newContent), splitLines(content)),
      targetFound: false,
    };
  }

  const frontmatterLines = parsed ? [...parsed.frontmatterLines] : [];
  const bodyLines = parsed ? parsed.bodyLines : splitLines(content);
  const existingIndex = frontmatterLines.findIndex((line) => line.trim().startsWith(`${target}:`));

  if (operation === "delete") {
    if (existingIndex === -1) {
      return { content, targetFound: false };
    }
    frontmatterLines.splice(existingIndex, 1);
    if (frontmatterLines.length === 0) {
      return { content: bodyLines.join("\n"), targetFound: true };
    }
    return { content: buildFrontmatter(frontmatterLines, bodyLines), targetFound: true };
  }

  if (operation === "replace") {
    const line = `${target}: ${newContent}`;
    if (existingIndex === -1) {
      frontmatterLines.push(line);
      return {
        content: buildFrontmatter(frontmatterLines, bodyLines),
        targetFound: false,
      };
    }
    frontmatterLines[existingIndex] = line;
    return { content: buildFrontmatter(frontmatterLines, bodyLines), targetFound: true };
  }

  const insertedLine = `${target}: ${newContent}`;
  if (operation === "prepend") {
    frontmatterLines.unshift(insertedLine);
  } else {
    frontmatterLines.push(insertedLine);
  }

  return {
    content: buildFrontmatter(frontmatterLines, bodyLines),
    targetFound: existingIndex !== -1,
  };
}

function patchHeading(
  content: string,
  operation: "append" | "prepend" | "replace" | "delete",
  target: string,
  newContent: string,
  options?: PatchOptions,
): { content: string; targetFound: boolean } {
  const delimiter = options?.targetDelimiter || "::";
  const lines = splitLines(content);
  const heading = findHeadingLine(lines, target, delimiter);

  if (!heading) {
    if (operation === "append" || operation === "prepend") {
      const targetParts = target.split(delimiter).map((part) => part.trim());
      const lastPart = targetParts[targetParts.length - 1];
      return {
        content: `${content}\n\n## ${lastPart}\n\n${newContent}`,
        targetFound: false,
      };
    }

    return { content, targetFound: false };
  }

  const sectionEnd = getHeadingContentEnd(lines, heading.lineIndex, heading.level);

  if (operation === "delete") {
    const nextLines = [...lines.slice(0, heading.lineIndex), ...lines.slice(sectionEnd)];
    return {
      content: trimEmptyEdges(nextLines.join("\n")),
      targetFound: true,
    };
  }

  if (operation === "replace") {
    return {
      content: [
        ...lines.slice(0, heading.lineIndex + 1),
        newContent,
        ...lines.slice(sectionEnd),
      ].join("\n"),
      targetFound: true,
    };
  }

  if (operation === "append") {
    return {
      content: [...lines.slice(0, sectionEnd), newContent, ...lines.slice(sectionEnd)].join("\n"),
      targetFound: true,
    };
  }

  return {
    content: [
      ...lines.slice(0, heading.lineIndex + 1),
      newContent,
      ...lines.slice(heading.lineIndex + 1),
    ].join("\n"),
    targetFound: true,
  };
}

function patchBlock(
  content: string,
  operation: "append" | "prepend" | "replace" | "delete",
  target: string,
  newContent: string,
): { content: string; targetFound: boolean } {
  const blockId = target.startsWith("^") ? target : `^${target}`;
  const lines = splitLines(content);
  const blockIndex = findBlockLine(lines, target);

  if (blockIndex === -1) {
    if (operation === "append" || operation === "prepend") {
      return {
        content: `${content}\n\n${newContent} ${blockId}`,
        targetFound: false,
      };
    }

    return { content, targetFound: false };
  }

  if (operation === "delete") {
    lines.splice(blockIndex, 1);
    return { content: lines.join("\n"), targetFound: true };
  }

  if (operation === "replace") {
    lines[blockIndex] = lines[blockIndex].replace(
      /^(.*?)(\s+\^[\w-]+)?$/,
      `${newContent} ${blockId}`,
    );
    return { content: lines.join("\n"), targetFound: true };
  }

  if (operation === "append") {
    lines.splice(blockIndex + 1, 0, newContent);
  } else {
    lines.splice(blockIndex, 0, newContent);
  }

  return { content: lines.join("\n"), targetFound: true };
}

export async function replaceSection(
  vaultPath: string,
  filename: string,
  heading: string,
  content: string,
  options?: { createIfMissing?: boolean; dryRun?: boolean; targetDelimiter?: string },
): Promise<PatchFileResult> {
  const fullPath = resolveVaultPath(vaultPath, filename);
  const exists = await fileExists(fullPath);

  if (!exists) {
    if (!options?.createIfMissing) {
      throw new Error(`File not found: ${filename}`);
    }

    const headingName =
      heading
        .split(options?.targetDelimiter || "::")
        .pop()
        ?.trim() || heading;
    const nextContent = `## ${headingName}\n${content}`;
    if (!options?.dryRun) {
      await ensureDirectory(dirname(fullPath));
      await writeTextFileAtomic(fullPath, nextContent);
    }

    return {
      changed: true,
      targetFound: false,
      path: toRelativePath(vaultPath, fullPath),
      operation: "replace",
      targetType: "heading",
      patchedContent: options?.dryRun ? nextContent : undefined,
    };
  }

  const originalContent = await readTextFile(fullPath);
  const result = await computePatch(
    vaultPath,
    fullPath,
    filename,
    "replace",
    "heading",
    heading,
    content,
    { targetDelimiter: options?.targetDelimiter, dryRun: options?.dryRun },
  );

  if (!result.targetFound && !options?.createIfMissing) {
    throw new Error(`Heading not found: ${heading}`);
  }

  let nextContent = result.nextContent;
  if (!result.targetFound && options?.createIfMissing) {
    const headingName =
      heading
        .split(options?.targetDelimiter || "::")
        .pop()
        ?.trim() || heading;
    nextContent = `${originalContent}\n\n## ${headingName}\n${content}`;
  }

  if (!options?.dryRun && nextContent !== originalContent) {
    await writeTextFileAtomic(fullPath, nextContent);
  }

  return {
    changed: nextContent !== originalContent,
    targetFound: result.targetFound,
    path: result.path,
    operation: "replace",
    targetType: "heading",
    patchedContent: options?.dryRun ? nextContent : undefined,
  };
}

export async function moveFile(
  vaultPath: string,
  from: string,
  to: string,
  options?: { updateLinks?: boolean; dryRun?: boolean },
): Promise<MoveFileResult> {
  const fromPath = resolveVaultPath(vaultPath, from);
  const toPath = resolveVaultPath(vaultPath, to);

  if (!(await fileExists(fromPath))) {
    throw new Error(`File not found: ${from}`);
  }

  assertFile(fromPath, from);
  await ensureDirectory(dirname(toPath));

  let updatedReferences = 0;
  let skippedAmbiguousReferences = 0;

  if (options?.updateLinks) {
    const rewritePlan = await buildLinkRewritePlan(vaultPath, fromPath, toPath);
    updatedReferences = rewritePlan.updatedReferences;
    skippedAmbiguousReferences = rewritePlan.skippedAmbiguousReferences;

    if (!options?.dryRun) {
      for (const [filePath, nextContent] of rewritePlan.updates.entries()) {
        await writeTextFileAtomic(filePath, nextContent);
      }
    }
  }

  if (!options?.dryRun) {
    await rename(fromPath, toPath);
  }

  return {
    oldPath: toRelativePath(vaultPath, fromPath),
    newPath: toRelativePath(vaultPath, toPath),
    updatedReferences,
    skippedAmbiguousReferences,
  };
}

async function buildLinkRewritePlan(
  vaultPath: string,
  fromPath: string,
  toPath: string,
): Promise<{
  updates: Map<string, string>;
  updatedReferences: number;
  skippedAmbiguousReferences: number;
}> {
  const files = listMarkdownFiles(vaultPath);
  const updates = new Map<string, string>();
  let updatedReferences = 0;
  let skippedAmbiguousReferences = 0;

  const oldRelative = toRelativePath(vaultPath, fromPath);
  const newRelative = toRelativePath(vaultPath, toPath);

  for (const filePath of files) {
    const original = await readTextFile(filePath);
    let updated = original;
    const sourceRelative = toRelativePath(vaultPath, filePath);

    for (const link of extractLinks(original)) {
      const resolution = resolveLinkTarget(vaultPath, filePath, link.target);
      if (resolution.resolvedPath !== oldRelative) continue;
      if (!resolution.isUnique) {
        skippedAmbiguousReferences++;
        continue;
      }

      const replacement =
        link.format === "wikilink"
          ? buildWikilinkReplacement(link.target, link.display, newRelative)
          : buildMarkdownLinkReplacement(
              sourceRelative,
              link.display || "",
              link.target,
              newRelative,
            );

      if (replacement !== link.raw) {
        updated = updated.replace(link.raw, replacement);
        updatedReferences++;
      }
    }

    if (updated !== original) {
      updates.set(filePath, updated);
    }
  }

  return { updates, updatedReferences, skippedAmbiguousReferences };
}

function buildWikilinkReplacement(
  target: string,
  display: string | undefined,
  newRelativePath: string,
): string {
  const parts = splitLinkTarget(target);
  const nextTarget = `${vaultRelativeLinkTarget(newRelativePath)}${parts.suffix}`;
  return display ? `[[${nextTarget}|${display}]]` : `[[${nextTarget}]]`;
}

function buildMarkdownLinkReplacement(
  sourceFile: string,
  display: string,
  target: string,
  newRelativePath: string,
): string {
  const parts = splitLinkTarget(target);
  const sourceRelative = toPosixPath(sourceFile);
  const nextTarget = `${relativeMarkdownLink(sourceRelative, newRelativePath)}${parts.suffix}`;
  return `[${display}](${nextTarget})`;
}

function resolveLinkTarget(
  vaultPath: string,
  sourceFile: string,
  target: string,
): { matchesTarget: boolean; isUnique: boolean; resolvedPath?: string } {
  const parts = splitLinkTarget(target);
  const candidate = parts.path.trim();
  if (!candidate) {
    return { matchesTarget: false, isUnique: false };
  }

  const allMarkdownFiles = listMarkdownFiles(vaultPath).map((file) =>
    toRelativePath(vaultPath, file),
  );
  const sourceRelative = toRelativePath(vaultPath, sourceFile);
  const candidates = new Set<string>();

  if (candidate.startsWith("/")) {
    const normalized = stripMarkdownExtension(candidate.slice(1));
    for (const file of allMarkdownFiles) {
      if (stripMarkdownExtension(file) === normalized) candidates.add(file);
    }
  } else if (candidate.includes("/")) {
    const sourceDir = posix.dirname(toPosixPath(sourceRelative));
    const normalized = stripMarkdownExtension(
      posix.normalize(posix.join(sourceDir === "." ? "" : sourceDir, candidate)),
    );
    for (const file of allMarkdownFiles) {
      if (stripMarkdownExtension(file) === normalized) candidates.add(file);
    }
  } else {
    for (const file of allMarkdownFiles) {
      const matchCandidates = notePathCandidates(file);
      if (matchCandidates.includes(candidate)) candidates.add(file);
    }
  }

  const resolved = Array.from(candidates);
  return {
    matchesTarget: resolved.length > 0,
    isUnique: resolved.length === 1,
    resolvedPath: resolved[0],
  };
}

export async function searchFiles(
  vaultPath: string,
  query: string,
  options?: { directory?: string; mode?: "exact" | "substring" | "glob" | "regex" },
): Promise<SearchFileMatch[]> {
  const directory = options?.directory
    ? resolveVaultPath(vaultPath, options.directory)
    : resolve(vaultPath);
  const entries = listFiles(vaultPath, toRelativePath(vaultPath, directory), true).filter(
    (entry) => entry.type === "file",
  );
  const mode = options?.mode || "substring";

  return entries
    .filter((entry) => fileSearchMatches(entry.path, query, mode))
    .map((entry) => ({
      path: entry.path,
      name: basename(entry.path),
    }));
}

function fileSearchMatches(
  filePath: string,
  query: string,
  mode: "exact" | "substring" | "glob" | "regex",
): boolean {
  const candidates = [filePath, basename(filePath), basename(filePath, extname(filePath))];

  if (mode === "exact") {
    return candidates.some((candidate) => candidate === query);
  }

  if (mode === "regex") {
    const regex = new RegExp(query);
    return candidates.some((candidate) => regex.test(candidate));
  }

  if (mode === "glob") {
    const regex = new RegExp(
      `^${query
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".")}$`,
    );
    return candidates.some((candidate) => regex.test(candidate));
  }

  const lower = query.toLowerCase();
  return candidates.some((candidate) => candidate.toLowerCase().includes(lower));
}

export async function readMetadata(vaultPath: string, filename: string): Promise<MetadataResult> {
  const fullPath = resolveVaultPath(vaultPath, filename);

  if (!(await fileExists(fullPath))) {
    throw new Error(`File not found: ${filename}`);
  }

  assertFile(fullPath, filename);

  const content = await readTextFile(fullPath);
  const parsed = parseFrontmatter(content);
  const stat = statSync(fullPath);

  return {
    path: toRelativePath(vaultPath, fullPath),
    frontmatter: parsed?.frontmatter || {},
    headings: extractHeadings(content),
    tags: extractTags(content),
    aliases: extractAliases(parsed?.frontmatter),
    wordCount: countWords(content),
    modifiedTime: stat.mtime.toISOString(),
  };
}

export async function getLinks(
  vaultPath: string,
  filename: string,
  direction: "backlinks" | "outlinks" | "both",
): Promise<LinkQueryResult> {
  const fullPath = resolveVaultPath(vaultPath, filename);

  if (!(await fileExists(fullPath))) {
    throw new Error(`File not found: ${filename}`);
  }

  assertFile(fullPath, filename);

  const targetRelative = toRelativePath(vaultPath, fullPath);
  const allFiles = listMarkdownFiles(vaultPath);
  const outlinksResult = { resolved: [] as LinkRecord[], unresolved: [] as LinkRecord[] };
  const backlinksResult = { resolved: [] as LinkRecord[], unresolved: [] as LinkRecord[] };

  for (const file of allFiles) {
    const content = await readTextFile(file);
    const sourceRelative = toRelativePath(vaultPath, file);

    for (const link of extractLinks(content)) {
      const resolution = resolveLinkTarget(vaultPath, file, link.target);
      const record: LinkRecord = {
        source: sourceRelative,
        target: link.target,
        raw: link.raw,
        resolvedPath: resolution.resolvedPath,
        kind: link.format,
      };

      if (sourceRelative === targetRelative && (direction === "outlinks" || direction === "both")) {
        if (resolution.resolvedPath) outlinksResult.resolved.push(record);
        else outlinksResult.unresolved.push(record);
      }

      if (
        resolution.resolvedPath === targetRelative &&
        (direction === "backlinks" || direction === "both")
      ) {
        backlinksResult.resolved.push(record);
      }
    }
  }

  const result: LinkQueryResult = { path: targetRelative };
  if (direction === "backlinks" || direction === "both") result.backlinks = backlinksResult;
  if (direction === "outlinks" || direction === "both") result.outlinks = outlinksResult;
  return result;
}

export async function bulkPatch(
  vaultPath: string,
  operations: BulkPatchOperation[],
  options?: { atomic?: boolean; dryRun?: boolean },
): Promise<BulkPatchResult> {
  const atomic = Boolean(options?.atomic);

  if (atomic) {
    const computed: Array<{ path: string; result: PatchComputationResult }> = [];
    for (const operation of operations) {
      const fullPath = resolveVaultPath(vaultPath, operation.filename);
      const result = await computePatch(
        vaultPath,
        fullPath,
        operation.filename,
        operation.operation,
        operation.targetType,
        operation.target,
        operation.content || "",
        {
          contentType: operation.contentType,
          targetDelimiter: operation.targetDelimiter,
          trimTargetWhitespace: operation.trimTargetWhitespace,
          dryRun: options?.dryRun,
        },
      );
      computed.push({ path: fullPath, result });
    }

    if (!options?.dryRun) {
      for (const item of computed) {
        if (item.result.changed) {
          await writeTextFileAtomic(item.path, item.result.nextContent);
        }
      }
    }

    return {
      atomic: true,
      successCount: computed.length,
      failureCount: 0,
      results: computed.map((item) => stripPatchComputation(item.result, options?.dryRun)),
    };
  }

  const results: Array<PatchFileResult & { error?: string }> = [];
  for (const operation of operations) {
    try {
      const result = await patchFile(
        vaultPath,
        operation.filename,
        operation.operation,
        operation.targetType,
        operation.target,
        operation.content || "",
        {
          contentType: operation.contentType,
          targetDelimiter: operation.targetDelimiter,
          trimTargetWhitespace: operation.trimTargetWhitespace,
          dryRun: options?.dryRun,
        },
      );
      results.push(result);
    } catch (error: any) {
      results.push({
        changed: false,
        targetFound: false,
        path: operation.filename,
        operation: operation.operation,
        targetType: operation.targetType,
        error: error.message || String(error),
      });
    }
  }

  const failureCount = results.filter((result) => result.error).length;
  return {
    atomic: false,
    successCount: results.length - failureCount,
    failureCount,
    results,
  };
}

function listMarkdownFiles(vaultPath: string): string[] {
  const files: string[] = [];

  const walk = (dirPath: string): void => {
    for (const entry of readdirSync(dirPath)) {
      const fullPath = join(dirPath, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        if (!entry.startsWith(".")) walk(fullPath);
        continue;
      }

      if (entry.endsWith(".md")) files.push(fullPath);
    }
  };

  walk(resolve(vaultPath));
  return files;
}

function uniquePath(targetPath: string): string {
  if (!existsSync(targetPath)) return targetPath;

  const extension = extname(targetPath);
  const stem = targetPath.slice(0, targetPath.length - extension.length);
  let counter = 1;
  while (existsSync(`${stem}-${counter}${extension}`)) {
    counter++;
  }
  return `${stem}-${counter}${extension}`;
}

function trimEmptyEdges(content: string): string {
  return content.replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n");
}

function countWords(content: string): number {
  const body = parseFrontmatter(content)?.body || content;
  return body
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean).length;
}

export function updateFrontmatterKey(content: string, key: string, value: unknown): string {
  const parsed = parseFrontmatter(content);
  const frontmatterLines = parsed ? [...parsed.frontmatterLines] : [];
  const bodyLines = parsed ? parsed.bodyLines : splitLines(content);
  const index = frontmatterLines.findIndex((line) => line.trim().startsWith(`${key}:`));
  const nextLine = `${key}: ${serializeFrontmatterValue(value)}`;

  if (index === -1) frontmatterLines.push(nextLine);
  else frontmatterLines[index] = nextLine;

  return buildFrontmatter(frontmatterLines, bodyLines);
}

export function writeTextFileAtomicSync(path: string, content: string): void {
  const dir = dirname(path);
  ensureDirectorySync(dir);
  const tempPath = join(
    dir,
    `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  writeFileSync(tempPath, content, "utf-8");
  renameSync(tempPath, path);
}

export async function removePath(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true });
}
