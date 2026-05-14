import type { JSONRPCRequest, JSONRPCResponse } from "./protocol";
import { parseMessages } from "./protocol";
import { createLogger, formatError } from "../utils/log";

const log = createLogger("stdio");

export class StdioTransport {
  private requestHandler: ((request: JSONRPCRequest) => Promise<JSONRPCResponse | null>) | null =
    null;
  private stdinBuffer: { buffer: Buffer<ArrayBufferLike> } = { buffer: Buffer.alloc(0) };

  onRequest(handler: (request: JSONRPCRequest) => Promise<JSONRPCResponse | null>): void {
    this.requestHandler = handler;
  }

  sendMessage(message: JSONRPCResponse): void {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }

  start(): void {
    process.stdin.on("data", async (chunk: Buffer) => {
      this.stdinBuffer.buffer = Buffer.concat([this.stdinBuffer.buffer, chunk]);

      const { messages, remaining } = parseMessages(this.stdinBuffer.buffer);
      this.stdinBuffer.buffer = remaining;

      for (const jsonStr of messages) {
        try {
          const msg = JSON.parse(jsonStr);
          if (msg.jsonrpc !== "2.0") continue;

          if ("method" in msg && "id" in msg) {
            const response = await this.requestHandler?.(msg as JSONRPCRequest);
            if (response) this.sendMessage(response);
          }
        } catch (err: any) {
          log.error("failed to process stdio message", { error: formatError(err) });
        }
      }
    });

    process.stdin.on("error", (err) => {
      log.error("stdin stream error", { error: formatError(err) });
    });

    process.stdout.on("error", (err) => {
      log.error("stdout stream error", { error: formatError(err) });
    });
  }

  close(): void {
    process.stdin.removeAllListeners("data");
  }
}
