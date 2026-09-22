/**
 * Proxy resolution.
 *
 * An explicit proxy always
 * wins; otherwise environment variables are consulted in the usual order, with
 * `NO_PROXY` honoured. `ALL_PROXY` is a fallback because Go's
 * the standard proxy-from-environment lookup does not read it.
 */

/** Environment lookup, injectable so behaviour is testable without touching `process.env`. */
export type EnvLookup = (name: string) => string | undefined;

const proxyEnvKeys = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
] as const;

const noProxyKeys = ['NO_PROXY', 'no_proxy'] as const;

/** Read the first non-empty value among `names`. */
function firstEnv(env: EnvLookup, names: readonly string[]): string {
  for (const name of names) {
    const value = env(name);
    if (value !== undefined && value !== '') {
      return value;
    }
  }
  return '';
}

/**
 * Normalise a proxy string into a URL.
 *
 * A bare `host:port` is treated as an HTTP proxy, the behaviour of
 * prepending `http://` when no scheme is present.
 */
export function parseProxyUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return null;
  }
  const withScheme = trimmed.includes('://') ? trimmed : `http://${trimmed}`;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

/**
 * Whether `host` is excluded by a `NO_PROXY` value.
 *
 * Supports `*` (bypass everything), exact host matches, and a leading-dot
 * suffix match. `noProxy` is the raw comma-separated string; surrounding
 * whitespace on each entry is ignored.
 */
export function shouldBypassProxy(host: string, noProxy: string): boolean {
  if (noProxy === '*' || noProxy.trim() === '*') {
    return true;
  }
  for (const entry of noProxy.split(',')) {
    const pattern = entry.trim();
    if (pattern === '') {
      continue;
    }
    if (pattern === host) {
      return true;
    }
    if (pattern.startsWith('.')) {
      const bare = pattern.slice(1);
      if (host === bare || host.endsWith(pattern)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Choose the proxy for a request.
 *
 * `explicit` (the user-supplied proxy) takes precedence and is not subject to
 * `NO_PROXY`: an explicit flag is an instruction, not a default.
 * Otherwise environment variables apply, with `NO_PROXY` able to veto them.
 */
export function resolveProxy(
  explicit: string | undefined,
  targetUrl: string,
  env: EnvLookup,
): URL | null {
  if (explicit !== undefined && explicit !== '') {
    return parseProxyUrl(explicit);
  }

  const fromEnv = firstEnv(env, proxyEnvKeys);
  if (fromEnv === '') {
    return null;
  }

  const host = hostnameOf(targetUrl);
  if (host !== '') {
    const noProxy = firstEnv(env, noProxyKeys);
    if (noProxy !== '' && shouldBypassProxy(host, noProxy)) {
      return null;
    }
  }

  return parseProxyUrl(fromEnv);
}

/** Extract the hostname from a URL, or `''` when unparseable. */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** A `process.env`-backed lookup, or an empty one outside Node. */
export function processEnvLookup(): EnvLookup {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env;
  if (!env) {
    return () => undefined;
  }
  return (name: string) => env[name];
}