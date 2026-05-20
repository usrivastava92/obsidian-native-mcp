import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  appendFile,
  bulkPatch,
  createFile,
  deleteFileHandler,
  getLinks,
  listFiles,
  moveFile,
  patchFile,
  readFileHandler,
  readMetadata,
  removePath,
  replaceFile,
  replaceSection,
  resolveVaultPath,
  searchFiles,
} from "../src/utils/fs-utils";

function makeVault(): string {
  return mkdtempSync(join(tmpdir(), "obsidian-native-mcp-vault-"));
}

function writeVaultFile(vault: string, relativePath: string, content: string): void {
  const fullPath = join(vault, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf-8");
}

test("resolveVaultPath rejects traversal outside the vault", async () => {
  const vault = makeVault();

  try {
    assert.throws(() => resolveVaultPath(vault, "../escape.md"), /Path escapes vault root/);
    await assert.rejects(() => readFileHandler(vault, "../escape.md"), /Path escapes vault root/);
    await assert.rejects(
      () => createFile(vault, "../escape.md", "nope"),
      /Path escapes vault root/,
    );
  } finally {
    await removePath(vault);
  }
});

test("listFiles supports recursive traversal", async () => {
  const vault = makeVault();

  try {
    writeVaultFile(vault, "folder/one.md", "# One");
    writeVaultFile(vault, "folder/nested/two.md", "# Two");

    const shallow = listFiles(vault, "folder");
    const recursive = listFiles(vault, "folder", true);

    assert.deepEqual(
      shallow.map((entry) => entry.path),
      ["folder/nested", "folder/one.md"],
    );
    assert.deepEqual(
      recursive.map((entry) => entry.path),
      ["folder/nested", "folder/nested/two.md", "folder/one.md"],
    );
  } finally {
    await removePath(vault);
  }
});

test("deleteFileHandler supports dry run and trash moves", async () => {
  const vault = makeVault();

  try {
    writeVaultFile(vault, "stale.md", "obsolete");

    const preview = await deleteFileHandler(vault, "stale.md", { dryRun: true, trash: true });
    assert.equal(preview.existed, true);
    assert.equal(existsSync(join(vault, "stale.md")), true);

    const deleted = await deleteFileHandler(vault, "stale.md", { trash: true });
    assert.equal(deleted.trashed, true);
    assert.equal(existsSync(join(vault, "stale.md")), false);
    assert.equal(existsSync(join(vault, ".trash", "stale.md")), true);
  } finally {
    await removePath(vault);
  }
});

test("patchFile delete removes heading sections, blocks, and frontmatter keys", async () => {
  const vault = makeVault();

  try {
    writeVaultFile(
      vault,
      "note.md",
      [
        "---",
        "aliases: [Alias]",
        "tags: [keep]",
        "---",
        "",
        "# Intro",
        "First section",
        "",
        "## Remove Me",
        "Delete this body",
        "",
        "Paragraph ^block-x",
        "Tail",
      ].join("\n"),
    );

    const frontmatter = await patchFile(vault, "note.md", "delete", "frontmatter", "aliases");
    assert.equal(frontmatter.changed, true);

    const block = await patchFile(vault, "note.md", "delete", "block", "block-x");
    assert.equal(block.targetFound, true);

    const heading = await patchFile(vault, "note.md", "delete", "heading", "Remove Me");
    assert.equal(heading.targetFound, true);

    const finalContent = readFileSync(join(vault, "note.md"), "utf-8");
    assert.match(finalContent, /tags: \[keep\]/);
    assert.doesNotMatch(finalContent, /aliases/);
    assert.doesNotMatch(finalContent, /Remove Me/);
    assert.doesNotMatch(finalContent, /block-x/);
  } finally {
    await removePath(vault);
  }
});

test("replaceSection only replaces the targeted section body", async () => {
  const vault = makeVault();

  try {
    writeVaultFile(
      vault,
      "sections.md",
      ["# A", "keep", "", "## Target", "old line", "", "## B", "stay"].join("\n"),
    );

    const result = await replaceSection(vault, "sections.md", "Target", "new line");
    assert.equal(result.changed, true);

    const content = readFileSync(join(vault, "sections.md"), "utf-8");
    assert.equal(content, ["# A", "keep", "", "## Target", "new line", "## B", "stay"].join("\n"));
  } finally {
    await removePath(vault);
  }
});

test("moveFile rewrites uniquely resolved links and skips ambiguous ones", async () => {
  const vault = makeVault();

  try {
    writeVaultFile(vault, "A.md", "# A");
    writeVaultFile(vault, "nested/A.md", "# Nested A");
    writeVaultFile(vault, "ref.md", "See [[A]] and [path](A.md) and [[nested/A]].");

    const result = await moveFile(vault, "nested/A.md", "nested/Renamed.md", { updateLinks: true });
    assert.equal(result.updatedReferences, 1);
    assert.equal(result.skippedAmbiguousReferences, 0);

    const refContent = readFileSync(join(vault, "ref.md"), "utf-8");
    assert.match(refContent, /\[\[nested\/Renamed\]\]/);
    assert.match(refContent, /\[\[A\]\]/);
    assert.match(refContent, /\[path\]\(A\.md\)/);
  } finally {
    await removePath(vault);
  }
});

test("replaceFile, searchFiles, and readMetadata return structured results", async () => {
  const vault = makeVault();

  try {
    writeVaultFile(
      vault,
      "docs/alpha-note.md",
      [
        "---",
        'aliases: ["Alpha Alias"]',
        "tags: [tag-one]",
        "---",
        "",
        "# Title",
        "Words here #inline",
      ].join("\n"),
    );

    const replace = await replaceFile(vault, "docs/beta.md", "beta content", {
      createIfMissing: true,
      dryRun: true,
    });
    assert.equal(replace.action, "created");
    assert.equal(existsSync(join(vault, "docs/beta.md")), false);

    const substring = await searchFiles(vault, "alpha");
    const regex = await searchFiles(vault, "alpha-.*", { mode: "regex" });
    const glob = await searchFiles(vault, "*.md", { directory: "docs", mode: "glob" });

    assert.deepEqual(
      substring.map((match) => match.path),
      ["docs/alpha-note.md"],
    );
    assert.deepEqual(
      regex.map((match) => match.path),
      ["docs/alpha-note.md"],
    );
    assert.deepEqual(glob.map((match) => match.path).sort(), ["docs/alpha-note.md"]);

    const metadata = await readMetadata(vault, "docs/alpha-note.md");
    assert.deepEqual(metadata.aliases, ["Alpha Alias"]);
    assert.deepEqual(metadata.tags.sort(), ["#inline", "#tag-one"]);
    assert.equal(metadata.headings[0].heading, "Title");
    assert.equal(metadata.wordCount > 0, true);
  } finally {
    await removePath(vault);
  }
});

test("getLinks reports resolved backlinks and unresolved outlinks", async () => {
  const vault = makeVault();

  try {
    writeVaultFile(vault, "Target.md", "# Target");
    writeVaultFile(vault, "Source.md", "See [[Target]] and [[Missing]].");

    const result = await getLinks(vault, "Target.md", "both");
    assert.equal(result.backlinks?.resolved.length, 1);
    assert.equal(result.outlinks?.resolved.length, 0);

    const sourceLinks = await getLinks(vault, "Source.md", "outlinks");
    assert.equal(sourceLinks.outlinks?.resolved.length, 1);
    assert.equal(sourceLinks.outlinks?.unresolved.length, 1);
  } finally {
    await removePath(vault);
  }
});

test("bulkPatch supports atomic and non-atomic application", async () => {
  const vault = makeVault();

  try {
    writeVaultFile(vault, "bulk.md", ["# One", "body", "", "# Two", "tail"].join("\n"));

    const atomicFailure = await bulkPatch(
      vault,
      [
        {
          filename: "bulk.md",
          operation: "replace",
          targetType: "heading",
          target: "One",
          content: "changed",
        },
        {
          filename: "missing.md",
          operation: "replace",
          targetType: "heading",
          target: "Nope",
          content: "x",
        },
      ],
      { atomic: true },
    ).catch((error: Error) => error);

    assert.match(String(atomicFailure), /File not found/);
    assert.match(readFileSync(join(vault, "bulk.md"), "utf-8"), /body/);

    const nonAtomic = await bulkPatch(vault, [
      {
        filename: "bulk.md",
        operation: "replace",
        targetType: "heading",
        target: "One",
        content: "changed",
      },
      {
        filename: "missing.md",
        operation: "replace",
        targetType: "heading",
        target: "Nope",
        content: "x",
      },
    ]);

    assert.equal(nonAtomic.successCount, 1);
    assert.equal(nonAtomic.failureCount, 1);
    assert.match(readFileSync(join(vault, "bulk.md"), "utf-8"), /changed/);
  } finally {
    await removePath(vault);
  }
});

test("appendFile and readFileHandler preserve file content", async () => {
  const vault = makeVault();

  try {
    await createFile(vault, "append.md", "Hello");
    await appendFile(vault, "append.md", "\nWorld");
    const result = await readFileHandler(vault, "append.md");
    assert.equal(result.content, "Hello\nWorld");
  } finally {
    await removePath(vault);
  }
});
