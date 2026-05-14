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
  const header = `Content-Length: ${json.length}\r\n\r\n`;
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

export function parseMessages(buffer: string): { messages: string[]; remaining: string } {
  const messages: string[] = [];
  let remaining = buffer;

  while (true) {
    const headerMatch = remaining.match(/^Content-Length: (\d+)\r\n\r\n/);
    if (!headerMatch) break;
    const contentLength = parseInt(headerMatch[1], 10);
    const headerEnd = headerMatch[0].length;
    const totalLength = headerEnd + contentLength;
    if (remaining.length < totalLength) break;
    const jsonStr = remaining.slice(headerEnd, totalLength);
    remaining = remaining.slice(totalLength);
    messages.push(jsonStr);
  }

  return { messages, remaining };
}
