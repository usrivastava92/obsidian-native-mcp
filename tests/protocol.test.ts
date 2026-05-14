import test from "node:test";
import assert from "node:assert/strict";
import { parseMessages } from "../src/mcp/protocol";

test("parseMessages accepts content-length messages with extra headers", () => {
  const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" });
  const buffer = Buffer.from(
    `Content-Length: ${Buffer.byteLength(payload)}\r\nContent-Type: application/json\r\n\r\n${payload}`,
    "utf8",
  );

  const result = parseMessages(buffer);

  assert.deepEqual(result.messages, [payload]);
  assert.equal(result.remaining.length, 0);
});

test("parseMessages accepts newline-delimited json messages", () => {
  const message1 = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" });
  const message2 = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const buffer = Buffer.from(`${message1}\n${message2}\n`, "utf8");

  const result = parseMessages(buffer);

  assert.deepEqual(result.messages, [message1, message2]);
  assert.equal(result.remaining.length, 0);
});

test("parseMessages keeps partial newline-delimited input buffered", () => {
  const partial = Buffer.from('{"jsonrpc":"2.0","id":1', "utf8");

  const result = parseMessages(partial);

  assert.deepEqual(result.messages, []);
  assert.equal(result.remaining.toString("utf8"), partial.toString("utf8"));
});
