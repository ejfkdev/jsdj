/**
 * The browser entry point.
 *
 * Same API as the main entry, but resolved by bundlers via the `browser` export
 * condition so that a browser build never follows an `import('node:fs')` path.
 *
 * The practical differences from the Node entry, all reported rather than thrown:
 *
 * - **No file cache.** The default store is a no-op, so scans always hit the
 *   network. Supply a `storage` (OPFS, IndexedDB, your own backend) to get cache
 *   reuse.
 * - **No TLS fingerprinting.** The browser owns the TLS stack. `tlsFingerprint` is
 *   accepted and ignored.
 * - **CORS applies.** A cross-origin fetch succeeds only when the target permits
 *   it, so scanning arbitrary sites will usually fail. Supply a `transport` that
 *   routes through an origin you control, which is the intended way to scan from
 *   a browser.
 *
 * The source map parser, all plugins, the URL helpers and the content decoders are
 * platform-neutral and work identically here.
 */

export {
  scan,
  discover,
  scanWithPipeline,
  prepare,
  ScanInputError,
  type ScanOptions,
  type FetchInjection,
} from './scan.js';

export {
  Pipeline,
  isValidSourceMap,
  decodeDataUri,
  EntryFetchError,
} from './extractor/pipeline.js';
export { PluginRegistry } from './extractor/registry.js';
export { KnowledgeBase } from './extractor/knowledge.js';
export { createDefaultRegistry, BUILTIN_PLUGIN_NAMES } from './plugins/index.js';

export {
  decodeContent,
  detectContentKind,
  jsonpCallbackName,
  looksLikeJsonp,
  unwrapJsonp,
} from './extractor/decode.js';

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

export {
  formatJson,
  formatMarkdown,
  formatOutput,
  formatText,
  formatTextSummary,
} from './extractor/output.js';

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

// The browser client and the transport contracts. `NodeHttpClient` and
// `FsStorage` are deliberately absent: importing this module must not reference a
// Node builtin.
export {
  BrowserHttpClient,
  Fetcher,
  HttpError,
  getHeader,
  DEFAULT_USER_AGENT,
  browserHeaders,
  detectRuntime,
  parseProxyUrl,
  resolveProxy,
  hostnameOf,
  Semaphore,
  AbortError,
  mapPool,
  NullStorage,
  MemoryStorage,
  scopeFromUrl,
  normalizePathForFile,
  safeSourcePath,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
  type FetcherOptions,
  type FetchResult,
  type TlsFingerprintMode,
  type Runtime,
  type Storage,
  type StorageKey,
} from './fetcher/browser-exports.js';

export { nullLogger, memoryLogger, type Logger } from './extractor/logger.js';

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