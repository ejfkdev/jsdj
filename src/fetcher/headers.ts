/**
 * Default request headers.
 *
 * The header set deliberately mimics
 * a real Chrome navigation request: several anti-bot systems reject requests
 * whose header ensemble is internally inconsistent (for example a Chrome
 * User-Agent with no `Sec-Fetch-*` headers).
 */

/**
 * Default User-Agent. Matches a Chrome on Windows and avoids advertising the
 * tool, which some sites block on sight.
 */
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

/** `Sec-CH-UA` value consistent with {@link DEFAULT_USER_AGENT}. */
const CHROME_SEC_CH_UA =
  '"Chromium";v="148", "Google Chrome";v="148", "Not-A.Brand";v="99"';

/**
 * The full browser header ensemble, as a function of the chosen User-Agent.
 *
 * Callers apply their own headers *after* these, so explicit values win.
 */
export function browserHeaders(userAgent: string): Record<string, string> {
  return {
    'User-Agent': userAgent,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'Sec-Ch-Ua': CHROME_SEC_CH_UA,
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  };
}

/**
 * The minimal header set used when not impersonating a browser: just enough to
 * get a valid response, no browser fingerprint.
 */
export function minimalHeaders(userAgent: string): Record<string, string> {
  return {
    'User-Agent': userAgent,
    'Accept-Encoding': 'gzip, deflate, br',
  };
}

/**
 * Default response body cap: 100 MiB.
 *
 * Bundles occasionally exceed this; when they do the body is flagged as
 * truncated rather than the request failing, so discovery still proceeds on
 * the portion received.
 */
export const MAX_BODY_SIZE = 100 * 1024 * 1024;

/** TLS fingerprint selection. */
export type TlsFingerprintMode =
  /** Pick a random real-browser profile per connection. */
  | 'random'
  /** Use a fixed Chrome profile. */
  | 'chrome'
  /** Do not attempt TLS fingerprinting at all. */
  | 'off';

/**
 * Profiles a TLS-capable transport may honour. Passed through to the transport
 * as a hint; unsupported values are ignored rather than rejected.
 */
export const TLS_FINGERPRINT_PROFILES = [
  'chrome',
  'firefox',
  'safari',
  'edge',
  'ios',
] as const;

export type TlsFingerprintProfile = (typeof TLS_FINGERPRINT_PROFILES)[number];