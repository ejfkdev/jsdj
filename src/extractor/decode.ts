/**
 * Content decoding and payload-kind detection.
 *
 * Body decoding plus the content-type sniffing from
 * `detectContentTypeFromHeader`.
 *
 * The decoding half is a "mechanical" restore: URLs embedded in JS or HTML are
 * frequently escaped (`https:\/\/a\/b.js`, `%2Fpath%2F`, `\u003Cscript`), and
 * regex-based plugins cannot see through that. Decoding first makes the escaped
 * forms matchable without any plugin needing to know about encodings.
 *
 * This does not interpret JS. It does not evaluate concatenation or call
 * functions; it only reverses textual escaping.
 */

import type { ContentKind } from './types.js';

/** Matches a `%XX` escape, the signature of URL encoding. */
const PERCENT_ESCAPED = /%[0-9a-fA-F]{2}/;
/** Matches a `\uXXXX` escape. */
const UNICODE_ESCAPE = /\\u[0-9a-fA-F]{4}/g;
/** Matches an HTML numeric entity, `&#NNN;` or `&#xHH;`. */
const NUMERIC_ENTITY = /(?:#[0-9]+|#[xX][0-9a-fA-F]+);/g;

/** Whether the content contains any escape sequence worth decoding. */
function needsDecode(content: string): boolean {
  if (content.includes('%') || content.includes('\\') || content.includes('&')) {
    return true;
  }
  return content.includes('\\u');
}

/**
 * Reverse common textual escaping so that encoded URLs become directly
 * matchable.
 *
 * Order matters and is load-bearing: URL encoding first, then JS string escapes,
 * then Unicode escapes, then HTML entities. Applying them in another order
 * produces different (and wrong) text — for example decoding JS escapes before
 * URL encoding would consume the backslashes that `%5C` depends on.
 *
 * Returns the input unchanged when it contains no escape sequences, which keeps
 * the common case allocation-free.
 */
export function decodeContent(content: string): string {
  if (content === '') {
    return content;
  }
  if (!needsDecode(content)) {
    return content;
  }

  let result = content;

  // 1. URL encoding. Guarded by a `%XX` presence test so that identifiers which
  //    merely contain `%` are not mangled.
  if (result.includes('%') && PERCENT_ESCAPED.test(result)) {
    try {
      result = decodeURIComponent(result);
    } catch {
      // Incomplete or invalid escapes: leave this step out and continue.
    }
  }

  // 2. JS string-literal escapes.
  if (result.includes('\\')) {
    result = decodeJsEscapes(result);
  }

  // 3. Unicode escapes.
  if (result.includes('\\u')) {
    result = result.replace(UNICODE_ESCAPE, (match) => {
      const code = Number.parseInt(match.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    });
  }

  // 4. HTML entities.
  if (result.includes('&')) {
    result = decodeHtmlEntities(result);
  }

  return result;
}

/**
 * Reverse JS string-literal escapes: `\/`, `\"`, `\'`, `\\`, `\n`, `\r`, `\t`.
 *
 * A placeholder protects `\\` so that a literal backslash is not consumed by the
 * later replacements. The NUL character is usable as the placeholder because it
 * cannot appear in a text response that reached this point.
 */
function decodeJsEscapes(s: string): string {
  const PLACEHOLDER = '\u0000';
  let result = s;
  result = result.split('\\\\').join(PLACEHOLDER);
  result = result.split('\\/').join('/');
  result = result.split('\\"').join('"');
  result = result.split("\\'").join("'");
  result = result.split('\\n').join('\n');
  result = result.split('\\r').join('\r');
  result = result.split('\\t').join('\t');
  return result.split(PLACEHOLDER).join('\\');
}

/** Reverse the HTML entities that matter for URL extraction. */
function decodeHtmlEntities(s: string): string {
  let result = s;
  // `&amp;` must be decoded last: doing it first would turn `&amp;lt;` into
  // `&lt;` and then into `<`, over-decoding.
  result = result.split('&lt;').join('<');
  result = result.split('&gt;').join('>');
  result = result.split('&quot;').join('"');
  result = result.split('&apos;').join("'");
  result = result.split('&amp;').join('&');

  return result.replace(NUMERIC_ENTITY, (match) => {
    const body = match.slice(1, -1); // strip `&` and `;`
    const isHex = body.startsWith('x') || body.startsWith('X');
    const code = Number.parseInt(isHex ? body.slice(1) : body, isHex ? 16 : 10);
    return Number.isFinite(code) && code >= 0 ? String.fromCodePoint(code) : match;
  });
}

/** The first non-whitespace characters of a body, for sniffing. */
function head(content: Uint8Array, limit = 200): string {
  const slice = content.subarray(0, Math.min(content.length, limit));
  return new TextDecoder('utf-8', { fatal: false }).decode(slice).trim();
}

/**
 * Detect the payload kind of a response.
 *
 * The `Content-Type` header is authoritative when it is one of the recognised
 * types. When it is missing, generic (`text/plain`,
 * `application/octet-stream`) or simply wrong — all common on static hosts that
 * misconfigure JS — the body is sniffed instead.
 *
 * The default when nothing is conclusive is `js`, not `html`: a misconfigured
 * server serving a real JS bundle as `text/plain` would otherwise be discarded.
 *
 * **JSONP.** A `.js` URL whose body is a callback wrapper around JSON
 * (`cb({...})`) is reported as `jsonp`. There is no such distinction in the
 * these as JS, running plugins over the JSON text. Naming the kind lets callers
 * and plugins make that choice deliberately; the pipeline's default remains to
 * treat them as discovery output rather than as parse targets, which preserves
 * intended behaviour.
 */
export function detectContentKind(
  contentTypeHeader: string,
  content: Uint8Array,
  /** The URL, used to break ties for `.map` and `.json` paths. */
  url = '',
): ContentKind {
  const ct = contentTypeHeader.toLowerCase();
  const semicolon = ct.indexOf(';');
  const mime = (semicolon >= 0 ? ct.slice(0, semicolon) : ct).trim();

  if (mime === 'text/html' || mime === 'application/xhtml+xml') {
    return 'html';
  }
  if (mime === 'application/json' || mime === 'text/json') {
    return 'json';
  }
  if (
    mime === 'application/javascript' ||
    mime === 'text/javascript' ||
    mime === 'application/x-javascript' ||
    mime === 'application/ecmascript' ||
    mime === 'text/ecmascript'
  ) {
    return 'js';
  }
  if (mime === 'application/octet-stream' || mime === 'text/plain' || mime === '') {
    return sniffKind(content, url);
  }

  // An unrecognised explicit type: fall back to sniffing rather than assuming.
  return sniffKind(content, url);
}

/**
 * Classify a body by its leading bytes.
 *
 * The fallback in `detectContentTypeFromHeader`, with one addition:
 * JSONP is named rather than left inside the JS bucket.
 *
 * The JSON branch is unconditional — any body starting with `{` or `[` is
 * JSON, whatever the URL — and that is preserved. An earlier version of this
 * function consulted the URL to distinguish a `.json` path from a `.js` one, on
 * the theory that a bracket at the start of a JS file is probably an IIFE. That
 * guess is wrong more often than it is right: a web app manifest served as
 * `application/manifest+json` (a MIME type neither tool recognises) arrives at
 * this fallback with a `{` body and a `.webmanifest` path, and classifying it as
 * JS makes the pipeline report the manifest as a JavaScript file.
 */
function sniffKind(content: Uint8Array, url: string): ContentKind {
  void url;
  const start = head(content);

  if (start.startsWith('<!DOCTYPE') || start.startsWith('<!doctype') || start.startsWith('<html')) {
    return 'html';
  }

  // JSONP detection runs first: a JSONP wrapper also begins with an identifier,
  // so it would otherwise be classified as plain JS.
  if (looksLikeJsonp(start)) {
    return 'jsonp';
  }

  if (start.startsWith('{') || start.startsWith('[')) {
    return 'json';
  }

  if (looksLikeJavaScript(start)) {
    return 'js';
  }

  // Inconclusive: default to JS so that a mislabelled bundle is still analysed.
  // The same default is chosen here, on the reasoning that a real JS file served with a
  // broken content type should not be discarded.
  return 'js';
}

/**
 * Whether the text opens with a JSONP callback invocation.
 *
 * Recognises `identifier({`, `identifier([`, `identifier.bar({)`,
 * `window.identifier({)` and the same with whitespace before the paren.
 */
export function looksLikeJsonp(text: string): boolean {
  const match = /^(?:window\.)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\(\s*[[{]/.exec(
    text,
  );
  return match !== null;
}

/** Whether the text looks like JavaScript source rather than data. */
function looksLikeJavaScript(text: string): boolean {
  const markers = [
    'function',
    '=>',
    'require',
    'export',
    'import',
    'var ',
    'let ',
    'const ',
    'class ',
  ];
  for (const marker of markers) {
    if (text.includes(marker)) {
      return true;
    }
  }
  if (text.startsWith('!') || text.startsWith('(') || text.startsWith('window')) {
    return true;
  }
  return false;
}

/**
 * Extract the callback name from a JSONP body.
 *
 * Returns `null` when the body is not JSONP. Useful for callers that want to
 * unwrap the payload into plain JSON.
 */
export function jsonpCallbackName(text: string): string | null {
  const match = /^(?:window\.)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(\s*[[{]/.exec(
    text,
  );
  return match?.[1] ?? null;
}

/**
 * Unwrap a JSONP body into its JSON text.
 *
 * Returns `null` when the body is not JSONP or the inner JSON does not parse.
 * The trailing `);` and optional semicolon are tolerated, as is a leading
 * `/**\/` comment, which some endpoints prepend.
 */
export function unwrapJsonp(text: string): string | null {
  let body = text.trim();
  // Strip a leading block comment.
  if (body.startsWith('/*')) {
    const end = body.indexOf('*/');
    if (end >= 0) {
      body = body.slice(end + 2).trim();
    }
  }

  if (!looksLikeJsonp(body)) {
    return null;
  }

  const open = body.indexOf('(');
  const close = body.lastIndexOf(')');
  if (open < 0 || close < 0 || close <= open) {
    return null;
  }

  const inner = body.slice(open + 1, close).trim();
  try {
    JSON.parse(inner);
    return inner;
  } catch {
    return null;
  }
}