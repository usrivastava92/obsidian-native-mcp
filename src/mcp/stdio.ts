/**
 * Stdio transport — Content-Length framing both directions, per LSP/MCP spec.
 */

import { encodeFrame, FrameDecoder } from "./framing.js";
import type { JsonRpcRequest } from "./protocol.js";
import type { Transport, RequestHandler } from "./transport.js";

export class StdioTransport implements Transport {
  private decoder = new FrameDecoder<JsonRpcRequest>();
  private handler: RequestHandler | null = null;

  async start(handler: RequestHandler): Promise<void> {
    this.handler = handler;
    process.stdin.on("data", (chunk: Buffer) => {
      const frames = this.decoder.push(chunk);
      for (const f of frames) {
        void this.dispatch(f.body);
      }
    });
    process.stdin.on("end", () => {
      // peer closed
    });
  }

  async stop(): Promise<void> {
    process.stdin.removeAllListeners("data");
  }

  private async dispatch(req: JsonRpcRequest): Promise<void> {
    if (!this.handler) return;
    try {
      const res = await this.handler(req, { clientId: "stdio" });
      if (res === null) return;
      process.stdout.write(encodeFrame(res));
    } catch (e) {
      // never crash the loop
      process.stderr.write(`stdio dispatch error: ${(e as Error).message}\n`);
    }
  }
}
