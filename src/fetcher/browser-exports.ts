/**
 * Platform-neutral transport re-exports for the browser entry.
 *
 * The main `fetcher/index.ts` re-exports `NodeHttpClient` and `FsStorage`, both of
 * which reach for Node builtins via lazy `import()`. A bundler resolving the
 * `browser` export condition still walks those import edges and warns (or fails,
 * depending on configuration), so the browser entry takes its exports from here
 * instead.
 *
 * Nothing in this module references a Node builtin. `MemoryStorage` and
 * `NullStorage` are defined without one; `FsStorage` is deliberately absent.
 */

export {
  HttpError,
  getHeader,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from './types.js';

export { Fetcher, type FetcherOptions, type FetchResult } from './fetcher.js';

export { BrowserHttpClient, type BrowserClientOptions } from './browser-client.js';

export {
  DEFAULT_USER_AGENT,
  MAX_BODY_SIZE,
  browserHeaders,
  minimalHeaders,
  TLS_FINGERPRINT_PROFILES,
  type TlsFingerprintMode,
  type TlsFingerprintProfile,
} from './headers.js';

export { detectRuntime, hasFilesystem, type Runtime } from './runtime.js';

export {
  type Storage,
  type StorageKey,
  scopeFromUrl,
  normalizePathForFile,
  safeSourcePath,
} from './storage.js';

export { MemoryStorage, NullStorage } from './memory-storage.js';

export { CookieJar, parseCookieString, type Cookie } from './cookies.js';

export {
  parseProxyUrl,
  resolveProxy,
  shouldBypassProxy,
  hostnameOf,
  type EnvLookup,
} from './proxy.js';

export { Semaphore, AbortError, mapPool } from './semaphore.js';

export { readBodyWithLimit } from './body.js';