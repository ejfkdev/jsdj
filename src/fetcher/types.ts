/**
 * The HTTP transport contract.
 *
 * Everything in the extractor talks to the network through {@link HttpClient},
 * never through a concrete fetch implementation. That is what lets a caller:
 *
 * - inject their own request function (a proxy client, a browser-aware fetcher,
 *   a recorder/replayer in tests, or a TLS-fingerprinting stack they control);
 * - drop the built-in implementation entirely on platforms where it does not
 *   apply.
 *
 * Implementations must not throw for HTTP-level failures — a 404 or 500 is a
 * normal result and comes back as `{ status: 404 }`. Rejections are reserved for
 * transport failures that produced no response at all (DNS, connect, TLS,
 * timeout).
 */

/** Options for a single request. */
export interface HttpRequest {
  /** Absolute URL to request. */
  url: string;
  /** HTTP method. Defaults to `GET`. */
  method?: 'GET' | 'HEAD' | 'POST';
  /**
   * Headers to send. These are applied on top of any defaults the
   * implementation adds, so a value here wins.
   *
   * Values are strings; non-ASCII is permitted and must be passed through
   * verbatim (some sites validate the character set of User-Agent).
   */
  headers?: Record<string, string>;
  /** Request body, for `POST`. */
  body?: string | Uint8Array;
  /**
   * Proxy URL: `http://`, `https://`, `socks5://`. When omitted the
   * implementation may fall back to environment variables.
   */
  proxy?: string;
  /**
   * Requested TLS fingerprint profile, e.g. `"chrome"`, `"firefox"`,
   * `"random"`.
   *
   * This is advisory: an implementation that cannot forge TLS fingerprints must
   * ignore it silently rather than fail. The built-in Node client ignores it
   * unless the optional native sidecar is installed; browsers always ignore it.
   */
  tlsFingerprint?: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Follow redirects (default `true`). */
  followRedirects?: boolean;
  /**
   * Abort signal, forwarded from the scan so a cancelled scan stops issuing
   * requests.
   */
  signal?: AbortSignal;
}

/** The outcome of a request that produced a response. */
export interface HttpResponse {
  /** HTTP status code. */
  status: number;
  /** Response headers, keys lower-cased. */
  headers: Record<string, string>;
  /** Decoded response body. Empty for `HEAD`. */
  body: Uint8Array;
  /** Final URL after redirects; equals `request.url` when nothing redirected. */
  finalUrl: string;
  /** Whether the body was truncated at the configured size limit. */
  truncated?: boolean;
}

/** Transport-level request failure (no response received). */
export class HttpError extends Error {
  readonly url: string;
  override readonly cause?: unknown;

  constructor(message: string, url: string, cause?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.url = url;
    this.cause = cause;
  }
}

/**
 * A pluggable HTTP client.
 *
 * Implement this to control how bytes are fetched. The extractor only ever
 * needs these two methods.
 */
export interface HttpClient {
  /**
   * Perform a request and buffer the full response body.
   *
   * Rejects only on transport failure. Non-2xx responses resolve normally.
   */
  request(req: HttpRequest): Promise<HttpResponse>;

  /**
   * Perform a `HEAD` request (used to probe for source maps cheaply).
   *
   * Implementations may fall back to `GET` internally where `HEAD` is
   * unsupported, but should then discard the body.
   */
  head(req: HttpRequest): Promise<HttpResponse>;

  /**
   * Release any resources held by the client (connection pools, sidecar
   * processes). Optional; called at the end of a scan.
   */
  close?(): Promise<void>;
}

/**
 * Look up a header value, ignoring case on both sides.
 *
 * The fast path is a lower-cased key, which is the form the built-in clients
 * produce. The fallback scans for a case-insensitive match, because a hand-rolled
 * transport may return the server's original casing — `Content-Type` rather than
 * `content-type` — and returning `''` for a header that is present would silently
 * break content classification, which is what every plugin depends on.
 */
export function getHeader(
  headers: Record<string, string>,
  name: string,
): string {
  const lower = name.toLowerCase();

  const direct = headers[lower];
  if (direct !== undefined) {
    return direct;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }

  return '';
}