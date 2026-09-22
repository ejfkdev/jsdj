/**
 * A minimal in-memory cookie store.
 *
 * The Go original used `net/http/cookiejar`, which implements the public-suffix rules.
 * Reproducing that exactly would mean shipping a public-suffix list, which is a
 * large dependency for a feature used here mainly to carry Cloudflare clearance
 * cookies. This store does domain and path matching without public-suffix
 * awareness — adequate for the injected-cookie and same-site-redirect cases the
 * scanner actually encounters.
 */

export interface Cookie {
  name: string;
  value: string;
  /** Domain the cookie applies to. Empty means host-only for `host`. */
  domain: string;
  /** Path prefix. Defaults to `/`. */
  path: string;
  /** Expiry as epoch ms; undefined means a session cookie. */
  expires?: number;
}

interface StoredCookie extends Cookie {
  /** Host that set it, used for host-only matching. */
  host: string;
}

const MAX_COOKIES = 3000;

/** Parse a `name=value; other=value2` cookie string. */
export function parseCookieString(input: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const part of input.split(';')) {
    const trimmed = part.trim();
    if (trimmed === '') {
      continue;
    }
    const eq = trimmed.indexOf('=');
    // A cookie must have a non-empty name before the `=`.
    if (eq > 0) {
      out.push({
        name: trimmed.slice(0, eq).trim(),
        value: trimmed.slice(eq + 1).trim(),
      });
    }
  }
  return out;
}

/** Whether `host` is `domain` or a subdomain of it. */
function domainMatches(host: string, domain: string): boolean {
  if (host === domain) {
    return true;
  }
  return host.endsWith('.' + domain);
}

/** Whether `path` is within the cookie's `cookiePath`. */
function pathMatches(path: string, cookiePath: string): boolean {
  if (cookiePath === '/' || path === cookiePath) {
    return true;
  }
  if (!path.startsWith(cookiePath)) {
    return false;
  }
  // `/foo` should not match `/foobar`.
  return cookiePath.endsWith('/') || path[cookiePath.length] === '/';
}

export class CookieJar {
  private cookies: StoredCookie[] = [];

  /**
   * Add cookies for `url`, replacing any existing cookie with the same
   * name/domain/path. A cookie without an explicit domain is host-only.
   */
  setFromUrl(
    url: string,
    cookies: Array<Partial<Cookie> & { name: string; value: string }>,
  ): void {
    const parsed = safeParseUrl(url);
    if (!parsed) {
      return;
    }
    const host = parsed.hostname;
    const now = Date.now();

    for (const cookie of cookies) {
      if (cookie.expires !== undefined && cookie.expires <= now) {
        continue;
      }
      const domain = (cookie.domain ?? '').replace(/^\./, '').toLowerCase() || host;
      const cookiePath = cookie.path ?? '/';

      this.cookies = this.cookies.filter(
        (c) =>
          !(
            c.name === cookie.name &&
            c.domain === domain &&
            c.path === cookiePath &&
            c.host === host
          ),
      );

      this.cookies.push({
        name: cookie.name,
        value: cookie.value,
        domain,
        host,
        path: cookiePath,
        expires: cookie.expires,
      });
    }

    if (this.cookies.length > MAX_COOKIES) {
      this.cookies.splice(0, this.cookies.length - MAX_COOKIES);
    }
  }

  /**
   * Ingest `Set-Cookie` headers from a response.
   *
   * Attribute handling covers what matters in practice: `Domain`, `Path`,
   * `Max-Age`, `Expires`. `HttpOnly`, `Secure` and `SameSite` are parsed but do
   * not restrict sending here, since the scanner is not a browser and its whole
   * purpose is to reproduce an authenticated fetch.
   */
  setFromResponseHeaders(url: string, setCookieHeaders: readonly string[]): void {
    if (setCookieHeaders.length === 0) {
      return;
    }
    const parsed = safeParseUrl(url);
    if (!parsed) {
      return;
    }

    const now = Date.now();
    const received: Array<Partial<Cookie> & { name: string; value: string }> = [];

    for (const header of setCookieHeaders) {
      const segments = header.split(';');
      const first = segments[0]?.trim() ?? '';
      const eq = first.indexOf('=');
      if (eq <= 0) {
        continue;
      }
      const cookie: Partial<Cookie> & { name: string; value: string } = {
        name: first.slice(0, eq).trim(),
        value: first.slice(eq + 1).trim(),
      };

      for (const segment of segments.slice(1)) {
        const attrEq = segment.indexOf('=');
        const attrName = (attrEq >= 0 ? segment.slice(0, attrEq) : segment)
          .trim()
          .toLowerCase();
        const attrValue = attrEq >= 0 ? segment.slice(attrEq + 1).trim() : '';

        if (attrName === 'domain' && attrValue !== '') {
          cookie.domain = attrValue.replace(/^\./, '').toLowerCase();
        } else if (attrName === 'path' && attrValue !== '') {
          cookie.path = attrValue;
        } else if (attrName === 'max-age') {
          const seconds = Number.parseInt(attrValue, 10);
          if (Number.isFinite(seconds)) {
            cookie.expires = seconds <= 0 ? 0 : now + seconds * 1000;
          }
        } else if (attrName === 'expires' && cookie.expires === undefined) {
          const when = Date.parse(attrValue);
          if (!Number.isNaN(when)) {
            cookie.expires = when;
          }
        }
      }

      received.push(cookie);
    }

    this.setFromUrl(url, received);
  }

  /** Build a `Cookie` header value for `url`, or `''` when nothing applies. */
  getCookieHeader(url: string): string {
    const parsed = safeParseUrl(url);
    if (!parsed) {
      return '';
    }
    const host = parsed.hostname;
    const path = parsed.pathname || '/';
    const now = Date.now();

    // Expired cookies are dropped on read rather than on a timer.
    this.cookies = this.cookies.filter(
      (c) => c.expires === undefined || c.expires > now,
    );

    const matching = this.cookies.filter((c) => {
      const hostOk =
        c.domain === host || (c.domain !== '' && domainMatches(host, c.domain));
      return hostOk && pathMatches(path, c.path);
    });

    // Longer paths are more specific and should come first.
    matching.sort((a, b) => b.path.length - a.path.length);

    return matching.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  /** All cookies currently held, for diagnostics. */
  snapshot(): Cookie[] {
    return this.cookies.map(({ host: _host, ...rest }) => rest);
  }

  clear(): void {
    this.cookies = [];
  }
}

function safeParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}