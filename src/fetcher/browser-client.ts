/**
 * The built-in client for browser (and other `fetch`-only) environments.
 *
 * Two platform limits are unavoidable here and are documented rather than
 * papered over:
 *
 * 1. **TLS fingerprinting is impossible.** The browser owns the TLS stack, so
 *    `tlsFingerprint` is accepted and ignored. This matches the specified
 *    behaviour ("browser JS environment cannot use TLS fingerprints").
 * 2. **CORS applies.** A cross-origin fetch only succeeds when the target
 *    permits it. Scans of arbitrary sites will mostly be blocked. Callers who
 *    need to scan from a browser should supply their own {@link HttpClient} —
 *    for example one that proxies through their own origin — which is exactly
 *    what the injectable client interface exists for.
 *
 * Decompression is left to the browser: it sets and handles `Accept-Encoding`
 * itself, and re-adding it manually would be a forbidden header.
 */

import { MAX_BODY_SIZE, minimalHeaders, DEFAULT_USER_AGENT } from './headers.js';
import { Semaphore, AbortError } from './semaphore.js';
import { readBodyWithLimit } from './body.js';
import {
  HttpError,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from './types.js';

export interface BrowserClientOptions {
  /** Default User-Agent. Browsers ignore this — they control the value. */
  userAgent?: string;
  /** Maximum concurrent requests. */
  concurrency?: number;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Response body cap in bytes. */
  maxBodySize?: number;
  /**
   * Send the browser header ensemble. Off by default in the browser, because
   * most of those headers are forbidden and setting them silently has no
   * effect.
   */
  browserHeaders?: boolean;
}

/** HTTP client for environments where only `fetch` is available. */
export class BrowserHttpClient implements HttpClient {
  private semaphore: Semaphore;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxBodySize: number;
  private readonly useBrowserHeaders: boolean;

  constructor(options: BrowserClientOptions = {}) {
    this.semaphore = new Semaphore(options.concurrency ?? 8);
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxBodySize = options.maxBodySize ?? MAX_BODY_SIZE;
    this.useBrowserHeaders = options.browserHeaders ?? false;
  }

  /** No-op: browsers do not expose TLS configuration. */
  setConcurrency(n: number): void {
    this.semaphore = new Semaphore(Math.min(Math.max(Math.trunc(n), 1), 256));
  }

  /** No-op: cookies are managed by the browser and not script-accessible. */
  setCookies(_url: string, _cookies: Array<{ name: string; value: string }>): void {
    void _url;
    void _cookies;
  }

  /** Always `false`: see the module note about TLS. */
  async hasTlsFingerprint(): Promise<boolean> {
    return false;
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    return this.execute(req, 'GET');
  }

  async head(req: HttpRequest): Promise<HttpResponse> {
    return this.execute(req, 'HEAD');
  }

  private async execute(
    req: HttpRequest,
    fallbackMethod: 'GET' | 'HEAD',
  ): Promise<HttpResponse> {
    const method = req.method ?? fallbackMethod;
    const timeoutMs = req.timeoutMs ?? this.timeoutMs;

    return this.semaphore.run(async () => {
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
        const response = await fetch(req.url, {
          method,
          headers: this.buildHeaders(),
          body:
            method === 'POST' && req.body !== undefined
              ? (req.body as BodyInit)
              : undefined,
          redirect: req.followRedirects === false ? 'manual' : 'follow',
          credentials: 'omit',
          signal: controller.signal,
        });

        const headers = collectHeaders(response);
        const { data, truncated } = await readBodyWithLimit(
          response.body,
          this.maxBodySize,
        );

        return {
          status: response.status,
          headers,
          body: data,
          finalUrl: response.url || req.url,
          truncated,
        };
      } catch (err) {
        if (controller.signal.aborted && !req.signal?.aborted) {
          throw new HttpError(`request timed out after ${timeoutMs}ms`, req.url, err);
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

  private buildHeaders(): Record<string, string> {
    // Only the minimal set: everything else is a forbidden header name in the
    // browser and would be dropped or throw.
    const headers = this.useBrowserHeaders
      ? minimalHeaders(this.userAgent)
      : {};
    // Accept-Encoding is forbidden too; the browser picks it.
    delete headers['Accept-Encoding'];
    return headers;
  }
}

function collectHeaders(response: Response): Record<string, string> {
  const out: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    out[lower] = out[lower] === undefined ? value : `${out[lower]}, ${value}`;
  });
  return out;
}
