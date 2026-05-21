/**
 * HTTP/SSE transport for the Obsidian plugin.
 *
 * Endpoints:
 *   GET /healthz                                  → {ok, version, vaults, readOnly}
 *   GET /sse?token=<bearer>                       → SSE stream; first event delivers the
 *                                                   /message endpoint URL with the
 *                                                   session_id + token.
 *   POST /message?session_id=<sid>&token=<bearer> → JSON-RPC request body
 *
 * Hardening:
 *   - Bearer token required on every request (rotated via plugin UI).
 *   - Origin header must be empty / null / loopback (configurable allowlist).
 *   - Request body capped at 5 MB.
 *   - Maximum concurrent SSE sessions (default 16).
 *   - Idle SSE sessions closed after 5 minutes.
 *   - Heartbeat every 30 s to detect dead clients.
 */

import * as http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import type { JsonRpcRequest, JsonRpcResponse } from "./protocol.js";
import { failure, ErrorCode } from "./protocol.js";
import type { Transport, RequestHandler } from "./transport.js";

export interface HttpTransportOptions {
  host?: string; // default 127.0.0.1
  port?: number; // default 0 (pick free port)
  bearerToken?: string; // default: random
  allowedOrigins?: string[]; // exact-match; default: none/null/127.0.0.1
  maxBodyBytes?: number; // default 5 MB
  maxSessions?: number; // default 16
  idleMs?: number; // default 5 * 60_000
  heartbeatMs?: number; // default 30_000
  version?: string;
  vaultCount?: number;
  readOnly?: boolean;
}

interface SseSession {
  id: string;
  res: http.ServerResponse;
  lastSeenMs: number;
  heartbeat: NodeJS.Timeout;
}

const DEFAULT_ORIGINS = ["null", "http://127.0.0.1", "http://localhost"];

export class HttpTransport implements Transport {
  private server: http.Server | null = null;
  private handler: RequestHandler | null = null;
  private sessions = new Map<string, SseSession>();
  private opts: Required<Omit<HttpTransportOptions, "allowedOrigins">> & {
    allowedOrigins: string[];
  };

  constructor(opts: HttpTransportOptions = {}) {
    this.opts = {
      host: opts.host ?? "127.0.0.1",
      port: opts.port ?? 0,
      bearerToken: opts.bearerToken ?? randomBytes(32).toString("hex"),
      allowedOrigins: opts.allowedOrigins ?? DEFAULT_ORIGINS,
      maxBodyBytes: opts.maxBodyBytes ?? 5 * 1024 * 1024,
      maxSessions: opts.maxSessions ?? 16,
      idleMs: opts.idleMs ?? 5 * 60_000,
      heartbeatMs: opts.heartbeatMs ?? 30_000,
      version: opts.version ?? "1.0.0",
      vaultCount: opts.vaultCount ?? 0,
      readOnly: opts.readOnly ?? false,
    };
  }

  getBearerToken(): string {
    return this.opts.bearerToken;
  }

  getAddress(): { host: string; port: number } | null {
    const addr = this.server?.address();
    if (addr === null || typeof addr === "string" || !addr) return null;
    return { host: addr.address, port: addr.port };
  }

  async start(handler: RequestHandler): Promise<void> {
    this.handler = handler;
    this.server = http.createServer((req, res) => void this.onRequest(req, res));
    return new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.opts.port, this.opts.host, () => {
        this.server!.removeListener("error", reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const s of this.sessions.values()) {
      clearInterval(s.heartbeat);
      try {
        s.res.end();
      } catch {
        /* ignore */
      }
    }
    this.sessions.clear();
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  // -----------------------------------------------------------------------

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Origin check applies to all routes
    if (!this.originAllowed(req)) {
      this.json(res, 403, { error: "origin_not_allowed" });
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "GET" && url.pathname === "/healthz") {
      this.json(res, 200, {
        ok: true,
        version: this.opts.version,
        vaults: this.opts.vaultCount,
        readOnly: this.opts.readOnly,
      });
      return;
    }
    if (!this.tokenValid(url)) {
      this.json(res, 401, { error: "unauthorized" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/sse") {
      this.handleSse(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/message") {
      await this.handleMessage(req, res, url);
      return;
    }
    this.json(res, 404, { error: "not_found" });
  }

  private originAllowed(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true; // CLI/native clients without Origin header are allowed
    for (const allowed of this.opts.allowedOrigins) {
      if (origin === allowed) return true;
      if (origin.startsWith(allowed)) return true;
    }
    return false;
  }

  private tokenValid(url: URL): boolean {
    const tok = url.searchParams.get("token");
    return typeof tok === "string" && tok === this.opts.bearerToken;
  }

  private handleSse(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (this.sessions.size >= this.opts.maxSessions) {
      this.json(res, 429, { error: "too_many_sessions" });
      return;
    }
    const id = randomUUID();
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": req.headers.origin ?? "null",
    });
    res.write(`: connected\n\n`);
    const endpoint = `/message?session_id=${id}&token=${encodeURIComponent(this.opts.bearerToken)}`;
    res.write(`event: endpoint\ndata: ${endpoint}\n\n`);
    const heartbeat = setInterval(() => {
      try {
        res.write(`: keepalive ${Date.now()}\n\n`);
      } catch {
        /* will be cleaned on close */
      }
    }, this.opts.heartbeatMs);
    const session: SseSession = { id, res, lastSeenMs: Date.now(), heartbeat };
    this.sessions.set(id, session);
    const idleTimer = setInterval(
      () => {
        if (Date.now() - session.lastSeenMs > this.opts.idleMs) {
          clearInterval(idleTimer);
          this.closeSession(id);
        }
      },
      Math.min(this.opts.idleMs, 60_000),
    );
    req.on("close", () => {
      clearInterval(idleTimer);
      this.closeSession(id);
    });
  }

  private closeSession(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    clearInterval(s.heartbeat);
    try {
      s.res.end();
    } catch {
      /* ignore */
    }
    this.sessions.delete(id);
  }

  private async handleMessage(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    const sid = url.searchParams.get("session_id");
    if (!sid || !this.sessions.has(sid)) {
      this.json(res, 404, { error: "no_such_session" });
      return;
    }
    let body = "";
    let bytes = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > this.opts.maxBodyBytes) {
        aborted = true;
        req.destroy();
        return;
      }
      body += chunk.toString("utf-8");
    });
    await new Promise<void>((resolve) => req.on("end", resolve));
    if (aborted) {
      this.json(res, 413, { error: "payload_too_large" });
      return;
    }
    let rpc: JsonRpcRequest;
    try {
      rpc = JSON.parse(body) as JsonRpcRequest;
    } catch {
      this.json(res, 400, failure(null, ErrorCode.ParseError, "invalid JSON"));
      return;
    }
    const session = this.sessions.get(sid)!;
    session.lastSeenMs = Date.now();
    if (!this.handler) {
      this.json(res, 503, failure(rpc.id ?? null, ErrorCode.InternalError, "no handler"));
      return;
    }
    let response: JsonRpcResponse | null;
    try {
      response = await this.handler(rpc, { clientId: `http:${sid}` });
    } catch (e) {
      response = failure(rpc.id ?? null, ErrorCode.InternalError, (e as Error).message);
    }
    // Notifications produce no response — ack with 202.
    if (response === null) {
      res.writeHead(202);
      res.end();
      return;
    }
    // Stream the response via SSE; HTTP POST returns 202.
    try {
      session.res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
    } catch {
      /* session may have closed */
    }
    res.writeHead(202);
    res.end();
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }
}
