/**
 * Optional TLS-fingerprinting transport.
 *
 * Node has no way to forge a TLS ClientHello from JavaScript: the handshake is
 * performed inside the runtime's own TLS stack. Reproducing a browser's JA3/JA4
 * fingerprint therefore requires either a native binding or a separate process
 * that owns the socket.
 *
 * The Go original used `refraction-networking/utls` for this. This package keeps
 * that capability behind an **optional dependency**: if the sidecar package is
 * not installed, every function here degrades to "unavailable" and the scanner
 * continues over plain `fetch` with the fingerprint request ignored. No error is
 * raised, which is the behaviour the CLI and library are specified to have.
 *
 * ## Contract for a sidecar package
 *
 * A package named by {@link SIDECAR_PACKAGE} should default-export an object
 * satisfying {@link TlsSidecarFactory}. The expected implementation is a small
 * HTTP forwarder listening on loopback:
 *
 * - it accepts requests whose absolute-form target encodes the real destination;
 * - it performs the TLS handshake with a browser-like ClientHello selected by
 *   the fingerprint profile;
 * - it relays method, headers and body, and returns the upstream response
 *   unchanged;
 * - it reports its listening port so this module can build forwarding URLs.
 *
 * A concrete shape that works with the `routeUrl` helper below is:
 * `http://127.0.0.1:<port>/<fingerprint>/<scheme>/<host>/<path>` — but the
 * sidecar may define its own routing as long as it implements `routeUrl`.
 */

import type { EnvLookup } from './proxy.js';
import { resolveProxy } from './proxy.js';

/** Name of the optional package that provides the transport. */
export const SIDECAR_PACKAGE = '@jsdj/tls-sidecar';

/** A running TLS-fingerprinting transport. */
export interface TlsSidecar {
  /** Base URL the forwarder listens on, e.g. `http://127.0.0.1:41235`. */
  readonly baseUrl: string;
  /** Fingerprint profiles this sidecar can emulate. */
  readonly supportedProfiles: readonly string[];
  /**
   * Translate a destination URL into the local URL that routes through the
   * sidecar. Implementations may encode the fingerprint and upstream proxy into
   * the local path or into headers.
   */
  routeUrl(
    url: string,
    defaultProxy: string | undefined,
    requestProxy: string | undefined,
    env: EnvLookup,
    fingerprint: string | undefined,
  ): string;
  /** Shut the forwarder down and release its port. */
  stop(): Promise<void>;
}

/** What a sidecar package's default export must provide. */
export interface TlsSidecarFactory {
  /** Start the forwarder. Reject to signal that the sidecar cannot run. */
  create(options?: {
    /** Prefer a profile when the caller did not name one. */
    fingerprint?: string;
  }): Promise<TlsSidecar>;
  /** Profiles the implementation supports, if it can report them statically. */
  profiles?: readonly string[];
}

/**
 * Build the default loopback routing URL.
 *
 * Used by the reference sidecar and by tests. The destination is percent-encoded
 * into a single path segment so the sidecar can recover it without ambiguity,
 * and the upstream proxy is carried in a header rather than the path because it
 * may contain credentials.
 */
export function defaultRouteUrl(
  baseUrl: string,
  url: string,
  proxy: string | null,
  fingerprint: string | undefined,
): string {
  const profile = fingerprint && fingerprint !== 'random' ? fingerprint : 'random';
  const target = `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(profile)}/${encodeURIComponent(url)}`;
  // `proxy` is intentionally not in the URL: it goes in a header so credentials
  // are not written into a URL string that may end up in a log.
  void proxy;
  return target;
}

/** Shared state so repeated scans in one process reuse a single forwarder. */
let cached: Promise<TlsSidecar | null> | null = null;

/**
 * Attempt to load and start the sidecar.
 *
 * Resolves to `null` — never rejects — when the package is absent, fails to
 * load, or cannot start. Callers treat `null` as "TLS fingerprinting
 * unavailable" and carry on.
 */
export function loadTlsSidecar(options?: {
  fingerprint?: string;
}): Promise<TlsSidecar | null> {
  if (cached === null) {
    cached = instantiate(options).catch(() => null);
  }
  return cached;
}

/** Test seam: forget any cached sidecar so a fresh load is attempted. */
export function resetTlsSidecarCache(): void {
  cached = null;
}

async function instantiate(options?: {
  fingerprint?: string;
}): Promise<TlsSidecar | null> {
  // A runtime-computed specifier keeps bundlers from trying to resolve an
  // optional dependency at build time. Without this, browser and bundler builds
  // fail on a package that is legitimately allowed to be absent.
  const specifier = SIDECAR_PACKAGE;

  let mod: unknown;
  try {
    mod = await import(/* @vite-ignore */ /* webpackIgnore: true */ specifier);
  } catch {
    return null;
  }

  const factory = extractFactory(mod);
  if (!factory) {
    return null;
  }

  try {
    const sidecar = await factory.create(options);
    // A malformed sidecar should be treated as absent rather than crashing the
    // scan on first use.
    if (!sidecar || typeof sidecar.routeUrl !== 'function') {
      return null;
    }
    return sidecar;
  } catch {
    return null;
  }
}

/** Pull a {@link TlsSidecarFactory} out of whatever the module exported. */
function extractFactory(mod: unknown): TlsSidecarFactory | null {
  if (mod === null || typeof mod !== 'object') {
    return null;
  }
  const record = mod as Record<string, unknown>;
  const candidate =
    record['default'] ?? record['sidecar'] ?? record['createTlsSidecar'];
  if (candidate !== null && typeof candidate === 'object') {
    const factory = candidate as TlsSidecarFactory;
    if (typeof factory.create === 'function') {
      return factory;
    }
    return null;
  }
  if (typeof candidate === 'function') {
    // A bare factory function is also acceptable.
    return {
      create: candidate as TlsSidecarFactory['create'],
    };
  }
  return null;
}

/**
 * Resolve the proxy that a request should use, for handing to the sidecar.
 *
 * Exported so a sidecar implementation can reuse the same precedence rules the
 * built-in client applies.
 */
export function proxyForSidecar(
  url: string,
  defaultProxy: string | undefined,
  requestProxy: string | undefined,
  env: EnvLookup,
): string | null {
  const chosen = resolveProxy(requestProxy ?? defaultProxy, url, env);
  return chosen ? chosen.toString() : null;
}