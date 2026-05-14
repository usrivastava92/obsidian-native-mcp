import type { JSONRPCRequest, JSONRPCResponse } from "./protocol";
import { sendMessage, parseMessages } from "./protocol";

export class StdioTransport {
  private requestHandler: ((request: JSONRPCRequest) => Promise<JSONRPCResponse | null>) | null =
    null;
  private stdinBuffer = { buffer: "" };

  onRequest(handler: (request: JSONRPCRequest) => Promise<JSONRPCResponse | null>): void {
    this.requestHandler = handler;
  }

  sendMessage(message: JSONRPCResponse): void {
    sendMessage(message);
  }

  start(): void {
    process.stdin.on("data", async (chunk: Buffer) => {
      this.stdinBuffer.buffer += chunk.toString();

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
          console.error("Error processing message:", err.message);
        }
      }
    });
  }

  close(): void {
    process.stdin.removeAllListeners("data");
  }
}
