/**
 * Permission gating: read-only mode + per-tool disable.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeSandbox } from "../helpers/sandbox.js";

describe("permissions: read-only mode", () => {
  it("blocks every write tool with PERMISSION_DENIED", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/agents", { readOnly: true });
    try {
      // Read still works
      await sb.call("file.read", { file: "AGENTS.md" });

      const err = await sb.expectFail("str_replace", {
        file: "AGENTS.md",
        find: "Be concise. Be honest.",
        replace: "Be terse.",
      });
      assert.equal(err.code, "PERMISSION_DENIED");
      assert.match(err.message, /read-only/);
    } finally {
      await sb.cleanup();
    }
  });
});

describe("permissions: per-tool toggle", () => {
  it("disables a specific tool by name", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/agents", {
      toolToggles: { str_replace: false },
    });
    try {
      const err = await sb.expectFail("str_replace", {
        file: "AGENTS.md",
        find: "Style",
        replace: "STYLE",
      });
      assert.equal(err.code, "PERMISSION_DENIED");
      assert.match(err.message, /disabled/);
      // Other write tools still work
      await sb.call("file.append", { file: "AGENTS.md", content: "more.\n" });
    } finally {
      await sb.cleanup();
    }
  });

  it("regex.replace is off by default", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/agents");
    try {
      const err = await sb.expectFail("regex.replace", {
        file: "AGENTS.md",
        pattern: "Style",
        replacement: "STYLE",
        dry_run: true,
      });
      assert.equal(err.code, "PERMISSION_DENIED");
    } finally {
      await sb.cleanup();
    }
  });

  it("path traversal is rejected with INVALID_ARGS", async () => {
    const sb = await makeSandbox("tests/fixtures/vaults/agents");
    try {
      const err = await sb.expectFail("file.read", { file: "../escape.md" });
      assert.equal(err.code, "INVALID_ARGS");
    } finally {
      await sb.cleanup();
    }
  });
});
