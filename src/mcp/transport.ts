import type { JSONRPCRequest, JSONRPCResponse } from "./protocol";

export interface Transport {
  sendMessage(message: JSONRPCResponse): void;
  onRequest(handler: (request: JSONRPCRequest) => Promise<JSONRPCResponse | null>): void;
  start(): void;
  close(): void;
}
