/**
 * Content-Length framing for JSON-RPC over stdio.
 *
 *   Content-Length: <byte_length>\r\n
 *   \r\n
 *   <JSON body>
 *
 * The same framing is used in LSP. We implement it from scratch to keep the
 * MCP/transport layer dependency-free.
 */

export interface Frame<T = unknown> {
  body: T;
}

/** Encode a JSON-RPC message with Content-Length framing. */
export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf-8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
  return Buffer.concat([header, body]);
}

/**
 * Stateful streaming decoder. Feed chunks via `push`; receive any complete
 * messages back via the returned array. Tolerates partial reads and
 * concatenated messages.
 */
export class FrameDecoder<T = unknown> {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame<T>[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: Frame<T>[] = [];
    // Loop: try to consume as many complete frames as possible.
    while (true) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const headerText = this.buf.slice(0, headerEnd).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(headerText);
      if (!match) {
        // Malformed header — drop everything up to the separator and resync.
        this.buf = this.buf.slice(headerEnd + 4);
        continue;
      }
      const len = parseInt(match[1], 10);
      const totalLen = headerEnd + 4 + len;
      if (this.buf.length < totalLen) break; // need more bytes
      const bodyBuf = this.buf.slice(headerEnd + 4, totalLen);
      this.buf = this.buf.slice(totalLen);
      try {
        const body = JSON.parse(bodyBuf.toString("utf-8")) as T;
        out.push({ body });
      } catch {
        // Drop the malformed message; continue.
      }
    }
    return out;
  }
}
