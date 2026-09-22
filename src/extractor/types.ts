/**
 * Core types for the extraction pipeline.
 *
 * Extractor interfaces and result types, with two
 * deliberate changes:
 *
 * - Payload kind is a proper discriminated union. A browser `Content-Type`
 *   of `application/json` and a `.js` URL whose body is JSONP both landed in an
 *   undifferentiated "not HTML, so treat as JS" bucket. Here JSON and JSONP are
 *   named, so a plugin can tell them apart.
 * - Restored source *content* is carried in the result, not only written to
 *   disk. Paths are written to `sources/` and reported; a library consumer wants the
 *   bytes.
 */

/** What a fetched resource turned out to be. */
export type ContentKind = 'html' | 'js' | 'json' | 'jsonp' | 'flight';

/** Input handed to a plugin for analysis. */
export interface AnalyzeInput {
  /** Absolute URL the content came from. Used as the base for relative paths. */
  sourceUrl: string;
  /** Detected payload kind. */
  contentType: ContentKind;
  /** Raw content bytes. */
  content: Uint8Array;
  /** Response headers, keys lower-cased. Present when the content came from HTTP. */
  headers?: Record<string, string>;
  /**
   * Text form of `content`, decoded once and shared.
   *
   * Plugins are overwhelmingly regex-driven, so decoding per plugin was
   * wasteful. Populated by the pipeline before dispatch.
   */
  text?: string;
}

/** A JS (or other resource) URL discovered by a plugin, with provenance. */
export interface DiscoveredResource {
  /** The URL, absolute or a relative fragment awaiting resolution. */
  url: string;
  /** URL of the document the discovery was made in. */
  fromUrl?: string;
  /** Plugin responsible for the discovery. */
  fromPlugin?: string;
  /** Whether the discovery came from an inline `<script>` body. */
  isInline?: boolean;
}

/**
 * A non-JS resource a plugin wants the pipeline to fetch and re-dispatch.
 *
 * Used for build manifests: `manifest.json`, `.vite/manifest.json`, `emp.json`
 * and friends, whose contents enumerate the real entry points.
 */
export interface IntermediateResource {
  /** Absolute URL of the resource. */
  url: string;
  /** Kind the pipeline should treat the fetched content as. */
  type: ContentKind;
  /** URL of the document that referenced this resource. */
  fromUrl?: string;
}

/** An inline `<script>` body lifted out of an HTML document. */
export interface InlineScript {
  /** URL of the HTML document the script sits in. */
  sourceUrl: string;
  /** Position of the script within the document, used as a dedup key. */
  index: number;
  /** Script body. */
  content: string;
}

/**
 * A request a plugin wants issued to obtain data not present in the page.
 *
 * Currently only used by the Next.js plugin, which probes the same route with an
 * `RSC: 1` header to retrieve the React Server Components flight payload.
 */
export interface ProbeRequest {
  /** URL to request. */
  url: string;
  /** Headers to add for this request. */
  headers: Record<string, string>;
}

/** What a plugin returns. */
export interface PluginResult {
  /** Name of the producing plugin. Set by the dispatcher. */
  fromPlugin?: string;

  /** Fully-formed URLs to fetch next. */
  urls?: DiscoveredResource[];

  /**
   * Relative path fragments needing resolution against known URLs.
   *
   * Webpack runtimes routinely reference chunks as `static/js/async/foo.js`
   * without a scheme or host. These are resolved by matching against URLs
   * already known to exist, which is why they cannot be queued directly.
   */
  probeTargets?: DiscoveredResource[];

  /** `publicPath` values, which become prefixes for later fragment resolution. */
  publicPaths?: string[];

  /** URL prefixes to prepend when resolving bare filenames. */
  prependUrls?: string[];

  /** Manifests and other config resources to fetch and re-dispatch. */
  intermediates?: IntermediateResource[];

  /** Inline script bodies to analyse as JS. */
  inlineScripts?: InlineScript[];

  /** Requests to issue for supplementary data. */
  probeRequests?: ProbeRequest[];
}

/**
 * A plugin.
 *
 * `precheck` exists purely as a cheap filter: most plugins are irrelevant to
 * most payloads, and the pipeline calls `precheck` before `analyze`.
 */
export interface Plugin {
  /** Unique plugin name, recorded as provenance on every discovery. */
  readonly name: string;
  /** Cheap test for whether this plugin could apply. Must not throw. */
  precheck(input: AnalyzeInput, ctx: PluginContext): boolean;
  /** Full analysis. Return an empty result rather than throwing. */
  analyze(
    input: AnalyzeInput,
    ctx: PluginContext,
  ): PluginResult | Promise<PluginResult>;
}

/**
 * Read-only view of discovered state that plugins may consult.
 *
 * Passing it explicitly rather than through an ambient context is
 * the same coupling without the hidden channel.
 */
export interface PluginContext {
  /** `publicPath` values discovered so far. */
  readonly publicPaths: readonly string[];
  /** URL prefixes to prepend when resolving bare filenames. */
  readonly prependUrls: readonly string[];
  /** URLs confirmed to exist, used as anchors for fragment resolution. */
  readonly knownPaths: readonly string[];
}

/** One discovered JS file, with full provenance. */
export interface JsEntry {
  /** Absolute URL. */
  url: string;
  /** URL of the document the discovery was made in. */
  fromUrl?: string;
  /** Plugin that found it. */
  fromPlugin?: string;
  /** Whether it came from an inline script body. */
  isInline?: boolean;
}

/** A separate HTML document entered during the crawl (multi-page, iframes). */
export interface HtmlEntry {
  /** Absolute URL. */
  url: string;
  /** URL of the document that linked to it. */
  fromUrl?: string;
  /** Plugin that found it. */
  fromPlugin?: string;
}

/** A source file restored from a source map. */
export interface RestoredSource {
  /** Path relative to the `sources/` root, preserving original structure. */
  path: string;
  /** File content. */
  content: string;
  /** How the content was produced. */
  mode: 'sourcesContent' | 'mappings';
  /** URL of the JS file whose map produced this source. */
  fromJs?: string;
}

/** Where artifacts for a scan ended up on disk, when there is a disk. */
export interface CacheDirs {
  js?: string;
  sourceMap?: string;
  source?: string;
  html?: string;
}

/** Counts summarising a scan. */
export interface ScanSummary {
  /** Number of distinct JS URLs discovered. */
  jsCount: number;
  /** Number of source maps found. */
  sourceMapCount: number;
  /** Number of source files restored. */
  sourceCount: number;
}

/**
 * The complete result of a scan.
 *
 * `sources` holds the restored content so a library caller never has to read the
 * filesystem. It is capped by `maxInlineSources` to keep a scan of a large
 * application from holding hundreds of megabytes of source text in memory; the
 * files on disk and the per-entry `sources` metadata are complete regardless.
 */
export interface ScanResult {
  /** Counts. */
  summary: ScanSummary;
  /** Distinct JS URLs, in discovery order. */
  jsUrls: string[];
  /** Per-URL provenance. */
  jsDetails: JsEntry[];
  /** Separate HTML documents entered. */
  htmlEntries: HtmlEntry[];
  /** Restored source files, including content. */
  sources: RestoredSource[];
  /**
   * Number of restored sources omitted from `sources` because the inline cap was
   * reached. `summary.sourceCount` is the true total.
   */
  sourcesOmitted: number;
  /** Cache root for the site, when a filesystem cache was used. */
  cacheBase?: string;
  /** Cache subdirectories, when a filesystem cache was used. */
  cacheDirs?: CacheDirs;
  /** Output directory, when `-o/--output` equivalent was configured. */
  outputDir?: string;
  /** Output subdirectories. */
  outputDirs?: CacheDirs;
  /** Source maps found, keyed by the JS URL they belong to. */
  sourceMaps?: Record<string, string>;
}

/** Output rendering formats (`-f`). */
export type OutputFormat = 'text' | 'json' | 'md';

/** Per-JS provenance record written to site metadata. */
export interface JsMetadata {
  url: string;
  localPath: string;
  sourceUrl: string;
  isInline: boolean;
  sourceMapUrl?: string;
  sourceMapPath?: string;
  sourcesRestored?: boolean;
  restoredSourceCount?: number;
  restoredSources?: string[];
  fromPlugin?: string;
  discoveredAt: number;
}

/** Cache directory record written to site metadata. */
export interface CacheDirsMetadata {
  html?: string;
  js?: string;
  sourceMap?: string;
  sources?: string;
}

/** Site metadata document persisted as `meta.json`. */
export interface SiteMetadata {
  urls: JsMetadata[];
  prependUrls: string[];
  publicPaths: string[];
  cacheDirs?: CacheDirsMetadata;
  discoveredAt: number;
}