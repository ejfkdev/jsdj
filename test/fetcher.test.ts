/**
 * Tests for the fetcher layer's own logic.
 *
 * Network I/O is not exercised here — the point of these cases is the
 * behaviour that must hold regardless of transport: concurrency bounding,
 * proxy precedence, cookie matching, storage semantics, and the guarantee that
 * a missing TLS sidecar degrades quietly.
 */

import { describe, expect, test } from 'bun:test';

import {
  AbortError,
  BrowserHttpClient,
  CookieJar,
  Fetcher,
  MemoryStorage,
  NullStorage,
  DEFAULT_USER_AGENT,
  getHeader,
  Semaphore,
  mapPool,
  normalizePathForFile,
  parseCookieString,
  parseProxyUrl,
  processEnvLookup,
  resetTlsSidecarCache,
  resolveProxy,
  safeSourcePath,
  scopeFromUrl,
  shouldBypassProxy,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
  type StorageKey,
} from '../src/fetcher/index.js';
import { loadTlsSidecar } from '../src/fetcher/tls-sidecar.js';

// ===== Semaphore =====

describe('Semaphore', () => {
  test('bounds concurrency and releases slots', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;

    const job = () =>
      sem.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      });

    await Promise.all(Array.from({ length: 8 }, job));
    expect(peak).toBeLessThanOrEqual(2);
    expect(sem.free).toBe(2);
    expect(sem.pending).toBe(0);
  });

  test('handing a slot to a waiter does not inflate the count', async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    // Two waiters queue behind the held slot.
    const second = sem.acquire();
    const third = sem.acquire();
    expect(sem.pending).toBe(2);

    release();
    const releaseSecond = await second;
    expect(sem.free).toBe(0);
    releaseSecond();
    const releaseThird = await third;
    await releaseThird();

    // All three slots accounted for exactly once.
    expect(sem.free).toBe(1);
    expect(sem.pending).toBe(0);
  });

  test('a double release is ignored', async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    release();
    release();
    expect(sem.free).toBe(1);
  });

  test('rejects immediately when the signal is already aborted', async () => {
    const sem = new Semaphore(1);
    const controller = new AbortController();
    controller.abort();
    await expect(sem.acquire(controller.signal)).rejects.toBeInstanceOf(
      AbortError,
    );
  });

  test('a queued acquire rejects when aborted', async () => {
    const sem = new Semaphore(1);
    const held = await sem.acquire();
    const controller = new AbortController();
    const queued = sem.acquire(controller.signal);
    controller.abort();
    await expect(queued).rejects.toBeInstanceOf(AbortError);
    held();
    expect(sem.free).toBe(1);
  });

  test('rejects a non-positive limit', () => {
    expect(() => new Semaphore(0)).toThrow(RangeError);
    expect(() => new Semaphore(-1)).toThrow(RangeError);
  });
});

// ===== mapPool =====

describe('mapPool', () => {
  test('preserves input order', async () => {
    const out = await mapPool([1, 2, 3, 4, 5], 2, async (n) => {
      // Deliberately invert completion order relative to input order.
      await new Promise((r) => setTimeout(r, (6 - n) * 2));
      return n * 10;
    });
    expect(out.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual([
      10, 20, 30, 40, 50,
    ]);
  });

  test('a failure does not abandon siblings', async () => {
    const out = await mapPool([1, 2, 3], 3, async (n) => {
      if (n === 2) {
        throw new Error('boom');
      }
      return n;
    });
    expect(out[0]).toEqual({ status: 'fulfilled', value: 1 });
    expect(out[1]!.status).toBe('rejected');
    expect(out[2]).toEqual({ status: 'fulfilled', value: 3 });
  });

  test('respects the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    await mapPool(Array.from({ length: 10 }), 3, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 3));
      active--;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  test('empty input resolves to an empty array', async () => {
    expect(await mapPool([], 4, async () => 1)).toEqual([]);
  });
});

// ===== proxy =====

describe('proxy resolution', () => {
  const noEnv = () => undefined;

  test('parseProxyUrl adds a default scheme', () => {
    expect(parseProxyUrl('127.0.0.1:8080')?.toString()).toBe(
      'http://127.0.0.1:8080/',
    );
    expect(parseProxyUrl('socks5://127.0.0.1:1080')?.protocol).toBe('socks5:');
    expect(parseProxyUrl('')).toBeNull();
  });

  test('an explicit proxy wins over the environment', () => {
    const env = (name: string) =>
      name === 'HTTPS_PROXY' ? 'http://env-proxy:3128' : undefined;
    const resolved = resolveProxy('http://explicit:8080', 'https://a.test', env);
    expect(resolved?.host).toBe('explicit:8080');
  });

  test('an explicit proxy is not subject to NO_PROXY', () => {
    // An explicit flag is an instruction, so NO_PROXY cannot veto it.
    const env = (name: string) => {
      if (name === 'NO_PROXY' || name === 'no_proxy') {
        return 'a.test';
      }
      return undefined;
    };
    const resolved = resolveProxy('http://explicit:8080', 'https://a.test', env);
    expect(resolved?.host).toBe('explicit:8080');
  });

  test('falls back to the environment when no explicit proxy is set', () => {
    const env = (name: string) =>
      name === 'HTTPS_PROXY' ? 'proxy.local:3128' : undefined;
    expect(resolveProxy(undefined, 'https://a.test', env)?.host).toBe(
      'proxy.local:3128',
    );
  });

  test('NO_PROXY vetoes an environment proxy', () => {
    const env = (name: string) => {
      if (name === 'HTTPS_PROXY') {
        return 'proxy.local:3128';
      }
      if (name === 'NO_PROXY') {
        return 'a.test';
      }
      return undefined;
    };
    expect(resolveProxy(undefined, 'https://a.test', env)).toBeNull();
  });

  test('shouldBypassProxy handles exact, suffix and wildcard forms', () => {
    expect(shouldBypassProxy('a.test', 'a.test')).toBe(true);
    expect(shouldBypassProxy('sub.a.test', '.a.test')).toBe(true);
    expect(shouldBypassProxy('a.test', '.a.test')).toBe(true);
    expect(shouldBypassProxy('nota.test', '.a.test')).toBe(false);
    expect(shouldBypassProxy('anything', '*')).toBe(true);
    expect(shouldBypassProxy('b.test', ' a.test , c.test ')).toBe(false);
    expect(shouldBypassProxy('c.test', ' a.test , c.test ')).toBe(true);
  });

  test('processEnvLookup tolerates an absent process', () => {
    // Present in Node; the point is that it does not throw.
    expect(typeof processEnvLookup()('PATH')).toBe('string');
  });
});

// ===== cookies =====

describe('CookieJar', () => {
  test('parseCookieString ignores malformed pairs', () => {
    expect(parseCookieString('a=1; b=2; ; =novalue; c=')).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: '2' },
      { name: 'c', value: '' },
    ]);
  });

  test('sends matching cookies for the request URL', () => {
    const jar = new CookieJar();
    jar.setFromUrl('https://a.test/x', [
      { name: 'cf_clearance', value: 'tok' },
      { name: 'other', value: 'v' },
    ]);
    expect(jar.getCookieHeader('https://a.test/y')).toBe(
      'cf_clearance=tok; other=v',
    );
  });

  test('does not send cookies to an unrelated host', () => {
    const jar = new CookieJar();
    jar.setFromUrl('https://a.test/', [{ name: 'k', value: 'v' }]);
    expect(jar.getCookieHeader('https://b.test/')).toBe('');
  });

  test('ingests Set-Cookie with attributes and honours expiry', () => {
    const jar = new CookieJar();
    jar.setFromResponseHeaders('https://a.test/', [
      'sid=abc; Path=/; Max-Age=3600; HttpOnly; Secure',
    ]);
    expect(jar.getCookieHeader('https://a.test/')).toBe('sid=abc');

    jar.setFromResponseHeaders('https://a.test/', ['gone=x; Max-Age=0']);
    expect(jar.getCookieHeader('https://a.test/')).not.toContain('gone');
  });

  test('respects path scoping', () => {
    const jar = new CookieJar();
    jar.setFromUrl('https://a.test/app/page', [
      { name: 'scoped', value: '1', path: '/app' },
    ]);
    expect(jar.getCookieHeader('https://a.test/app/other')).toBe('scoped=1');
    expect(jar.getCookieHeader('https://a.test/elsewhere')).toBe('');
  });

  test('later values replace earlier ones for the same triple', () => {
    const jar = new CookieJar();
    jar.setFromUrl('https://a.test/', [{ name: 'k', value: 'old' }]);
    jar.setFromUrl('https://a.test/', [{ name: 'k', value: 'new' }]);
    expect(jar.getCookieHeader('https://a.test/')).toBe('k=new');
  });
});

// ===== storage =====

describe('storage', () => {
  test('NullStorage never reads or writes', async () => {
    const store = new NullStorage();
    const key: StorageKey = { scope: 's', subdir: 'js', path: 'a.js' };
    await store.write(key, new TextEncoder().encode('x'));
    expect(await store.read(key)).toBeNull();
    expect(await store.exists(key)).toBe(false);
    expect(store.readable).toBe(false);
  });

  test('MemoryStorage round-trips and treats empty as a miss', async () => {
    const store = new MemoryStorage();
    const key: StorageKey = { scope: 's', subdir: 'js', path: 'a.js' };
    await store.write(key, new TextEncoder().encode('hello'));
    expect(new TextDecoder().decode((await store.read(key))!)).toBe('hello');

    await store.write(key, new Uint8Array(0));
    // A zero-byte entry is a miss.
    expect(await store.read(key)).toBeNull();
    expect(await store.exists(key)).toBe(false);
  });

  test('MemoryStorage honours a read-only configuration', async () => {
    const store = new MemoryStorage({ readable: false, writable: true });
    const key: StorageKey = { scope: 's', subdir: 'js', path: 'a.js' };
    await store.write(key, new TextEncoder().encode('x'));
    expect(await store.read(key)).toBeNull();
  });

  test('MemoryStorage lists restored sources only', async () => {
    const store = new MemoryStorage();
    await store.write(
      { scope: 's', subdir: 'sources', path: 'src/a.js' },
      new TextEncoder().encode('a'),
    );
    await store.write(
      { scope: 's', subdir: 'sources', path: 'src/nested/b.js' },
      new TextEncoder().encode('b'),
    );
    await store.write(
      { scope: 's', subdir: 'js', path: 'c.js' },
      new TextEncoder().encode('c'),
    );
    expect(await store.listSources('s')).toEqual(['src/a.js', 'src/nested/b.js']);
  });
});

describe('storage path helpers', () => {
  test('scopeFromUrl flattens scheme, port and path', () => {
    expect(scopeFromUrl('https://test.com:8080/aa')).toBe(
      'https_test.com_8080_aa',
    );
    expect(scopeFromUrl('http://example.com/')).toBe('http_example.com_');
  });

  test('normalizePathForFile flattens separators and neutralises traversal', () => {
    expect(normalizePathForFile('/aa/bb/static/js/app.js')).toBe(
      'aa_bb_static_js_app.js',
    );
    // `../../` collapses to four underscores: `..` -> `_` then `/` -> `_`, the
    // same character-for-character result the Go implementation produced.
    expect(normalizePathForFile('../../etc/passwd')).toBe('____etc_passwd');
    // Whatever the input, no `..` survives to be interpreted as traversal.
    expect(normalizePathForFile('../../etc/passwd')).not.toContain('..');
  });

  test('safeSourcePath keeps structure but refuses traversal', () => {
    expect(safeSourcePath('src/nested/a.js')).toBe('src/nested/a.js');
    expect(safeSourcePath('./src/a.js')).toBe('src/a.js');
    // A `..` segment rejects the whole path rather than quietly rewriting it.
    expect(safeSourcePath('src/../../etc/passwd')).toBeNull();
    expect(safeSourcePath('')).toBeNull();
    expect(safeSourcePath('.')).toBeNull();
  });
});

// ===== header lookup =====

describe('getHeader', () => {
  test('finds a lower-cased key directly', () => {
    expect(getHeader({ 'content-type': 'text/html' }, 'content-type')).toBe('text/html');
  });

  test('finds a header the server returned in mixed case', () => {
    // A hand-rolled transport may pass the server's original casing through. A
    // lookup that missed it would return '' and break content classification, which
    // every plugin depends on.
    expect(getHeader({ 'Content-Type': 'text/html' }, 'content-type')).toBe('text/html');
    expect(getHeader({ 'CONTENT-TYPE': 'text/html' }, 'content-type')).toBe('text/html');
    expect(getHeader({ 'Content-Type': 'text/html' }, 'Content-Type')).toBe('text/html');
  });

  test('returns an empty string for an absent header', () => {
    expect(getHeader({ 'content-type': 'text/html' }, 'x-missing')).toBe('');
    expect(getHeader({}, 'content-type')).toBe('');
  });

  test('prefers an exact lower-cased match when both casings are present', () => {
    expect(
      getHeader({ 'content-type': 'first', 'Content-Type': 'second' }, 'content-type'),
    ).toBe('first');
  });
});

// ===== TLS sidecar degradation =====

describe('TLS sidecar', () => {
  test('loads to null when the optional package is absent, without throwing', async () => {
    resetTlsSidecarCache();
    // The optional dependency is not installed in this repository, which is
    // exactly the state in which TLS features must silently do nothing.
    expect(await loadTlsSidecar()).toBeNull();
  });

  test('BrowserHttpClient always reports no TLS capability', async () => {
    const client = new BrowserHttpClient();
    expect(await client.hasTlsFingerprint()).toBe(false);
  });

  test('Fetcher reports no TLS capability rather than throwing', async () => {
    const fetcher = new Fetcher({
      client: new BrowserHttpClient(),
      tlsFingerprint: 'chrome',
    });
    expect(await fetcher.hasTlsFingerprint()).toBe(false);
  });

  test('a browser client swallows injected cookies instead of throwing', async () => {
    const fetcher = new Fetcher({ client: new BrowserHttpClient() });
    // The browser client implements `setCookies` as a no-op, so injection
    // "succeeds" without having any effect. What matters is that it does not
    // throw, and that the client reports no cookie persistence of its own.
    expect(() => fetcher.setCookieString('https://a.test/', 'k=v')).not.toThrow();
    expect(fetcher.setCookieString('https://a.test/', 'k=v')).toBe(true);
    // And the durability check: a fresh client has nothing to send, because the
    // browser owns the cookie store and scripts cannot write to it.
    const fresh = new Fetcher({ client: new BrowserHttpClient() });
    expect(fresh.getExtraHeaders()).toEqual({});
  });
});

// ===== Fetcher facade =====

describe('Fetcher', () => {
  /** A client that records requests and returns scripted responses. */
  function recordingClient(
    handler: (req: HttpRequest) => Partial<HttpResponse>,
  ): { client: HttpClient; seen: HttpRequest[] } {
    const seen: HttpRequest[] = [];
    const client: HttpClient = {
      async request(req: HttpRequest): Promise<HttpResponse> {
        seen.push(req);
        return {
          status: 200,
          headers: {},
          body: new Uint8Array(0),
          finalUrl: req.url,
          ...handler(req),
        };
      },
      async head(req: HttpRequest): Promise<HttpResponse> {
        seen.push({ ...req, method: 'HEAD' });
        return {
          status: 200,
          headers: {},
          body: new Uint8Array(0),
          finalUrl: req.url,
          ...handler(req),
        };
      },
    };
    return { client, seen };
  }

  test('extra headers are merged, later values winning', async () => {
    const { client, seen } = recordingClient(() => ({}));
    const fetcher = new Fetcher({ client });
    fetcher.setExtraHeaders({ 'X-One': 'a', 'X-Two': 'b' });
    fetcher.setExtraHeaders({ 'X-Two': 'c' });

    await fetcher.fetch('https://a.test/');
    const headers = seen[0]!.headers!;
    expect(headers['X-One']).toBe('a');
    expect(headers['X-Two']).toBe('c');
  });

  test('an injected client receives the browser header defaults', async () => {
    // The built-in clients own their header defaults, so `Fetcher` passes them only
    // the caller's extras. An injected client has no defaults of its own, so
    // `Fetcher` must compose the full set — otherwise a custom transport silently
    // sends a bare request and anti-bot systems reject it.
    const { client, seen } = recordingClient(() => ({}));
    const fetcher = new Fetcher({ client });
    await fetcher.fetch('https://a.test/');

    const headers = seen[0]!.headers!;
    expect(headers['User-Agent']).toBe(DEFAULT_USER_AGENT);
    expect(headers['Accept']).toContain('text/html');
    expect(headers['Accept-Encoding']).toBe('gzip, deflate, br');
    // The `Sec-Fetch-*` group is what makes the ensemble look like a real
    // navigation rather than a scripted request.
    expect(headers['Sec-Fetch-Mode']).toBe('navigate');
    expect(headers['Sec-Fetch-Dest']).toBe('document');
    expect(headers['Upgrade-Insecure-Requests']).toBe('1');
  });

  test('a caller header overrides the injected default', async () => {
    const { client, seen } = recordingClient(() => ({}));
    const fetcher = new Fetcher({ client });
    fetcher.setExtraHeaders({ 'User-Agent': 'custom-agent', Accept: 'application/json' });
    await fetcher.fetch('https://a.test/');

    const headers = seen[0]!.headers!;
    expect(headers['User-Agent']).toBe('custom-agent');
    expect(headers['Accept']).toBe('application/json');
    // The non-overridden defaults survive.
    expect(headers['Sec-Fetch-Mode']).toBe('navigate');
  });

  test('browserHeaders: false gives an injected client the minimal set', async () => {
    const { client, seen } = recordingClient(() => ({}));
    const fetcher = new Fetcher({ client, browserHeaders: false });
    await fetcher.fetch('https://a.test/');

    const headers = seen[0]!.headers!;
    expect(headers['User-Agent']).toBe(DEFAULT_USER_AGENT);
    expect(headers['Accept-Encoding']).toBe('gzip, deflate, br');
    // No browser fingerprinting headers in the minimal set.
    expect(headers['Sec-Fetch-Mode']).toBeUndefined();
    expect(headers['Accept']).toBeUndefined();
  });

  test('an injected client receives injected cookies as a Cookie header', async () => {
    // The cookie jar lives inside the built-in clients, so for an injected transport
    // this layer has to add the header itself. Without that, `cookie` was silently
    // discarded and a bot-protected scan came back empty for no visible reason.
    const { client, seen } = recordingClient(() => ({}));
    const fetcher = new Fetcher({ client });
    expect(fetcher.setCookieString('https://a.test/', 'cf_clearance=tok; sid=1')).toBe(true);

    await fetcher.fetch('https://a.test/app');
    expect(seen[0]!.headers!['Cookie']).toBe('cf_clearance=tok; sid=1');
  });

  test('an explicit Cookie header wins over the jar', async () => {
    const { client, seen } = recordingClient(() => ({}));
    const fetcher = new Fetcher({ client });
    fetcher.setCookieString('https://a.test/', 'from=jar');
    fetcher.setExtraHeaders({ Cookie: 'from=header' });

    await fetcher.fetch('https://a.test/');
    expect(seen[0]!.headers!['Cookie']).toBe('from=header');
  });

  test('injected cookies are scoped to their origin', async () => {
    const { client, seen } = recordingClient(() => ({}));
    const fetcher = new Fetcher({ client });
    fetcher.setCookieString('https://a.test/', 'only=a.test');

    await fetcher.fetch('https://b.test/');
    // A cookie for one origin must not leak to another.
    expect(seen[0]!.headers!['Cookie']).toBeUndefined();
  });

  test('reports no redirect by returning an empty finalUrl', async () => {
    const { client } = recordingClient(() => ({}));
    const fetcher = new Fetcher({ client });
    const result = await fetcher.fetchWithStatus('https://a.test/');
    // Convention: an unchanged final URL is reported as ''.
    expect(result.finalUrl).toBe('');
  });

  test('reports a genuine redirect', async () => {
    const { client } = recordingClient(() => ({
      finalUrl: 'https://a.test/final',
    }));
    const fetcher = new Fetcher({ client });
    const result = await fetcher.fetchWithStatus('https://a.test/');
    expect(result.finalUrl).toBe('https://a.test/final');
  });

  test('fetch rejects on a non-2xx status', async () => {
    const { client } = recordingClient(() => ({ status: 404 }));
    const fetcher = new Fetcher({ client });
    await expect(fetcher.fetch('https://a.test/missing')).rejects.toThrow(
      /404/,
    );
  });

  test('fetchWithStatus surfaces a non-2xx status without throwing', async () => {
    const { client } = recordingClient(() => ({ status: 403 }));
    const fetcher = new Fetcher({ client });
    const result = await fetcher.fetchWithStatus('https://a.test/forbidden');
    expect(result.statusCode).toBe(403);
  });

  test('retries a transient failure then succeeds', async () => {
    let attempts = 0;
    const client: HttpClient = {
      async request(req: HttpRequest): Promise<HttpResponse> {
        attempts++;
        if (attempts < 3) {
          throw new Error('ECONNRESET');
        }
        return {
          status: 200,
          headers: {},
          body: new TextEncoder().encode('ok'),
          finalUrl: req.url,
        };
      },
      async head(req: HttpRequest): Promise<HttpResponse> {
        void req;
        throw new Error('unused');
      },
    };

    const fetcher = new Fetcher({ client });
    const result = await fetcher.fetchWithStatus('https://a.test/flaky');
    expect(result.statusCode).toBe(200);
    expect(attempts).toBe(3);
  });

  test('gives up after the retry budget', async () => {
    let attempts = 0;
    const client: HttpClient = {
      async request(): Promise<HttpResponse> {
        attempts++;
        throw new Error('ECONNREFUSED');
      },
      async head(): Promise<HttpResponse> {
        throw new Error('unused');
      },
    };

    const fetcher = new Fetcher({ client });
    await expect(fetcher.fetchWithStatus('https://a.test/dead')).rejects.toThrow();
    // Three attempts total: the initial call plus two retries.
    expect(attempts).toBe(3);
  });

  test('does not retry an aborted request', async () => {
    let attempts = 0;
    const client: HttpClient = {
      async request(): Promise<HttpResponse> {
        attempts++;
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      },
      async head(): Promise<HttpResponse> {
        throw new Error('unused');
      },
    };

    const fetcher = new Fetcher({ client });
    await expect(
      fetcher.fetchWithStatus('https://a.test/'),
    ).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  test('head issues a HEAD request', async () => {
    const { client, seen } = recordingClient(() => ({}));
    const fetcher = new Fetcher({ client });
    await fetcher.fetchWithStatusHead('https://a.test/app.js.map');
    expect(seen[0]!.method).toBe('HEAD');
  });

  test('honours the body size cap', async () => {
    const big = new Uint8Array(1000).fill(7);
    const client: HttpClient = {
      async request(req: HttpRequest): Promise<HttpResponse> {
        return { status: 200, headers: {}, body: big, finalUrl: req.url };
      },
      async head(req: HttpRequest): Promise<HttpResponse> {
        return { status: 200, headers: {}, body: new Uint8Array(0), finalUrl: req.url };
      },
    };

    const fetcher = new Fetcher({ client, maxBodySize: 100 });
    const result = await fetcher.fetchWithStatus('https://a.test/big.js');
    expect(result.content.byteLength).toBe(100);
  });
});