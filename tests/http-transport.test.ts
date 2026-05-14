import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpTransport } from "../src/mcp/http-transport";
import { createServer } from "../src/mcp/server";
import { VaultRegistry } from "../src/utils/vaults";

test("http transport serves SSE endpoint and initialize roundtrip", async () => {
  const vaultDir = mkdtempSync(join(tmpdir(), "obsidian-native-mcp-"));
  const previousVaults = process.env.OBSIDIAN_VAULT_PATHS;
  process.env.OBSIDIAN_VAULT_PATHS = vaultDir;

  const transport = new HttpTransport();

  try {
    const registry = new VaultRegistry();
    const server = createServer(registry);
    transport.onRequest((msg) => server.handleRequest(msg));
    await transport.start();

    const sse = await openSse(transport.url);
    const endpointMatch = sse.initialBody.match(/data: (\/message\?session_id=[^\n]+)/);
    assert.ok(endpointMatch, `expected endpoint event, got: ${sse.initialBody}`);

    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    };

    const responsePromise = waitForSseMessage(sse.response);
    const postStatus = await postJson(
      `http://127.0.0.1:${transport.actualPort}${endpointMatch[1]}`,
      initialize,
    );
    const responseEvent = await responsePromise;

    assert.equal(postStatus, 202);
    assert.match(responseEvent, /"protocolVersion":"2025-11-25"/);
    assert.match(responseEvent, /"name":"obsidian-native-mcp"/);

    sse.response.destroy();
  } finally {
    transport.close();
    if (previousVaults === undefined) delete process.env.OBSIDIAN_VAULT_PATHS;
    else process.env.OBSIDIAN_VAULT_PATHS = previousVaults;
    rmSync(vaultDir, { recursive: true, force: true });
  }
});

function openSse(url: string): Promise<{ initialBody: string; response: http.IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      response.setEncoding("utf8");
      let body = "";
      const onData = (chunk: string) => {
        body += chunk;
        if (body.includes("\n\n")) {
          response.off("data", onData);
          resolve({ initialBody: body, response });
        }
      };
      response.on("data", onData);
      response.on("error", reject);
    });
    request.on("error", reject);
  });
}

function waitForSseMessage(response: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    const onData = (chunk: string) => {
      body += chunk;
      if (body.includes("event: message\n")) {
        response.off("data", onData);
        resolve(body);
      }
    };
    response.on("data", onData);
    response.on("error", reject);
  });
}

function postJson(url: string, payload: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode || 0));
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}
