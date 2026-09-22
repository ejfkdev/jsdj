/**
 * The built-in Node HTTP client.
 *
 * Built on the global `fetch` (undici). Node's fetch does not let us supply a
 * custom connector, so proxying is done by having the optional TLS sidecar
 * listen locally and pointing fetch at it — see `tls-sidecar.ts`. When the
 * sidecar is absent, requests go direct and any requested TLS fingerprint is
 * silently ignored, which is the documented degradation.
 *
 * Everything here is Node-only. The browser build uses `browser-client.ts`.
 */

import {
  DEFAULT_USER_AGENT,
  MAX_BODY_SIZE,
  browserHeaders,
  minimalHeaders,
} from './headers.js';
import { CookieJar } from './cookies.js';
import { decompressBody } from './decompress.js';
import { readBodyWithLimit } from './body.js';
import {
  processEnvLookup,
  resolveProxy,
  type EnvLookup,
} from './proxy.js';
import { Semaphore, AbortError } from './semaphore.js';
import { loadTlsSidecar, type TlsSidecar } from './tls-sidecar.js';
import {
  HttpError,
  getHeader,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from './types.js';

export interface NodeClientOptions {
  /** Default User-Agent applied when a request does not set one. */
  userAgent?: string;
  /** Proxy applied to every request unless the request overrides it. */
  proxy?: string;
  /**
   * Send the full Chrome header ensemble. Defaults to `true`, as
   * the browser header set was tied to using the uTLS transport.
   */
  browserHeaders?: boolean;
  /** Maximum concurrent requests across the whole client. */
  concurrency?: number;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Response body cap in bytes. */
  maxBodySize?: number;
  /** Environment lookup, injectable for tests. */
  env?: EnvLookup;
  /**
   * Requested TLS fingerprint profile. Ignored when the sidecar is unavailable.
   */
  tlsFingerprint?: string;
  /**
   * Force the sidecar off even when installed. Used by the CLI's
   * `--no-random-tls`-adjacent plumbing and by tests.
   */
  disableTlsSidecar?: boolean;
  /** Whether to keep cookies across requests. Defaults to `true`. */
  cookieJar?: boolean;
}

/**
 * HTTP client backed by Node's global `fetch`.
 *
 * Non-2xx responses resolve normally; only transport failures reject. The
 * response body is always buffered and decompressed.
 */
export class NodeHttpClient implements HttpClient {
  private semaphore: Semaphore;
  private readonly jar: CookieJar | null;
  private readonly env: EnvLookup;
  private readonly userAgent: string;
  private readonly proxy: string | undefined;
  private readonly useBrowserHeaders: boolean;
  private readonly timeoutMs: number;
  private readonly maxBodySize: number;
  private readonly tlsFingerprint: string | undefined;
  private readonly disableTlsSidecar: boolean;

  private sidecar: TlsSidecar | null = null;
  private sidecarLoad: Promise<TlsSidecar | null> | null = null;
  private closed = false;

  constructor(options: NodeClientOptions = {}) {
    this.semaphore = new Semaphore(options.concurrency ?? 8);
    this.jar = options.cookieJar === false ? null : new CookieJar();
    this.env = options.env ?? processEnvLookup();
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.proxy = options.proxy;
    this.useBrowserHeaders = options.browserHeaders ?? true;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxBodySize = options.maxBodySize ?? MAX_BODY_SIZE;
    this.tlsFingerprint = options.tlsFingerprint;
    this.disableTlsSidecar = options.disableTlsSidecar ?? false;
  }

  /** Resize the concurrency budget. Used by `--concurrency`. */
  setConcurrency(n: number): void {
    const clamped = Math.min(Math.max(Math.trunc(n), 1), 256);
    // The limit is fixed at construction, so swap in a fresh semaphore. In-flight
    // requests keep the slot they already hold; only new acquisitions see the
    // new limit, which is the same guarantee Go's channel swap gave.
    this.semaphore = new Semaphore(clamped);
  }

  /** Inject cookies for a specific URL, e.g. a Cloudflare clearance cookie. */
  setCookies(
    url: string,
    cookies: Array<{ name: string; value: string }>,
  ): void {
    this.jar?.setFromUrl(url, cookies);
  }

  /**
   * Whether a TLS-fingerprinting transport is actually available.
   *
   * Callers use this for diagnostics; it never throws.
   */
  async hasTlsFingerprint(): Promise<boolean> {
    if (this.disableTlsSidecar) {
      return false;
    }
    const sidecar = await this.ensureSidecar();
    return sidecar !== null;
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    return this.execute(req, 'GET');
  }

  async head(req: HttpRequest): Promise<HttpResponse> {
    return this.execute(req, 'HEAD');
  }

  async close(): Promise<void> {
    this.closed = true;
    const sidecar = this.sidecar;
    this.sidecar = null;
    this.sidecarLoad = null;
    if (sidecar) {
      await sidecar.stop().catch(() => {});
    }
  }

  private async execute(
    req: HttpRequest,
    fallbackMethod: 'GET' | 'HEAD',
  ): Promise<HttpResponse> {
    if (this.closed) {
      throw new HttpError('client is closed', req.url);
    }

    const method = req.method ?? fallbackMethod;
    const timeoutMs = req.timeoutMs ?? this.timeoutMs;

    return this.semaphore.run(async () => {
      // A route through the sidecar is only possible for GET/HEAD; POST bodies
      // would need the sidecar to relay a request body, which it does not.
      const sidecar = await this.ensureSidecar(method === 'POST');

      const headers = this.buildHeaders(req);
      const target = sidecar
        ? sidecar.routeUrl(req.url, this.proxy, req.proxy, this.env, req.tlsFingerprint ?? this.tlsFingerprint)
        : req.url;

      const controller = new AbortController();
      const onAbort = () => controller.abort();
      if (req.signal) {
        if (req.signal.aborted) {
          throw new AbortError();
        }
        req.signal.addEventListener('abort', onAbort, { once: true });
      }
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(target, {
          method,
          headers,
          body:
            method === 'POST' && req.body !== undefined
              ? (req.body as BodyInit)
              : undefined,
          redirect: req.followRedirects === false ? 'manual' : 'follow',
          signal: controller.signal,
          // Node's fetch would otherwise add its own Accept-Encoding and
          // transparently decompress; we set the header ourselves as part of the
          // browser fingerprint and decompress explicitly.
          decompress: false,
        } as RequestInit & { decompress: boolean });

        const rawHeaders = collectHeaders(response);
        const { data, truncated } = await readBodyWithLimit(
          response.body,
          this.maxBodySize,
        );
        const body = await decompressBody(
          data,
          getHeader(rawHeaders, 'content-encoding'),
        );

        if (this.jar) {
          const setCookie = collectSetCookie(response);
          this.jar.setFromResponseHeaders(req.url, setCookie);
        }

        return {
          status: response.status,
          headers: rawHeaders,
          body,
          finalUrl: response.url || req.url,
          truncated,
        };
      } catch (err) {
        if (err instanceof AbortError) {
          throw err;
        }
        if (controller.signal.aborted && !req.signal?.aborted) {
          throw new HttpError(
            `request timed out after ${timeoutMs}ms`,
            req.url,
            err,
          );
        }
        throw new HttpError(
          `request failed: ${err instanceof Error ? err.message : String(err)}`,
          req.url,
          err,
        );
      } finally {
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
      }
    }, req.signal);
  }

  private buildHeaders(req: HttpRequest): Record<string, string> {
    const base = this.useBrowserHeaders
      ? browserHeaders(this.userAgent)
      : minimalHeaders(this.userAgent);

    // Caller headers are merged last so they win, including User-Agent.
    const merged: Record<string, string> = { ...base, ...(req.headers ?? {}) };

    if (this.jar) {
      const cookieHeader = this.jar.getCookieHeader(req.url);
      // An explicit Cookie header takes precedence over the jar.
      if (cookieHeader !== '' && merged['Cookie'] === undefined && merged['cookie'] === undefined) {
        merged['Cookie'] = cookieHeader;
      }
    }

    return merged;
  }

  /**
   * Load the sidecar once. Returns `null` when unavailable, which is the
   * expected state whenever the optional dependency is not installed.
   *
   * `skipForPost` avoids starting a sidecar that could not be used anyway.
   */
  private async ensureSidecar(skipForPost = false): Promise<TlsSidecar | null> {
    if (this.disableTlsSidecar || skipForPost) {
      return null;
    }
    if (this.sidecar) {
      return this.sidecar;
    }
    if (this.sidecarLoad === null) {
      this.sidecarLoad = loadTlsSidecar().catch(() => null);
    }
    const sidecar = await this.sidecarLoad;
    if (sidecar) {
      this.sidecar = sidecar;
    }
    return sidecar;
  }
}

/** Flatten `Headers` into a lower-cased record, joining repeated values. */
function collectHeaders(response: Response): Record<string, string> {
  const out: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    out[lower] = out[lower] === undefined ? value : `${out[lower]}, ${value}`;
  });
  return out;
}

/**
 * Collect `Set-Cookie` values.
 *
 * `Headers.forEach` folds repeated `Set-Cookie` headers into one
 * comma-joined string, which is ambiguous because cookie values may themselves
 * contain commas. Node exposes the unfiltered list via `getSetCookie`, so prefer
 * that and fall back only when it is missing.
 */
function collectSetCookie(response: Response): string[] {
  const withAccessor = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  if (typeof withAccessor.getSetCookie === 'function') {
    return withAccessor.getSetCookie();
  }
  const combined = response.headers.get('set-cookie');
  return combined === null ? [] : [combined];
}