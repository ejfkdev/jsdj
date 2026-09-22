/**
 * Response body decompression.
 *
 * The Go original relied on `http.Transport` to negotiate and transparently decompress
 * gzip/deflate/br. The web platform's `fetch` handles that too, but only when it
 * is the one adding `Accept-Encoding` — and we set that header ourselves as part
 * of the browser fingerprint. So when running on Node we decompress explicitly.
 *
 * `node:zlib` is imported through {@link importBuiltin} so that this module stays
 * loadable in a browser *bundle*; the browser path simply never reaches these
 * calls. A plain `import('node:zlib')` would be lazy at runtime but still produce
 * a resolvable edge that every bundler walks and fails on.
 */

import { importBuiltin } from './import-builtin.js';

const CONTENT_ENCODING_ALIASES: Record<string, string> = {
  'x-gzip': 'gzip',
  'x-deflate': 'deflate',
};

/** Normalise a Content-Encoding value to `gzip` | `deflate` | `br` | `''`. */
export function normalizeContentEncoding(value: string): string {
  const primary = value.split(',')[0]?.trim().toLowerCase() ?? '';
  if (primary === '') {
    return '';
  }
  return CONTENT_ENCODING_ALIASES[primary] ?? primary;
}

/**
 * Decompress `body` according to `contentEncoding`.
 *
 * Unsupported or absent encodings return the input untouched. A decompression
 * failure also returns the input untouched: some servers mislabel their bodies,
 * and returning the raw bytes lets content-type sniffing still make progress
 * rather than discarding an otherwise usable response.
 */
export async function decompressBody(
  body: Uint8Array,
  contentEncoding: string,
): Promise<Uint8Array> {
  const encoding = normalizeContentEncoding(contentEncoding);
  if (encoding === '' || encoding === 'identity') {
    return body;
  }

  // Raw deflate (`deflate` without the zlib wrapper) is common enough that
  // falling back to it is worth the extra attempt.
  try {
    return await zlibDecompress(body, encoding);
  } catch {
    if (encoding === 'deflate') {
      try {
        return await zlibDecompress(body, 'deflate-raw');
      } catch {
        return body;
      }
    }
    return body;
  }
}

async function zlibDecompress(
  body: Uint8Array,
  format: string,
): Promise<Uint8Array> {
  const zlib = await importBuiltin<typeof import('node:zlib')>('node:zlib');
  const buffer = Buffer.from(body.buffer, body.byteOffset, body.byteLength);

  const fn =
    format === 'gzip'
      ? zlib.gunzip
      : format === 'br'
        ? zlib.brotliDecompress
        : format === 'deflate-raw'
          ? zlib.inflateRaw
          : zlib.inflate;

  // These are the callback forms; promisify keeps the await shape uniform.
  const result = await new Promise<Buffer>((resolve, reject) => {
    fn(buffer, (err, out) => (err ? reject(err) : resolve(out as Buffer)));
  });
  return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
}
