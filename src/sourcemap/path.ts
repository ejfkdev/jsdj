/**
 * Source-map `sources` path normalisation.
 *
 * The job is to turn the many path
 * shapes bundlers emit (`webpack:///./src/App.jsx`, `../../../../node_modules`,
 * `file:///home/user/a.js`) into a clean relative path that is safe to write
 * under a `sources/` directory.
 *
 * The security-relevant behaviour is in {@link sanitizePathSegments}: `..` is
 * resolved with normal relative-path semantics, but a `..` that would climb
 * above the root is *dropped* rather than kept, so the result can never escape
 * the output directory.
 */

/** Maximum directory depth for a normalised source path. */
export const MAX_SOURCE_PATH_DEPTH = 32;
/** Maximum character length for a normalised source path. */
export const MAX_SOURCE_PATH_LEN = 512;

/**
 * Strip scheme/protocol prefixes from a source path.
 *
 * ```text
 * webpack:///./src/App.jsx      -> ./src/App.jsx
 * webpack-internal:///./src     -> ./src
 * app:///index.js               -> index.js
 * file:///home/user/a.js        -> home/user/a.js
 * ~/config                      -> config
 * ```
 */
function stripSourcePrefix(s: string): string {
  let trimmed = s.trim();
  if (trimmed === '') {
    return '';
  }

  // Home-directory style prefix.
  if (trimmed.startsWith('~/')) {
    trimmed = trimmed.slice(2);
  }

  // scheme:// or scheme:/// prefix. `://` must not be at position 0, otherwise
  // the "scheme" would be empty.
  const schemeIdx = trimmed.indexOf('://');
  if (schemeIdx > 0) {
    let rest = trimmed.slice(schemeIdx + 3);
    // Drop the authority that may sit between `//` and the first `/`.
    if (rest.startsWith('//')) {
      rest = rest.slice(2);
    }
    if (rest !== '' && !rest.startsWith('/')) {
      const slash = rest.indexOf('/');
      rest = slash >= 0 ? rest.slice(slash + 1) : '';
    }
    trimmed = rest;
  }

  if (trimmed.startsWith('/')) {
    trimmed = trimmed.slice(1);
  }
  if (trimmed.startsWith('./')) {
    trimmed = trimmed.slice(2);
  }
  return trimmed;
}

/**
 * Replace characters that are unsafe in a path segment.
 *
 * Keeps letters, digits, dots, hyphens, underscores, plus and percent — the
 * characters that legitimately appear in bundled filenames. Control characters,
 * path separators and Windows-reserved characters become underscores.
 */
function sanitizeFilenamePart(name: string): string {
  if (name === '') {
    return '_';
  }
  let out = '';
  for (const ch of name) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20) {
      out += '_';
    } else if (
      ch === '/' ||
      ch === '\\' ||
      ch === ':' ||
      ch === '*' ||
      ch === '?' ||
      ch === '"' ||
      ch === '<' ||
      ch === '>' ||
      ch === '|'
    ) {
      out += '_';
    } else {
      out += ch;
    }
  }
  return out === '' ? '_' : out;
}

/**
 * Resolve `.`, `..` and duplicate separators into a clean relative path.
 *
 * `..` pops the previous segment, which is the correct reading of the relative
 * paths Vite/webpack write into `sources` (e.g.
 * `../../../../node_modules/foo.js` genuinely means "climb four levels"). When
 * the stack is empty, the `..` is discarded instead of surfacing in the output,
 * which is what stops an absolute-escape.
 */
export function sanitizePathSegments(p: string): string {
  const trimmed = p.trim();
  if (trimmed === '') {
    return '';
  }

  const parts = trimmed.replace(/\\/g, '/').split('/');
  const stack: string[] = [];
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      if (stack.length > 0) {
        stack.pop();
      }
      // Empty stack: drop the segment rather than escaping the root.
      continue;
    }
    stack.push(sanitizeFilenamePart(part));
  }

  return stack.join('/');
}

/** Truncate an over-long path, preserving the trailing filename. */
function truncatePath(p: string, maxLen: number): string {
  if (p.length <= maxLen) {
    return p;
  }
  const lastSlash = p.lastIndexOf('/');
  const filename = lastSlash >= 0 ? p.slice(lastSlash + 1) : p;
  const keep = maxLen - filename.length - 1;
  if (keep < 0) {
    return p.slice(0, Math.max(maxLen, 1));
  }
  return p.slice(0, keep) + '_' + filename;
}

/** Collapse a path that nests deeper than `maxDepth` into a flat filename. */
function flattenExcessDepth(p: string, maxDepth: number): string {
  const parts = p.split('/');
  if (parts.length - 1 <= maxDepth) {
    return p;
  }
  const keep = parts.slice(0, maxDepth);
  const tail = parts.slice(maxDepth).join('_');
  return keep.join('/') + '/' + tail;
}

/**
 * Normalise a `sources` entry into a safe relative path that keeps its
 * original directory structure.
 *
 * ```text
 * webpack:///./src/App.jsx          -> src/App.jsx
 * webpack:///webpack/bootstrap       -> webpack/bootstrap
 * ../../../../node_modules/foo.js    -> node_modules/foo.js
 * ../../etc/passwd                   -> etc/passwd
 * file:///home/user/a.js             -> home/user/a.js
 * ```
 *
 * `sourceRoot`, when non-empty, is prepended before cleaning. Returns `''` when
 * nothing usable remains (a bare scheme, or only dot segments).
 */
export function normalizeSourcePath(source: string, sourceRoot: string): string {
  const rootPart = stripSourcePrefix(sourceRoot);
  let cleaned = stripSourcePrefix(source);
  if (rootPart !== '') {
    cleaned = rootPart + '/' + cleaned;
  }

  // Re-strip leading separators that the sourceRoot join may have introduced.
  if (cleaned.startsWith('/')) {
    cleaned = cleaned.slice(1);
  }
  if (cleaned.startsWith('./')) {
    cleaned = cleaned.slice(2);
  }

  cleaned = sanitizePathSegments(cleaned);

  if (cleaned === '' || cleaned === '/' || cleaned === '.') {
    return '';
  }

  if (cleaned.length > MAX_SOURCE_PATH_LEN) {
    cleaned = truncatePath(cleaned, MAX_SOURCE_PATH_LEN);
  }
  const depth = (cleaned.match(/\//g) ?? []).length;
  if (depth > MAX_SOURCE_PATH_DEPTH) {
    cleaned = flattenExcessDepth(cleaned, MAX_SOURCE_PATH_DEPTH);
  }

  return cleaned;
}

/**
 * Convert a normalised source path into a relative filesystem-ish path.
 *
 * Returns `''` if the path is absolute or contains a `..` segment — this is the
 * last line of defence before a write, mirroring `SafeFilePath` in the Go
 * original. Separators are always `/`; callers joining to a real directory
 * should treat that as the portable form.
 */
export function safeFilePath(normalizedPath: string): string {
  if (normalizedPath === '') {
    return '';
  }
  // Reject any `..` segment outright — normalizeSourcePath should already have
  // removed them, so seeing one here means a caller bypassed normalisation.
  const parts = normalizedPath.replace(/\\/g, '/').split('/');
  for (const part of parts) {
    if (part === '..') {
      return '';
    }
  }
  if (normalizedPath.startsWith('/')) {
    return normalizedPath.replace(/^\/+/, '');
  }
  return normalizedPath.replace(/\\/g, '/');
}