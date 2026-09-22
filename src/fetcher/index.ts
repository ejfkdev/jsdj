/**
 * HTTP transport and storage.
 *
 * The public surface here is deliberately narrow: an interface to implement, a
 * couple of built-in implementations, and the facade the extractor uses.
 */

export {
  HttpError,
  getHeader,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from './types.js';

export {
  Fetcher,
  type FetcherOptions,
  type FetchResult,
} from './fetcher.js';

export { NodeHttpClient, type NodeClientOptions } from './node-client.js';
export {
  BrowserHttpClient,
  type BrowserClientOptions,
} from './browser-client.js';

export {
  DEFAULT_USER_AGENT,
  MAX_BODY_SIZE,
  browserHeaders,
  minimalHeaders,
  TLS_FINGERPRINT_PROFILES,
  type TlsFingerprintMode,
  type TlsFingerprintProfile,
} from './headers.js';

export {
  detectRuntime,
  hasFilesystem,
  type Runtime,
} from './runtime.js';

export {
  type Storage,
  type StorageKey,
  scopeFromUrl,
  normalizePathForFile,
  safeSourcePath,
} from './storage.js';

export { FsStorage, createStorage, DEFAULT_CACHE_SUBDIR, type FsStorageOptions } from './fs-storage.js';

// Re-exported from the platform-free module so both entries agree.
export { MemoryStorage, NullStorage } from './memory-storage.js';

export {
  CookieJar,
  parseCookieString,
  type Cookie,
} from './cookies.js';

export {
  parseProxyUrl,
  resolveProxy,
  shouldBypassProxy,
  hostnameOf,
  processEnvLookup,
  type EnvLookup,
} from './proxy.js';

export {
  Semaphore,
  AbortError,
  mapPool,
} from './semaphore.js';

export { decompressBody } from './decompress.js';
export { readBodyWithLimit } from './body.js';

export {
  loadTlsSidecar,
  resetTlsSidecarCache,
  proxyForSidecar,
  SIDECAR_PACKAGE,
  type TlsSidecar,
  type TlsSidecarFactory,
} from './tls-sidecar.js';