import http from "http";
import type { JSONRPCRequest, JSONRPCResponse } from "./protocol";

export class HttpTransport {
  private requestHandler: ((request: JSONRPCRequest) => Promise<JSONRPCResponse | null>) | null =
    null;
  private server: http.Server | null = null;
  private sessions = new Map<string, http.ServerResponse>();
  private port = 0;

  get url(): string {
    return `http://127.0.0.1:${this.port}/sse`;
  }

  get actualPort(): number {
    return this.port;
  }

  onRequest(handler: (request: JSONRPCRequest) => Promise<JSONRPCResponse | null>): void {
    this.requestHandler = handler;
  }

  sendMessage(_message: JSONRPCResponse): void {
    // Messages sent back via SSE response, not directly
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
        }
        console.error(`MCP HTTP server listening on http://127.0.0.1:${this.port}`);
        resolve();
      });
    });
  }

  close(): void {
    for (const res of this.sessions.values()) {
      res.end();
    }
    this.sessions.clear();
    this.server?.close();
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // CORS headers for Claude Desktop
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/sse") {
      this.handleSSE(req, res);
    } else if (req.method === "POST" && url.pathname === "/message") {
      this.handleMessage(req, res);
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  }

  private handleSSE(req: http.IncomingMessage, res: http.ServerResponse): void {
    const sessionId = generateId();

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const messageUrl = `/message?session_id=${sessionId}`;
    res.write(`event: endpoint\ndata: ${messageUrl}\n\n`);

    this.sessions.set(sessionId, res);

    req.on("close", () => {
      this.sessions.delete(sessionId);
    });
  }

  private handleMessage(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const sessionId = url.searchParams.get("session_id");

    if (!sessionId || !this.sessions.has(sessionId)) {
      res.writeHead(400);
      res.end("Invalid or missing session_id");
      return;
    }

    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", async () => {
      try {
        const msg = JSON.parse(body);
        if (msg.jsonrpc !== "2.0" || !("method" in msg) || !("id" in msg)) {
          res.writeHead(400);
          res.end("Invalid JSON-RPC message");
          return;
        }

        const response = await this.requestHandler?.(msg as JSONRPCRequest);
        if (response) {
          const sseRes = this.sessions.get(sessionId);
          if (sseRes) {
            sseRes.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
          }
        }

        res.writeHead(202);
        res.end();
      } catch {
        res.writeHead(400);
        res.end("Invalid JSON");
      }
    });
  }
}

function generateId(): string {
  return crypto.randomUUID();
}
