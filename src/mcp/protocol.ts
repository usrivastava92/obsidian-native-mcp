/**
 * Minimal JSON-RPC 2.0 message types used by the MCP server.
 */

export type JsonRpcId = number | string | null;

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: P;
}

export interface JsonRpcSuccess<R = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: R;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse<R = unknown> = JsonRpcSuccess<R> | JsonRpcError;

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** MCP-specific application error (carries our ToolError in `data`). */
  ApplicationError: -32001,
} as const;

export function success<R>(id: JsonRpcId, result: R): JsonRpcSuccess<R> {
  return { jsonrpc: "2.0", id, result };
}

export function failure(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}
