// NDJSON frame helpers for `omp --mode rpc`.

export type Frame = Record<string, unknown> & { id?: string; type?: string };

export function encode(frame: Frame): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(frame) + "\n");
}

export function decode(line: string): Frame | null {
  const s = line.trim();
  if (!s) return null;
  try {
    const obj = JSON.parse(s);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as Frame) : null;
  } catch {
    return null;
  }
}

// Splits a ReadableStream of bytes into newline-delimited string chunks.
export async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        yield buf.slice(0, nl);
        buf = buf.slice(nl + 1);
      }
    }
    buf += decoder.decode();
    if (buf) yield buf;
  } finally {
    reader.releaseLock();
  }
}
