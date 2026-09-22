/**
 * URL helpers.
 *
 * The web platform's `URL` class handles most of this correctly, which makes
 * several of the Go helpers unnecessary — but three behaviours are deliberate
 * and must be preserved: `normalizeUrl`'s fragment stripping and path cleaning,
 * `rebaseLoopbackOrigin`'s dev-server rewriting, and `expandComboLoader`'s
 * handling of `??` CDN bundles.
 */

/** Whether `s` is an absolute `http(s)` URL. */
export function isAbsoluteUrl(s: string): boolean {
  return s.startsWith('http://') || s.startsWith('https://');
}

/**
 * Resolve `relative` against `baseUrl`, returning an absolute URL.
 *
 * Returns `relative` unchanged when either input is unparseable:
 * an unresolvable fragment is still worth carrying forward as a probe target.
 */
export function resolveRelativePath(baseUrl: string, relative: string): string {
  try {
    return new URL(relative, baseUrl).toString();
  } catch {
    return relative;
  }
}

/**
 * Normalise a URL for use as a pipeline key.
 *
 * Replicates `NormalizeURL`, which is `Fragment = ""` plus
 * `Path = path.Clean(Path)` when the path is non-empty. Three consequences are
 * load-bearing, because the normalised string is the pipeline's identity for a
 * resource (it keys dedup, `urlContext` and the cache):
 *
 * - The fragment is dropped: it never affects what the server returns.
 * - A **trailing slash is stripped** from a non-empty path, since that is what
 *   `path.Clean` does. `https://a.test/guide/` and `https://a.test/guide` are
 *   therefore the same URL here.
 * - An **empty path stays empty**, so a bare origin is not rewritten to a
 *   trailing-slash form. `new URL('https://a.test').pathname` is `'/'`, so the
 *   raw text has to be inspected rather than the parsed pathname, or a bare
 *   origin would gain a slash that is not added.
 *
 * Dot segments and duplicate slashes are collapsed, matching `path.Clean`.
 *
 * Idempotent, which the pipeline relies on: URLs are normalised both on enqueue
 * and again on dequeue, and the `urlContext` map is keyed by the normalised form.
 */
export function normalizeUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return rawUrl;
  }

  parsed.hash = '';

  // Whether the input had an explicit path at all. `new URL()` fills in `/` for a
  // bare origin, so the slash has to be removed again when the source text had
  // none — that is the difference between `https://a.test` and `https://a.test/`.
  const afterScheme = rawUrl.slice(rawUrl.indexOf('://') + 3);
  const hasExplicitPath = afterScheme.includes('/') || afterScheme.includes('?');

  if (!hasExplicitPath) {
    // Rebuild without a path, preserving the query if one was present.
    const queryIdx = rawUrl.indexOf('?');
    const query = queryIdx >= 0 ? rawUrl.slice(queryIdx) : '';
    return `${parsed.protocol}//${parsed.host}${query}`;
  }

  const cleaned = cleanPath(parsed.pathname);
  if (cleaned !== '') {
    parsed.pathname = cleaned;
  }

  return parsed.toString();
}

/**
 * Collapse `.`, `..` and duplicate slashes in a path, mirroring Go's `path.Clean`.
 *
 * The trailing slash is dropped. An input of `/` stays `/`, since Go returns `/`
 * for a root path and the caller then keeps it.
 */
function cleanPath(pathname: string): string {
  if (pathname === '/' || pathname === '') {
    return pathname;
  }

  const segments = pathname.split('/');
  const stack: string[] = [];

  for (const segment of segments) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      // Climb only within the path; never above the root.
      if (stack.length > 0) {
        stack.pop();
      }
      continue;
    }
    stack.push(segment);
  }

  // A path that reduced to nothing was a relative traversal to the root.
  return stack.length === 0 ? '/' : '/' + stack.join('/');
}

/**
 * Rewrite a loopback URL onto the origin being scanned.
 *
 * Build artifacts sometimes bake in a dev-server address such as
 * `http://127.0.0.1:50315/remoteEntry.js`. When the same build is served from a
 * different port, the baked address is dead but the path is valid. Remapping the
 * origin recovers those chunks.
 *
 * Only applied when the target is loopback and its origin differs from
 * `sourceUrl`'s; anything else is returned unchanged.
 *
 * Note on the implementation: assigning `url.host = source.host` does **not**
 * replace the port. The WHATWG `URL` host setter parses the incoming string and
 * merges its components, so a target port of 50315 survives an assignment of
 * `example.test` and yields `example.test:50315`. The origin is therefore rebuilt
 * from string parts, which matches what the Go original effectively did.
 */
export function rebaseLoopbackOrigin(rawUrl: string, sourceUrl: string): string {
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return rawUrl;
  }

  const hostname = target.hostname;
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') {
    return rawUrl;
  }

  let source: URL;
  try {
    source = new URL(sourceUrl);
  } catch {
    return rawUrl;
  }
  if (source.host === '') {
    return rawUrl;
  }
  // Already on the scanned origin: nothing to rewrite.
  if (target.host === source.host && target.protocol === source.protocol) {
    return rawUrl;
  }

  const schemeEnd = rawUrl.indexOf('://');
  if (schemeEnd < 0) {
    return rawUrl;
  }
  const rest = rawUrl.slice(schemeEnd + 3);
  const slash = rest.indexOf('/');
  const pathAndBeyond = slash >= 0 ? rest.slice(slash) : '';
  return `${source.protocol}//${source.host}${pathAndBeyond}`;
}

/** The directory part of a URL, always with a trailing slash. */
export function getDirFromUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }

  if (parsed.pathname === '' || parsed.pathname === '/') {
    return `${parsed.protocol}//${parsed.host}/`;
  }

  // `path.dirname` semantics: drop the last segment.
  const lastSlash = parsed.pathname.lastIndexOf('/');
  const dir = lastSlash <= 0 ? '/' : parsed.pathname.slice(0, lastSlash + 1);
  return `${parsed.protocol}//${parsed.host}${dir}`;
}

/** `scheme://host` for a URL, with no trailing slash. */
export function getBaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
}

/**
 * Join a base URL and a path with exactly one slash between them.
 */
export function joinUrlPath(baseUrl: string, path: string): string {
  if (path === '') {
    return baseUrl;
  }
  const trimmedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const trimmedPath = path.startsWith('/') ? path : `/${path}`;
  return trimmedBase + trimmedPath;
}

/**
 * Expand a CDN combo-loader URL into its individual files.
 *
 * Both WordPress (`/_static/??/js/a.js,/js/b.js`) and Alibaba Cloud CDN
 * (`/path/??a.js,b.js`) use `??` to bundle several files behind one request.
 * The bundle is not itself a JS file, so the individual members are what should
 * be queued.
 *
 * Returns `[rawUrl]` unchanged when there is no `??` or nothing parses out.
 */
export function expandComboLoader(rawUrl: string): string[] {
  const marker = rawUrl.indexOf('??');
  if (marker < 0) {
    return [rawUrl];
  }

  // Deliberately not using URL parsing: `?` would be read as the start of a
  // query string.
  const prefix = rawUrl.slice(0, marker);
  let fileList = rawUrl.slice(marker + 2);

  // A query or fragment may trail the file list.
  let suffix = '';
  const suffixIdx = firstIndexOfAny(fileList, '?#');
  if (suffixIdx >= 0) {
    suffix = fileList.slice(suffixIdx);
    fileList = fileList.slice(0, suffixIdx);
  }

  const urls: string[] = [];
  for (const rawFile of fileList.split(',')) {
    const file = rawFile.trim();
    if (file === '') {
      continue;
    }
    urls.push(normalizeUrl(prefix + file + suffix));
  }

  return urls.length === 0 ? [rawUrl] : urls;
}

/** Index of the first occurrence of any character in `chars`, or -1. */
function firstIndexOfAny(s: string, chars: string): number {
  for (let i = 0; i < s.length; i++) {
    if (chars.includes(s[i]!)) {
      return i;
    }
  }
  return -1;
}

/**
 * Whether a URL looks like a static resource worth reporting.
 *
 * Two checks, and the second is the important one: the path suffix matches a
 * known extension, **or** the full URL (query included) merely contains `.js`.
 * The loose second check is what catches endpoints like
 * `example.com/load?type=module.js` and `hm.baidu.com/hm.js?t=1`, where the
 * extension is not at the end of the path.
 *
 * Note the deliberate consequence: because `.json`
 * contains the substring `.js`, a path like `/.vite/manifest.json` also matches
 * the loose check. The pipeline uses this predicate to decide whether a body
 * with an HTML content type should still be reported as a JS URL, so a manifest
 * path that answers with an HTML error page is reported rather than dropped.
 * That is the intended behaviour and is preserved.
 */
export function isLikelyStaticResource(url: string): boolean {
  const pathEnd = firstIndexOfAny(url, '?#');
  const path = pathEnd >= 0 ? url.slice(0, pathEnd) : url;
  const lowerPath = path.toLowerCase();
  const lowerFull = url.toLowerCase();

  const strictSuffixes = [
    '.js',
    '.mjs',
    '.jsonp',
    '.ts',
    '.tsx',
    '.vue',
    '.css',
    '.woff',
    '.woff2',
    '.ttf',
    '.svg',
    '.png',
    '.jpg',
  ];
  for (const suffix of strictSuffixes) {
    if (lowerPath.endsWith(suffix)) {
      return true;
    }
  }

  // Loose containment check for extensions embedded in a query string.
  for (const needle of ['.js', '.mjs', '.jsonp', '.tsx']) {
    if (lowerFull.includes(needle)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a URL points at a source map.
 *
 * Query strings are ignored, so `app.js.map?v=1` counts.
 */
export function isSourceMapUrl(url: string): boolean {
  const pathEnd = firstIndexOfAny(url, '?#');
  const path = pathEnd >= 0 ? url.slice(0, pathEnd) : url;
  return path.toLowerCase().endsWith('.map');
}

/**
 * Derive the source map URL for a JS URL.
 *
 * The extension is inserted before any query string, so `app.js?v=1` yields
 * `app.js.map?v=1` rather than `app.js?v=1.map`.
 */
export function buildSourceMapUrl(jsUrl: string): string {
  const queryIdx = jsUrl.indexOf('?');
  const path = queryIdx >= 0 ? jsUrl.slice(0, queryIdx) : jsUrl;
  const query = queryIdx >= 0 ? jsUrl.slice(queryIdx) : '';
  return `${path}.map${query}`;
}

/** Deduplicate a list, preserving first-seen order. */
export function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}