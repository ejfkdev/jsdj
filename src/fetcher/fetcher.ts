/**
 * The fetcher facade.
 *
 * The fetcher bundles transport, cookies, headers, decompression, concurrency
 * and caching into one type. Here that splits in two: an {@link HttpClient} the
 * caller can replace, wrapped by a thin {@link Fetcher} that owns the
 * request-shaping concerns the extractor depends on (default headers, cookie
 * injection, per-URL header overrides, retry/backoff policy).
 *
 * Keeping the split means a caller who supplies their own client still gets the
 * scanner's request conventions for free, and a caller who wants full control
 * over headers can bypass them via `extraHeaders`.
 */

import {
  DEFAULT_USER_AGENT,
  MAX_BODY_SIZE,
  browserHeaders,
  minimalHeaders,
  type TlsFingerprintMode,
} from './headers.js';
import { CookieJar } from './cookies.js';
import { parseCookieString } from './cookies.js';
import { detectRuntime } from './runtime.js';
import { BrowserHttpClient } from './browser-client.js';
import { NodeHttpClient } from './node-client.js';
import {
  HttpError,
  getHeader,
  type HttpClient,
  type HttpResponse,
} from './types.js';

/** A response as the extractor wants it: decoded body plus metadata. */
export interface FetchResult {
  /** Decoded response body. */
  content: Uint8Array;
  /** HTTP status code. */
  statusCode: number;
  /** Raw `Content-Type` header value. */
  contentType: string;
  /** All response headers, keys lower-cased. */
  headers: Record<string, string>;
  /**
   * Final URL after redirects, or `''` when it is identical to the request URL.
   * The empty-string convention exists so callers can treat it
   * as "no redirect to process".
   */
  finalUrl: string;
  /** Whether the body was cut off at the size cap. */
  truncated: boolean;
}

export interface FetcherOptions {
  /** Proxy URL applied to all requests. */
  proxy?: string;
  /** Default User-Agent. */
  userAgent?: string;
  /** TLS fingerprint profile; ignored where unsupported. */
  tlsFingerprint?: TlsFingerprintMode;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Maximum concurrent requests. */
  concurrency?: number;
  /** Response body cap in bytes. */
  maxBodySize?: number;
  /** Replace the built-in HTTP client entirely. */
  client?: HttpClient;
  /** Force the built-in client to impersonate a browser header-wise. */
  browserHeaders?: boolean;
  /** Disable the TLS sidecar even when installed. */
  disableTlsSidecar?: boolean;
  /** Keep cookies across requests. */
  cookieJar?: boolean;
}

/** Number of transport-failure retries before giving up on a URL. */
const MAX_TRANSPORT_RETRIES = 3;
/** Base backoff between retries, in milliseconds. */
const RETRY_BASE_DELAY_MS = 50;

/**
 * Request engine shared by the extractor.
 *
 * Wraps an {@link HttpClient} with the scanner's header conventions, cookie
 * handling, and a bounded retry policy for transient transport failures.
 */
export class Fetcher {
  private readonly client: HttpClient;
  private readonly ownsClient: boolean;
  private userAgent: string;
  private extraHeaders: Record<string, string> = {};
  private readonly maxBodySize: number;
  private readonly timeoutMs: number;
  private readonly proxy: string | undefined;
  private readonly tlsFingerprint: string | undefined;
  /**
   * Whether this layer must compose the request headers itself.
   *
   * True only for an injected client. The built-in clients own their own header
   * defaults — that is why `browserHeaders` is one of their constructor options —
   * so for them this layer passes only the caller's extras and lets the client
   * merge. An injected client has no such defaults, so without composing here it
   * would receive a bare `{ 'X-Scanner': 'example' }` and silently lose the whole
   * browser header ensemble, which anti-bot systems reject.
   */
  private readonly composeHeaders: boolean;
  private readonly browserHeaderSet: boolean;
  /**
   * Cookie store used when the client is injected.
   *
   * The built-in clients own a jar — `setCookies` is one of their methods — so for
   * them this stays null and the client keeps the cookies. An injected transport has
   * no such method, so without a jar on this side `cookie` would be silently
   * discarded and a Cloudflare-protected scan would come back empty for no visible
   * reason.
   */
  private jar: CookieJar | null = null;

  constructor(options: FetcherOptions = {}) {
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.maxBodySize = options.maxBodySize ?? MAX_BODY_SIZE;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.proxy = options.proxy;
    this.tlsFingerprint = normalizeFingerprint(options.tlsFingerprint);
    this.extraHeaders = {};

    if (options.client) {
      this.client = options.client;
      this.ownsClient = false;
      this.composeHeaders = true;
      // An injected transport is usually a custom HTTP stack, so present it with the
      // same browser header set the built-in clients would send. A caller can turn
      // it off with `browserHeaders: false`.
      this.browserHeaderSet = options.browserHeaders ?? true;
      this.jar = new CookieJar();
    } else {
      this.client = createBuiltinClient(options);
      this.ownsClient = true;
      this.composeHeaders = false;
      this.browserHeaderSet = false;
    }

    this.applyConcurrency(options.concurrency ?? 8);
  }

  /** The underlying client, for callers that need to inspect or extend it. */
  get httpClient(): HttpClient {
    return this.client;
  }

  /** Set the default User-Agent. An empty value is ignored. */
  setUserAgent(ua: string): void {
    if (ua !== '') {
      this.userAgent = ua;
    }
  }

  /**
   * Set headers applied to every request.
   *
   * Merged across calls, later values winning. These are applied after the
   * browser defaults, so they can override `User-Agent`, `Accept`, and the rest.
   */
  setExtraHeaders(headers: Record<string, string>): void {
    this.extraHeaders = { ...this.extraHeaders, ...headers };
  }

  /** Read the currently configured override headers. */
  getExtraHeaders(): Record<string, string> {
    return { ...this.extraHeaders };
  }

  /**
   * Inject cookies for `targetUrl` from a `name=value; other=value` string.
   *
   * Used for Cloudflare clearance cookies. Returns whether injection was
   * possible — a client with no cookie support (the browser one) reports
   * `false` rather than throwing.
   */
  setCookieString(targetUrl: string, cookieString: string): boolean {
    const cookies = parseCookieString(cookieString);

    // An injected client gets the cookies through this layer's jar, which is added
    // to each request as a `Cookie` header below.
    if (this.jar) {
      this.jar.setFromUrl(targetUrl, cookies);
      return true;
    }

    const client = this.client as HttpClient & {
      setCookies?: (
        url: string,
        cookies: Array<{ name: string; value: string }>,
      ) => void;
    };
    if (typeof client.setCookies !== 'function') {
      return false;
    }
    client.setCookies(targetUrl, cookies);
    return true;
  }

  /**
   * Whether a TLS-fingerprinting transport is active.
   *
   * Always `false` in the browser, and `false` on Node when the optional sidecar
   * is absent. Never throws.
   */
  async hasTlsFingerprint(): Promise<boolean> {
    const client = this.client as HttpClient & {
      hasTlsFingerprint?: () => Promise<boolean>;
    };
    if (typeof client.hasTlsFingerprint !== 'function') {
      return false;
    }
    try {
      return await client.hasTlsFingerprint();
    } catch {
      return false;
    }
  }

  /** Adjust the concurrency budget. */
  setConcurrency(n: number): void {
    this.applyConcurrency(n);
  }

  /**
   * Fetch a URL, requiring a 2xx response.
   *
   * Rejects on non-2xx. Callers use this where a
   * failure simply meant "this URL is not usable".
   */
  async fetch(url: string, signal?: AbortSignal): Promise<Uint8Array> {
    const result = await this.fetchWithStatus(url, signal);
    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new HttpError(
        `HTTP status: ${result.statusCode}`,
        url,
      );
    }
    return result.content;
  }

  /**
   * Fetch a URL and return the response whatever its status.
   *
   * Transport failures are retried with linear backoff, because a burst of
   * concurrent requests against a small static server produces transient
   * connect/EOF errors that would otherwise drop whole import sub-trees.
   */
  async fetchWithStatus(
    url: string,
    signal?: AbortSignal,
  ): Promise<FetchResult> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_TRANSPORT_RETRIES; attempt++) {
      if (signal?.aborted) {
        throw new HttpError('aborted', url);
      }
      try {
        return await this.performRequest(url, 'GET', undefined, signal);
      } catch (err) {
        lastError = err;
        // Only transport failures are retried; an aborted signal is final.
        if (isAbort(err)) {
          throw err;
        }
        if (attempt < MAX_TRANSPORT_RETRIES - 1) {
          await delay(RETRY_BASE_DELAY_MS * (attempt + 1), signal);
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new HttpError(`request failed: ${String(lastError)}`, url);
  }

  /**
   * Fetch a URL with additional one-off headers.
   *
   * Used for Next.js RSC probes, which need an `RSC: 1` header.
   */
  async fetchWithHeaders(
    url: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<FetchResult> {
    return this.performRequest(url, 'GET', headers, signal);
  }

  /**
   * Probe a URL with `HEAD`, used to test for a `.map` file cheaply.
   *
   * Some servers reject `HEAD` with 405 or 403; a caller seeing a non-2xx here
   * should treat it as "unknown" rather than "absent".
   */
  async fetchWithStatusHead(
    url: string,
    signal?: AbortSignal,
  ): Promise<FetchResult> {
    return this.performRequest(url, 'HEAD', undefined, signal);
  }

  /** Release resources. Only closes the client when this instance created it. */
  async close(): Promise<void> {
    if (this.ownsClient && this.client.close) {
      await this.client.close().catch(() => {});
    }
  }

  private async performRequest(
    url: string,
    method: 'GET' | 'HEAD',
    extra: Record<string, string> | undefined,
    signal: AbortSignal | undefined,
  ): Promise<FetchResult> {
    // An injected client gets the full header set composed here, because it has no
    // defaults of its own to merge over. Order matters: browser defaults first, then
    // the caller's persistent extras, then this request's one-off headers, so each
    // layer overrides the one before it.
    const headers: Record<string, string> = this.composeHeaders
      ? this.browserHeaderSet
        ? browserHeaders(this.userAgent)
        : minimalHeaders(this.userAgent)
      : {};

    Object.assign(headers, this.extraHeaders);
    if (extra) {
      Object.assign(headers, extra);
    }

    // Cookies from this layer's jar, for an injected client. An explicit `Cookie`
    // header from the caller wins, so a caller can always override the jar.
    if (this.jar) {
      const hasExplicit =
        headers['Cookie'] !== undefined || headers['cookie'] !== undefined;
      if (!hasExplicit) {
        const cookieHeader = this.jar.getCookieHeader(url);
        if (cookieHeader !== '') {
          headers['Cookie'] = cookieHeader;
        }
      }
    }

    const response: HttpResponse = await this.client.request({
      url,
      method,
      headers,
      proxy: this.proxy,
      tlsFingerprint: this.tlsFingerprint,
      timeoutMs: this.timeoutMs,
      signal,
    });

    return toFetchResult(response, url, this.maxBodySize);
  }

  private applyConcurrency(n: number): void {
    const client = this.client as HttpClient & { setConcurrency?: (n: number) => void };
    if (typeof client.setConcurrency === 'function') {
      client.setConcurrency(n);
    }
  }
}

/** Convert a transport response into the extractor's result shape. */
function toFetchResult(
  response: HttpResponse,
  requestedUrl: string,
  maxBodySize: number,
): FetchResult {
  // An unchanged final URL is reported as empty so callers can test
  // truthiness instead of comparing URLs.
  const finalUrl = response.finalUrl === requestedUrl ? '' : response.finalUrl;

  return {
    content:
      response.body.byteLength > maxBodySize
        ? response.body.subarray(0, maxBodySize)
        : response.body,
    statusCode: response.status,
    contentType: getHeader(response.headers, 'content-type'),
    headers: response.headers,
    finalUrl,
    truncated: response.truncated ?? false,
  };
}

/** Build the platform-appropriate built-in client. */
function createBuiltinClient(options: FetcherOptions): HttpClient {
  const runtime = detectRuntime();
  const common = {
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    concurrency: options.concurrency ?? 8,
    timeoutMs: options.timeoutMs ?? 30_000,
    maxBodySize: options.maxBodySize ?? MAX_BODY_SIZE,
  };

  if (runtime === 'browser') {
    return new BrowserHttpClient({
      ...common,
      browserHeaders: options.browserHeaders ?? false,
    });
  }

  return new NodeHttpClient({
    ...common,
    proxy: options.proxy,
    browserHeaders: options.browserHeaders ?? true,
    disableTlsSidecar: options.disableTlsSidecar,
    cookieJar: options.cookieJar,
    tlsFingerprint: normalizeFingerprint(options.tlsFingerprint),
  });
}

/** Map the public fingerprint mode onto the sidecar's profile string. */
function normalizeFingerprint(
  mode: TlsFingerprintMode | undefined,
): string | undefined {
  switch (mode) {
    case 'chrome':
      return 'chrome';
    case 'random':
      return 'random';
    case 'off':
    case undefined:
      return undefined;
    default:
      return undefined;
  }
}

function isAbort(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.message.includes('aborted'))
  );
}

/** Sleep, aborting early when the signal fires. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new HttpError('aborted', ''));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new HttpError('aborted', ''));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}