/**
 * Test sandbox: copy a fixture vault to a fresh temp directory and build
 * a fully-wired ToolContext + invoke() helper that mirrors what the MCP
 * server would do for `tools/call`.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { randomBytes } from "node:crypto";
import { VaultRegistry } from "../../src/vault/registry.js";
import { Permissions, DEFAULT_PERMISSIONS } from "../../src/vault/permissions.js";
import { LRUFileCache } from "../../src/cache/file-cache.js";
import { AuditLog } from "../../src/audit/log.js";
import { ToolRegistry, type ToolCallResult } from "../../src/handlers/registry.js";
import { registerAll } from "../../src/tools/index.js";

export interface Sandbox {
  vaultRoot: string;
  registry: ToolRegistry;
  invoke(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
  call<T = Record<string, unknown>>(name: string, args: Record<string, unknown>): Promise<T>;
  expectFail(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ code: string; message: string; details?: Record<string, unknown> }>;
  cleanup(): Promise<void>;
}

export async function makeSandbox(
  fixturePath: string,
  opts: { readOnly?: boolean; toolToggles?: Record<string, boolean> } = {},
): Promise<Sandbox> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `onv-${randomBytes(4).toString("hex")}-`));
  await copyDir(fixturePath, tmp);
  const vaultName = path.basename(fixturePath);
  const vaultReg = new VaultRegistry([{ name: vaultName, root: tmp }]);
  const perms = new Permissions({
    ...DEFAULT_PERMISSIONS,
    readOnly: opts.readOnly ?? false,
    tools: { ...DEFAULT_PERMISSIONS.tools, ...(opts.toolToggles ?? {}) },
  });
  const cache = new LRUFileCache();
  const audit = new AuditLog(tmp);
  const reg = new ToolRegistry();
  registerAll(reg);

  async function invoke(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    const vault = vaultReg.resolve(typeof args.vault === "string" ? args.vault : undefined);
    return reg.invoke(name, args, {
      vault,
      perms,
      cache,
      audit,
      registry: vaultReg,
      clientId: "test",
    });
  }

  async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const r = await invoke(name, args);
    if (!r.ok) {
      throw new Error(`tool ${name} failed: ${JSON.stringify(r.error)}`);
    }
    return r.result as T;
  }

  async function expectFail(name: string, args: Record<string, unknown>) {
    const r = await invoke(name, args);
    if (r.ok) {
      throw new Error(`tool ${name} unexpectedly succeeded: ${JSON.stringify(r.result)}`);
    }
    return r.error!;
  }

  return {
    vaultRoot: tmp,
    registry: reg,
    invoke,
    call,
    expectFail,
    async cleanup() {
      await fs.rm(tmp, { recursive: true, force: true });
    },
  };
}

async function copyDir(src: string, dst: string): Promise<void> {
  const entries = await fs.readdir(src, { withFileTypes: true });
  await fs.mkdir(dst, { recursive: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else if (e.isFile()) await fs.copyFile(s, d);
  }
}

export async function readFile(sandbox: Sandbox, relPath: string): Promise<string> {
  return fs.readFile(path.join(sandbox.vaultRoot, relPath), "utf-8");
}

export async function writeFileRaw(sandbox: Sandbox, relPath: string, text: string): Promise<void> {
  const abs = path.join(sandbox.vaultRoot, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text, "utf-8");
}
