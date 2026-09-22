/**
 * Response body reading, with no Node dependency.
 *
 * Shared by both built-in clients. The Node client also decompresses, which is why
 * `decompress.ts` exists separately — that part needs `node:zlib` and this does
 * not.
 */

/**
 * Read a `ReadableStream` into a single `Uint8Array`, stopping at `maxBytes`.
 *
 * Returns `truncated: true` when the cap was hit. Truncating rather than rejecting
 * is deliberate: reading continues up to the limit and whatever arrived is used — a
 * partially-read bundle is still worth mining for chunk references.
 */
export async function readBodyWithLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ data: Uint8Array; truncated: boolean }> {
  if (!body) {
    return { data: new Uint8Array(0), truncated: false };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      const remaining = maxBytes - total;
      if (value.byteLength >= remaining) {
        chunks.push(value.subarray(0, remaining));
        total += remaining;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    // Release the connection even when stopped early.
    reader.cancel().catch(() => {});
  }

  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { data, truncated };
}