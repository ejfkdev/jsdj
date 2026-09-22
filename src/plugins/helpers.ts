/**
 * Shared helpers for plugins.
 *
 * Every plugin repeats the same shape: build a `Result`, run some regexes,
 * and for each capture either push an absolute URL into `URLs` or — when the
 * capture is a relative fragment — push it into `ProbeTargets` after resolving it
 * and checking the result. That pattern is factored here so plugins read as the
 * pattern list they actually are.
 */

import type {
  DiscoveredResource,
  IntermediateResource,
  PluginContext,
  PluginResult,
  ProbeRequest,
} from '../extractor/types.js';
import { isAbsoluteUrl, normalizeUrl, resolveRelativePath } from '../extractor/url.js';

/**
 * Maximum entries a single plugin result may contribute.
 *
 * Named for the micro-app plugins it was introduced for, but the HTML pivot plugin
 * uses the same cap, and that is where it matters most: a page's navigation can list
 * far more pages than the crawl budget allows, and a plugin that hands the pipeline
 * every one of them lets a single page consume the whole budget before the pages it
 * links to have been fetched. Capping the per-plugin contribution keeps the budget
 * spread across the crawl.
 *
 * The value matches the reference implementation exactly; an earlier revision of this
 * port used 200, which measurably reduced coverage on large multi-page sites.
 */
export const MAX_MICRO_APP_ENTRIES = 50;

/**
 * Accumulates plugin findings.
 *
 * `add` resolves a capture against the source URL and routes it to either
 * `urls` or `probeTargets`, deduplicating within the result. The routing rule is
 * the important part: a capture that resolves to something absolute is fetchable
 * immediately, while one that does not is a fragment needing later resolution
 * against known-good URLs.
 */
export class ResultBuilder {
  private readonly urls: DiscoveredResource[] = [];
  private readonly probeTargets: DiscoveredResource[] = [];
  private readonly publicPaths: string[] = [];
  private readonly prependUrls: string[] = [];
  private readonly intermediates: IntermediateResource[] = [];
  private readonly probeRequests: ProbeRequest[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly sourceUrl: string) {}

  /**
   * Add a discovered reference.
   *
   * Returns whether it was added. `isInline` marks findings from inline script
   * bodies, which affects how the pipeline resolves their fragments.
   */
  add(raw: string, options: { isInline?: boolean; forceProbe?: boolean } = {}): boolean {
    const trimmed = raw.trim();
    if (trimmed === '') {
      return false;
    }

    // `forceProbe` is for plugins that know the capture is a fragment even when
    // it happens to resolve — a `//host/path` capture, for instance.
    if (options.forceProbe) {
      return this.addProbe(trimmed, options.isInline);
    }

    const absolute = normalizeUrl(resolveRelativePath(this.sourceUrl, trimmed));
    if (isAbsoluteUrl(absolute)) {
      const key = `u:${absolute}`;
      if (this.seen.has(key)) {
        return false;
      }
      this.seen.add(key);
      this.urls.push({
        url: absolute,
        fromUrl: this.sourceUrl,
        isInline: options.isInline ?? false,
      });
      return true;
    }

    return this.addProbe(trimmed, options.isInline);
  }

  /** Add a reference known to be a fragment needing resolution. */
  addProbe(fragment: string, isInline = false): boolean {
    const key = `p:${fragment}`;
    if (this.seen.has(key)) {
      return false;
    }
    this.seen.add(key);
    this.probeTargets.push({
      url: fragment,
      fromUrl: this.sourceUrl,
      isInline,
    });
    return true;
  }

  /** Add an already-absolute URL without re-resolving it. */
  addAbsolute(url: string, isInline = false): boolean {
    const key = `u:${url}`;
    if (this.seen.has(key)) {
      return false;
    }
    this.seen.add(key);
    this.urls.push({ url, fromUrl: this.sourceUrl, isInline });
    return true;
  }

  /** Record a `publicPath`. */
  addPublicPath(...paths: string[]): void {
    for (const p of paths) {
      if (p !== '' && !this.publicPaths.includes(p)) {
        this.publicPaths.push(p);
      }
    }
  }

  /** Record a URL prefix to prepend when resolving bare filenames. */
  addPrependUrl(...urls: string[]): void {
    for (const u of urls) {
      if (u !== '' && !this.prependUrls.includes(u)) {
        this.prependUrls.push(u);
      }
    }
  }

  /** Record a manifest or other config resource to fetch and re-dispatch. */
  addIntermediate(resource: IntermediateResource): void {
    const key = `i:${resource.url}`;
    if (this.seen.has(key)) {
      return;
    }
    this.seen.add(key);
    this.intermediates.push(resource);
  }

  /**
   * Record a request whose response should be analysed but which is not a
   * resource to report.
   *
   * Used by the Next.js plugin: re-requesting a route with an `RSC: 1` header
   * returns flight data that enumerates chunks, but the request URL itself is a
   * page, not an artifact. Deduplicated by URL plus a marker of the varying
   * headers so the same URL can still be probed both with and without `RSC`.
   */
  addProbeRequest(request: ProbeRequest): void {
    const key = `q:${request.url}:${Object.keys(request.headers).sort().join(',')}`;
    if (this.seen.has(key)) {
      return;
    }
    this.seen.add(key);
    this.probeRequests.push({ url: request.url, headers: { ...request.headers } });
  }

  /** Whether anything has been found yet. */
  get isEmpty(): boolean {
    return (
      this.urls.length === 0 &&
      this.probeTargets.length === 0 &&
      this.intermediates.length === 0 &&
      this.probeRequests.length === 0
    );
  }

  /** Number of URL findings. */
  get urlCount(): number {
    return this.urls.length;
  }

  /** Number of intermediate findings, used by plugins that cap their contribution. */
  get intermediateCount(): number {
    return this.intermediates.length;
  }

  /** Freeze into a `PluginResult`. */
  build(): PluginResult {
    const result: PluginResult = {};
    if (this.urls.length > 0) {
      result.urls = this.urls;
    }
    if (this.probeTargets.length > 0) {
      result.probeTargets = this.probeTargets;
    }
    if (this.publicPaths.length > 0) {
      result.publicPaths = this.publicPaths;
    }
    if (this.prependUrls.length > 0) {
      result.prependUrls = this.prependUrls;
    }
    if (this.intermediates.length > 0) {
      result.intermediates = this.intermediates;
    }
    if (this.probeRequests.length > 0) {
      result.probeRequests = this.probeRequests;
    }
    return result;
  }
}

/**
 * Run a global regex over text and invoke `fn` for each match's capture groups.
 *
 * Go's `FindAllSubmatch` returns every match with all groups; JavaScript's
 * `matchAll` does the same, but a fresh regex object is needed per call because
 * `lastIndex` is stateful on `/g` patterns. Regenerating the regex from its
 * source preserves the plugin definitions as plain literals.
 */
export function forEachMatch(
  pattern: RegExp,
  text: string,
  fn: (groups: (string | undefined)[], match: RegExpMatchArray) => void,
): void {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const global = new RegExp(pattern.source, flags);
  for (const match of text.matchAll(global)) {
    fn(match.slice(1), match);
  }
}

/**
 * Run a global regex and return the first capture of each match.
 *
 * Skips matches whose first capture is `undefined`, which is what plugins want
 * in the common case where group 1 is the payload.
 */
export function findAllFirst(pattern: RegExp, text: string): string[] {
  const out: string[] = [];
  forEachMatch(pattern, text, (groups) => {
    const first = groups[0];
    if (first !== undefined) {
      out.push(first);
    }
  });
  return out;
}

/**
 * Pick the first non-empty capture among `groups`.
 *
 * Several plugins match the same attribute in either order (for example
 * `<link href=... rel=prefetch>` and `<link rel=prefetch href=...>`), which
 * requires two capture groups where exactly one will be populated.
 */
export function firstPresent(
  groups: readonly (string | undefined)[],
): string {
  for (const group of groups) {
    if (group !== undefined && group !== '') {
      return group;
    }
  }
  return '';
}

/** Strip trailing punctuation that regex captures frequently pick up. */
export function cleanUrlTrailing(rawUrl: string): string {
  let url = rawUrl;
  while (url.length > 0) {
    const last = url[url.length - 1]!;
    if (
      last === ')' ||
      last === ',' ||
      last === ';' ||
      last === '"' ||
      last === "'" ||
      last === '>' ||
      last === ' '
    ) {
      url = url.slice(0, -1);
      continue;
    }
    break;
  }
  return url;
}

/**
 * Whether a captured path is a bundler-internal module id rather than a
 * fetchable URL.
 *
 * Wrapped/minified bundles contain module specifiers like
 * `./node_modules/lodash/isObjectLike.js` and `webpack:///./src/App.js`. These
 * look like URLs to a loose regex but were never served over HTTP, so queueing
 * them produces a flood of 404s.
 */
export function isBundlerInternalPath(path: string): boolean {
  if (path.includes('node_modules/')) {
    return true;
  }
  return path.startsWith('webpack://') || path.startsWith('webpack-internal://');
}

const NON_JS_EXTENSIONS = [
  '.css',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.ico',
  '.json',
  '.xml',
  '.txt',
  '.pdf',
  '.zip',
  '.rar',
  '.7z',
  '.html',
  '.htm',
  '.map',
  '.woff',
  '.ttf',
  '.otf',
  '.eot',
];

/**
 * Whether a captured string is plausibly a JS file URL.
 *
 * The subtle part is ordering: a string like `style.css?import=/a.js` contains
 * both `.js` and `.css`; it is rejected by checking whether any non-JS
 * extension appears *before* the first `.js`. That ordering check is preserved.
 */
export function looksLikeJsUrl(rawUrl: string): boolean {
  const lower = rawUrl.toLowerCase();

  if (
    lower.startsWith('data:') ||
    lower.startsWith('blob:') ||
    lower.startsWith('about:')
  ) {
    return false;
  }

  const jsIdx = lower.indexOf('.js');
  if (jsIdx < 0) {
    return false;
  }

  for (const ext of NON_JS_EXTENSIONS) {
    const extIdx = lower.indexOf(ext);
    if (extIdx >= 0 && extIdx < jsIdx) {
      return false;
    }
  }

  if (lower.endsWith('.map')) {
    return false;
  }

  return true;
}

/** Whether a value looks like an HTML page rather than a resource. */
export function looksLikeHtmlEntry(value: string): boolean {
  if (value === '') {
    return false;
  }
  const lower = value.toLowerCase();
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    return true;
  }
  // A bare path or a directory: could be a server route or an index page.
  const withoutTrailing = lower.replace(/\/+$/, '');
  return !withoutTrailing.includes('.');
}

/**
 * Whether `content` contains any of `needles` within `[start, end)`.
 *
 * Used by micro-app plugins to confirm that a matched `entry` value sits in a
 * qiankun/garfish/micro-app configuration context rather than being an unrelated
 * string that happens to match the entry pattern.
 */
export function hasContextNearby(
  content: string,
  start: number,
  end: number,
  keywords: readonly string[],
): boolean {
  const window = 400;
  const from = Math.max(0, start - window);
  const to = Math.min(content.length, end + window);
  const slice = content.slice(from, to);
  return keywords.some((keyword) => slice.includes(keyword));
}

/** Whether the content contains any of the given substrings. */
export function containsAny(content: string, needles: readonly string[]): boolean {
  return needles.some((needle) => content.includes(needle));
}

/** Whether the content contains all of the given substrings. */
export function containsAll(content: string, needles: readonly string[]): boolean {
  return needles.every((needle) => content.includes(needle));
}

/**
 * Resolve an entry value from a micro-app config into an HTML intermediate.
 *
 * Entry values point at a sub-application's HTML directory, so the path needs
 * the same three-candidate treatment the HTML pivot plugin applies: the value
 * itself, `<value>/index.html`, and `<value>.html`.
 */
export function addMicroAppEntry(
  builder: ResultBuilder,
  value: string,
  sourceUrl: string,
  seen: Set<string>,
): boolean {
  const trimmed = value.trim();
  if (trimmed === '') {
    return false;
  }
  // Template placeholders cannot be resolved statically.
  if (trimmed.includes('${')) {
    return false;
  }

  const candidates: string[] = [];
  if (trimmed.endsWith('.html') || trimmed.endsWith('.htm')) {
    candidates.push(trimmed);
  } else {
    const withoutTrailing = trimmed.replace(/\/+$/, '');
    candidates.push(withoutTrailing);
    candidates.push(`${withoutTrailing}/index.html`);
    candidates.push(`${withoutTrailing}.html`);
  }

  let added = false;
  for (const candidate of candidates) {
    const absolute = normalizeUrl(resolveRelativePath(sourceUrl, candidate));
    if (!isAbsoluteUrl(absolute) || seen.has(absolute)) {
      continue;
    }
    seen.add(absolute);
    builder.addIntermediate({
      url: absolute,
      type: 'html',
      fromUrl: sourceUrl,
    });
    added = true;
  }
  return added;
}

/** Read `knownPaths` from the plugin context, tolerating a bare object. */
export function contextKnownPaths(ctx: PluginContext | undefined): readonly string[] {
  return ctx?.knownPaths ?? [];
}