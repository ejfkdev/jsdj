/**
 * Scan options.
 *
 * The shape is arranged so a CLI flag maps to exactly one field, but
 * it is the *library* surface: it takes a client and a storage rather than a proxy
 * string and a cache directory, so a caller can substitute either.
 */

import type { HttpClient } from './fetcher/types.js';
import type { Storage } from './fetcher/storage.js';
import type { TlsFingerprintMode } from './fetcher/headers.js';
import type { Logger } from './extractor/logger.js';
import type { PluginRegistry } from './extractor/registry.js';
import type { ScanResult } from './extractor/types.js';

/** How to fetch bytes during a scan. */
export type FetchInjection =
  | {
      /**
       * Supply the transport outright. The scan uses it for every request, which
       * is the escape hatch for TLS-fingerprint stacks the caller controls, a
       * corporate proxy client, or a recorder in tests.
       */
      client: HttpClient;
    }
  | {
      /**
       * Supply only a fetch function, receiving the same request shape the
       * built-in clients take.
       *
       * A convenience wrapper over `client` for callers who want to plug in a
       * `fetch`-like function and nothing else. Both `GET` and `HEAD` arrive
       * here, so the function must honour `req.method`.
       */
      fetch: (req: {
        url: string;
        method?: 'GET' | 'HEAD' | 'POST';
        headers?: Record<string, string>;
      }) => Promise<{
        status: number;
        headers?: Record<string, string>;
        body: Uint8Array | string;
        finalUrl?: string;
      }>;
    };

export interface ScanOptions {
  /** Site to scan. Required. */
  url: string;

  // ===== Transport =====

  /**
   * Replace the HTTP transport. Omit to use the built-in client for the runtime.
   */
  transport?: FetchInjection;
  /** Proxy URL: `http://`, `https://`, `socks5://`. */
  proxy?: string;
  /** Custom User-Agent. Defaults to a Chrome string. */
  userAgent?: string;
  /** Extra request headers, applied over the browser defaults. */
  headers?: Record<string, string>;
  /** Cookies as a `name=value; other=value` string, for bypassing bot checks. */
  cookie?: string;
  /**
   * TLS fingerprint profile.
   *
   * - `'random'` picks a real-browser profile per connection (the default).
   * - `'chrome'` pins the Chrome profile.
   * - `'off'` disables fingerprinting.
   *
   * Ignored — never an error — when no TLS-capable transport is available, which
   * is always the case in a browser and on Node when the optional sidecar package
   * is not installed.
   */
  tlsFingerprint?: TlsFingerprintMode;
  /** Maximum concurrent requests. Default 8. */
  concurrency?: number;
  /** Per-request timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
  /** Response body cap in bytes. Default 100 MiB. */
  maxBodySize?: number;

  // ===== Storage =====

  /**
   * Supply the artifact store.
   *
   * - Omit on Node to get the default file cache under the system temp directory.
   * - Omit in a browser to get no caching at all; supply your own store (OPFS,
   *   IndexedDB, a remote bucket) if you want cache reuse there.
   */
  storage?: Storage;
  /** Cache root for the default file store. */
  cacheDir?: string;
  /**
   * Read from the cache. Default `true`.
   *
   * Setting this `false` while leaving writes enabled gives `--no-cache`: every
   * run goes to the network, but artifacts are still saved.
   */
  cache?: boolean;
  /** Write artifacts to the cache. Default `true`. */
  writeCache?: boolean;
  /**
   * Skip caching entirely: no reads, no writes. Shorthand for supplying a
   * no-op store.
   */
  noCache?: boolean;
  /** Also mirror artifacts into this directory (`-o/--output`). */
  outputDir?: string;

  // ===== Plugins =====

  /** Use a specific plugin set instead of the built-in one. */
  plugins?: PluginRegistry;
  /** Run only these plugins, by name. Throws on an unknown name. */
  onlyPlugins?: string[];
  /** Run every built-in plugin except these. */
  excludePlugins?: string[];

  // ===== Output =====

  /**
   * Cap on restored source files whose *content* is included in the result.
   *
   * Default 2000. Files beyond the cap are still written to storage and still
   * counted in `summary.sourceCount`; only the in-memory copy is skipped. Set to
   * `0` to omit content entirely and keep the result small.
   */
  maxInlineSources?: number;

  // ===== Diagnostics =====

  /** Emit debug output. */
  debug?: boolean;
  /** Where debug and warning output goes. Defaults to discarding. */
  logger?: Logger;
  /** Abort the scan. */
  signal?: AbortSignal;
}

/** The result of a scan. */
export type { ScanResult };