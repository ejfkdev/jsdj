/**
 * jsdj — extract JS URLs and source maps from websites.
 *
 * A TypeScript library and CLI. It
 * discovers dynamically loaded JavaScript (webpack chunks, `import()`, framework
 * manifests), finds source maps, and restores original sources from them.
 *
 * ## Two entry points
 *
 * - {@link scan} — the high-level call. Assembles a transport, a store and the
 *   built-in plugin set, then runs everything.
 * - The named exports below — every layer the pipeline uses, so a caller can
 *   replace or call any piece individually: fetch one URL, run one plugin, parse
 *   one source map, resolve one fragment.
 *
 * ## Platform behaviour
 *
 * | | Node | Browser |
 * |---|---|---|
 * | File cache | on by default, configurable | none; inject a `Storage` |
 * | TLS fingerprint | via the optional sidecar, else ignored | never available |
 * | Requests | any host | subject to CORS |
 *
 * Nothing here throws because a platform lacks a capability. The TLS fingerprint
 * option is accepted and ignored where it cannot apply, and caching degrades to
 * pass-through.
 *
 * @example
 * ```ts
 * import { scan } from '@ejfkdev/jsdj';
 *
 * const result = await scan({
 *   url: 'https://example.com',
 *   headers: { Referer: 'https://example.com' },
 *   tlsFingerprint: 'chrome',
 * });
 *
 * console.log(result.jsUrls);
 * // Restored sources come back as content, not just paths:
 * for (const file of result.sources) {
 *   console.log(file.path, file.content.length);
 * }
 * ```
 *
 * @example Injecting a custom transport
 * ```ts
 * import { scan } from '@ejfkdev/jsdj';
 *
 * // Only a fetch function is required; the scan supplies headers and cookies.
 * const result = await scan({
 *   url: 'https://example.com',
 *   transport: {
 *     async fetch(req) {
 *       const res = await myTlsStack(req.url, {
 *         method: req.method,
 *         headers: req.headers,
 *       });
 *       return {
 *         status: res.status,
 *         headers: res.headers,
 *         body: res.body,
 *       };
 *     },
 *   },
 * });
 * ```
 *
 * @packageDocumentation
 */

// ===== High-level API =====

export {
  scan,
  discover,
  scanWithPipeline,
  prepare,
  ScanInputError,
  type ScanOptions,
  type FetchInjection,
} from './scan.js';

// ===== Pipeline and plugins =====

export {
  Pipeline,
  isValidSourceMap,
  decodeDataUri,
  EntryFetchError,
} from './extractor/pipeline.js';
export { PluginRegistry } from './extractor/registry.js';
export { KnowledgeBase } from './extractor/knowledge.js';
export {
  createDefaultRegistry,
  BUILTIN_PLUGIN_NAMES,
  // Individual plugins, for direct use or a custom registry.
  HtmlScriptPlugin,
  DynamicImportPlugin,
  EsmImportPlugin,
  ScriptCreatePlugin,
  SourceMapPlugin,
  UniversalUrlPlugin,
  ModernJsPlugin,
  NuxtPlugin,
  RequireJsPlugin,
  SvelteKitPlugin,
  TrunkPlugin,
  VitePlugin,
  WebpackPlugin,
  NextJsPlugin,
  GarfishPlugin,
  IcestarkPlugin,
  MicroAppPlugin,
  QiankunPlugin,
  WujiePlugin,
  HtmlPivotPlugin,
  EmpPlugin,
  ModuleFederationManifestPlugin,
  ModuleFederationPlugin,
  HelMicroPlugin,
  isHelMicroMetadata,
} from './plugins/index.js';

// ===== Content decoding and classification =====

export {
  decodeContent,
  detectContentKind,
  jsonpCallbackName,
  looksLikeJsonp,
  unwrapJsonp,
} from './extractor/decode.js';

// ===== URL helpers =====

export {
  buildSourceMapUrl,
  expandComboLoader,
  getBaseUrl,
  getDirFromUrl,
  isAbsoluteUrl,
  isLikelyStaticResource,
  isSourceMapUrl,
  joinUrlPath,
  normalizeUrl,
  rebaseLoopbackOrigin,
  resolveRelativePath,
  unique,
} from './extractor/url.js';

// ===== Output rendering =====

export {
  formatJson,
  formatMarkdown,
  formatOutput,
  formatText,
  formatTextSummary,
} from './extractor/output.js';

// ===== Source maps =====

export {
  parse as parseSourceMap,
  hasSourcesContent,
  restoreFiles,
  reconstructFromMappings,
  parseMappings,
  decodeVLQSegment,
  normalizeSourcePath,
  sanitizePathSegments,
  safeFilePath,
  SourceMapParseError,
  type SourceMap,
  type SourceFile,
  type RestoreMode,
  type Mapping,
} from './sourcemap/index.js';

// ===== Transport =====

export {
  Fetcher,
  NodeHttpClient,
  BrowserHttpClient,
  HttpError,
  // A transport author needs this: a server may send headers in any casing, and
  // plugins expect lower-cased keys.
  getHeader,
  DEFAULT_USER_AGENT,
  MAX_BODY_SIZE,
  browserHeaders,
  minimalHeaders,
  TLS_FINGERPRINT_PROFILES,
  detectRuntime,
  hasFilesystem,
  parseProxyUrl,
  resolveProxy,
  shouldBypassProxy,
  hostnameOf,
  CookieJar,
  parseCookieString,
  Semaphore,
  AbortError,
  mapPool,
  loadTlsSidecar,
  SIDECAR_PACKAGE,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
  type FetcherOptions,
  type FetchResult,
  type TlsFingerprintMode,
  type TlsFingerprintProfile,
  type Runtime,
  type Cookie,
  type TlsSidecar,
  type EnvLookup,
} from './fetcher/index.js';

// ===== Storage =====

export {
  NullStorage,
  MemoryStorage,
  FsStorage,
  createStorage,
  scopeFromUrl,
  normalizePathForFile,
  safeSourcePath,
  DEFAULT_CACHE_SUBDIR,
  type Storage,
  type StorageKey,
  type FsStorageOptions,
} from './fetcher/index.js';

// ===== Logging =====

export {
  nullLogger,
  memoryLogger,
  stderrLogger,
  type Logger,
} from './extractor/logger.js';

// ===== Types =====

export type {
  AnalyzeInput,
  CacheDirs,
  ContentKind,
  DiscoveredResource,
  HtmlEntry,
  InlineScript,
  IntermediateResource,
  JsEntry,
  JsMetadata,
  OutputFormat,
  Plugin,
  PluginContext,
  PluginResult,
  ProbeRequest,
  RestoredSource,
  ScanResult,
  ScanSummary,
  SiteMetadata,
} from './extractor/types.js';