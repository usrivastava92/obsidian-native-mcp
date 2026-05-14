import { readdirSync, statSync } from "fs";
import { join, relative } from "path";

export interface SearchMatch {
  file: string;
  line: number;
  content: string;
  contextBefore?: string;
  contextAfter?: string;
}

export async function searchInVault(
  vaultPath: string,
  query: string,
  directory?: string,
  contextLength: number = 100,
): Promise<SearchMatch[]> {
  const searchDir = directory ? join(vaultPath, directory) : vaultPath;
  const results: SearchMatch[] = [];
  const searchTerms = query.toLowerCase().split(/\s+/).filter(Boolean);

  await walkDir(searchDir, vaultPath, results, searchTerms, contextLength);
  return results;
}

async function walkDir(
  dirPath: string,
  vaultPath: string,
  results: SearchMatch[],
  searchTerms: string[],
  contextLength: number,
): Promise<void> {
  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dirPath, entry);

    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      if (!entry.startsWith(".")) {
        await walkDir(fullPath, vaultPath, results, searchTerms, contextLength);
      }
      continue;
    }

    if (!entry.endsWith(".md")) continue;

    try {
      const content = await Bun.file(fullPath).text();
      const lines = content.split("\n");
      const relPath = relative(vaultPath, fullPath);

      for (let i = 0; i < lines.length; i++) {
        const lowerLine = lines[i].toLowerCase();
        const matchesAll = searchTerms.every((term) => lowerLine.includes(term));

        if (matchesAll) {
          results.push({
            file: relPath,
            line: i + 1,
            content: lines[i].substring(0, 500),
            contextBefore: i > 0 ? lines[i - 1].substring(0, contextLength) : undefined,
            contextAfter:
              i < lines.length - 1 ? lines[i + 1].substring(0, contextLength) : undefined,
          });
        }
      }
    } catch {
      // skip unreadable files
    }
  }
}
