/**
 * Transport abstraction. The server is transport-agnostic.
 */

import type { JsonRpcRequest, JsonRpcResponse } from "./protocol.js";

export type RequestHandler = (
  message: JsonRpcRequest,
  context: { clientId: string },
) => Promise<JsonRpcResponse | null>;

export interface Transport {
  start(handler: RequestHandler): Promise<void>;
  stop(): Promise<void>;
}
