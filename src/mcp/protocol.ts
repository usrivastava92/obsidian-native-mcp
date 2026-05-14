export interface JSONRPCMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

export type JSONRPCRequest = Required<Pick<JSONRPCMessage, "jsonrpc" | "id" | "method">> & {
  params?: any;
};

export type JSONRPCResponse = Required<Pick<JSONRPCMessage, "jsonrpc" | "id">> & {
  result?: any;
  error?: { code: number; message: string; data?: any };
};

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, any>;
}

export interface ToolResult {
  content: Array<{ type: "text" | "image"; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

export interface PromptDefinition {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export function encodeMessage(message: any): Uint8Array {
  const json = JSON.stringify(message);
  const bodyLength = Buffer.byteLength(json, "utf8");
  const header = `Content-Length: ${bodyLength}\r\n\r\n`;
  const encoder = new TextEncoder();
  const headerBytes = encoder.encode(header);
  const bodyBytes = encoder.encode(json);
  const combined = new Uint8Array(headerBytes.length + bodyBytes.length);
  combined.set(headerBytes);
  combined.set(bodyBytes, headerBytes.length);
  return combined;
}

export function sendMessage(message: any): void {
  process.stdout.write(encodeMessage(message));
}

export function parseMessages(buffer: Buffer): { messages: string[]; remaining: Buffer } {
  const messages: string[] = [];
  let offset = 0;

  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n", offset, "utf8");
    if (headerEnd === -1) break;

    const headerText = buffer.slice(offset, headerEnd).toString("utf8");
    const headers = headerText.split("\r\n");
    const contentLengthHeader = headers.find((header) =>
      header.toLowerCase().startsWith("content-length:"),
    );
    if (!contentLengthHeader) break;

    const contentLength = parseInt(contentLengthHeader.slice("Content-Length:".length).trim(), 10);
    if (Number.isNaN(contentLength)) break;

    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;
    if (buffer.length < bodyEnd) break;

    const jsonStr = buffer.slice(bodyStart, bodyEnd).toString("utf8");
    offset = bodyEnd;
    messages.push(jsonStr);
  }

  if (messages.length > 0) {
    return { messages, remaining: buffer.subarray(offset) };
  }

  while (true) {
    const newlineIndex = buffer.indexOf("\n", offset, "utf8");
    if (newlineIndex === -1) break;

    const line = buffer.slice(offset, newlineIndex).toString("utf8").trim();
    offset = newlineIndex + 1;
    if (!line) continue;
    messages.push(line);
  }

  return { messages, remaining: buffer.subarray(offset) };
}
