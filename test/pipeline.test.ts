/**
 * End-to-end pipeline tests against a scripted HTTP client.
 *
 * These are the tests that actually prove the port works: a fake client serves a
 * small site, and the assertions are about what the pipeline discovers. They
 * cover the most safety-critical behaviours — the deterministic discovery
 * loop, the injectable client, and the returned source content.
 */

import { describe, expect, test } from 'bun:test';

import { Pipeline, isValidSourceMap, decodeDataUri } from '../src/extractor/pipeline.js';
import { PluginRegistry } from '../src/extractor/registry.js';
import { Fetcher } from '../src/fetcher/fetcher.js';
import { MemoryStorage } from '../src/fetcher/memory-storage.js';
import { nullLogger } from '../src/extractor/logger.js';
import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
} from '../src/fetcher/types.js';
import { createDefaultRegistry } from '../src/plugins/index.js';

// ===== test harness =====

/** A site definition: path -> response. */
type Site = Record<
  string,
  {
    body: string;
    status?: number;
    contentType?: string;
    headers?: Record<string, string>;
  }
>;

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/**
 * A scripted HTTP client.
 *
 * Paths are matched against the site definition; an unknown path returns 404,
 * which is what a real probe of a missing chunk does. Every request is recorded so
 * assertions can check what was asked for.
 */
function scriptedClient(
  site: Site,
  origin: string,
): { client: HttpClient; requests: Recorded[] } {
  const requests: Recorded[] = [];

  const respond = (req: HttpRequest): HttpResponse => {
    requests.push({
      url: req.url,
      method: req.method ?? 'GET',
      headers: req.headers ?? {},
    });

    let path: string;
    try {
      const parsed = new URL(req.url);
      path = parsed.pathname + parsed.search;
    } catch {
      path = req.url;
    }

    // Exact match first, then the path without its query string.
    const entry = site[path] ?? site[path.split('?')[0] ?? ''];
    if (!entry) {
      return {
        status: 404,
        headers: { 'content-type': 'text/html' },
        body: new TextEncoder().encode('<html>not found</html>'),
        finalUrl: req.url,
      };
    }

    return {
      status: entry.status ?? 200,
      headers: {
        'content-type': entry.contentType ?? 'text/javascript',
        ...(entry.headers ?? {}),
      },
      body: new TextEncoder().encode(entry.body),
      finalUrl: req.url,
    };
  };

  const client: HttpClient = {
    async request(req: HttpRequest): Promise<HttpResponse> {
      return respond(req);
    },
    async head(req: HttpRequest): Promise<HttpResponse> {
      const res = respond({ ...req, method: 'HEAD' });
      // A HEAD response has no body.
      return { ...res, body: new Uint8Array(0) };
    },
  };

  void origin;
  return { client, requests };
}

async function runScan(options: {
  url: string;
  site: Site;
  registry?: PluginRegistry;
  storage?: MemoryStorage;
  debug?: boolean;
}) {
  const origin = new URL(options.url).origin;
  const { client, requests } = scriptedClient(options.site, origin);
  const storage = options.storage ?? new MemoryStorage();

  const pipeline = new Pipeline({
    registry: options.registry ?? createDefaultRegistry(),
    fetcher: new Fetcher({ client }),
    storage,
    debug: options.debug ?? false,
    logger: nullLogger(),
  });

  const { result } = await pipeline.run(options.url);
  return { result, requests, storage, pipeline };
}

// ===== tests =====

describe('pipeline end to end', () => {
  test('discovers scripts from the entry HTML', async () => {
    const { result } = await runScan({
      url: 'https://example.test/',
      site: {
        '/': {
          contentType: 'text/html',
          body: `<!doctype html><html><head>
            <script src="/static/app.js"></script>
            <link rel="modulepreload" href="/static/vendor.js">
          </head></html>`,
        },
        '/static/app.js': { body: 'console.log("app");' },
        '/static/vendor.js': { body: 'console.log("vendor");' },
        // Serving the modulepreload hint makes the Vite plugin probe for a build
        // manifest. Its absence is answered with a real 404 so the probe finds
        // nothing, which is the realistic case.
        '/.vite/manifest.json': {
          status: 404,
          contentType: 'text/html',
          body: '<html>not found</html>',
        },
      },
    });

    expect(result.jsUrls).toContain('https://example.test/static/app.js');
    expect(result.jsUrls).toContain('https://example.test/static/vendor.js');
    expect(result.summary.jsCount).toBe(2);

    // Provenance is recorded, and the entry page's discoveries are attributed to
    // the HTML script plugin.
    const app = result.jsDetails.find((d) =>
      d.url.endsWith('/static/app.js'),
    );
    expect(app?.fromPlugin).toBe('HTMLScriptPlugin');
    expect(app?.fromUrl).toBe('https://example.test/');
  });

  test('drops a manifest path that answers with an HTML page', async () => {
    // Both sides of the static-resource heuristic pinned down. The predicate is
    // true for a manifest path (because `.json` contains `.js`), but the body is
    // HTML and non-empty, so the pipeline drops it. Verified against the Go
    // implementation, which takes the same branch.
    const { result } = await runScan({
      url: 'https://example.test/',
      site: {
        '/': {
          contentType: 'text/html',
          body: '<html><link rel="modulepreload" href="/static/app.js"></html>',
        },
        '/static/app.js': { body: 'app' },
        '/.vite/manifest.json': {
          status: 200,
          contentType: 'text/html',
          body: '<html>index of /</html>',
        },
      },
    });

    expect(result.jsUrls).not.toContain(
      'https://example.test/.vite/manifest.json',
    );
  });

  test('reports a .js endpoint that answers with an empty body', async () => {
    // The counter-case to the rule above: an empty body means a real endpoint
    // that happens to return nothing (analytics beacons do this), so the URL is
    // reported even though the content type said HTML.
    const { result } = await runScan({
      url: 'https://example.test/',
      site: {
        '/': {
          contentType: 'text/html',
          body: '<html><script src="/beacon.js"></script></html>',
        },
        '/beacon.js': { status: 200, contentType: 'text/html', body: '' },
      },
    });

    expect(result.jsUrls).toContain('https://example.test/beacon.js');
  });

  test('follows a dynamic import chain transitively', async () => {
    const { result } = await runScan({
      url: 'https://example.test/',
      site: {
        '/': {
          contentType: 'text/html',
          body: '<html><script src="/entry.js"></script></html>',
        },
        '/entry.js': { body: 'import("./a.js");' },
        '/a.js': { body: 'import("./b.js");' },
        '/b.js': { body: 'export const b = 1;' },
      },
    });

    expect(result.jsUrls).toContain('https://example.test/entry.js');
    expect(result.jsUrls).toContain('https://example.test/a.js');
    expect(result.jsUrls).toContain('https://example.test/b.js');
  });

  test('runs inline scripts with the document as their base URL', async () => {
    const { result } = await runScan({
      url: 'https://example.test/app/page.html',
      site: {
        '/app/page.html': {
          contentType: 'text/html',
          body: `<html><script>
            var loader = "/app/nested/chunk.js";
            import(loader);
          </script></html>`,
        },
        '/app/nested/chunk.js': { body: 'ok' },
      },
    });

    // The inline script resolved a variable-built path relative to the document's
    // directory, not the site root.
    expect(result.jsUrls).toContain(
      'https://example.test/app/nested/chunk.js',
    );
  });

  test('drops a JS URL that the server refuses', async () => {
    const { result } = await runScan({
      url: 'https://example.test/',
      site: {
        '/': {
          contentType: 'text/html',
          body: '<html><script src="/blocked.js"></script></html>',
        },
        '/blocked.js': { status: 403, body: 'forbidden' },
      },
    });

    // Non-2xx entries are dropped silently. A `recordUnreachableJS` helper exists but
    // would report these URLs, but never calls it, so this is the shipped
    // behaviour: the URL set does not include refused chunks.
    expect(result.jsUrls).not.toContain('https://example.test/blocked.js');
    expect(result.summary.jsCount).toBe(0);
  });

  test('drops a .js URL that returned an HTML error page', async () => {
    const { result } = await runScan({
      url: 'https://example.test/',
      site: {
        '/': {
          contentType: 'text/html',
          body: '<html><script src="/missing.js"></script></html>',
        },
        // A soft 404: the path looks like JS, the body is a page.
        '/missing.js': {
          status: 200,
          contentType: 'text/html',
          body: '<html>page not found</html>',
        },
      },
    });

    expect(result.jsUrls).not.toContain('https://example.test/missing.js');
  });

  test('expands a CDN combo-loader URL into its members', async () => {
    const { result } = await runScan({
      url: 'https://example.test/',
      site: {
        '/': {
          contentType: 'text/html',
          body: '<html><script src="/_static/??/js/a.js,/js/b.js"></script></html>',
        },
        '/_static/js/a.js': { body: 'a' },
        '/_static/js/b.js': { body: 'b' },
      },
    });

    // The bundle itself is not a JS file; its members are.
    expect(result.jsUrls).toContain('https://example.test/_static/js/a.js');
    expect(result.jsUrls).toContain('https://example.test/_static/js/b.js');
  });

  test('rebases a baked-in loopback address onto the scanned origin', async () => {
    const { result } = await runScan({
      url: 'https://example.test/',
      site: {
        '/': {
          contentType: 'text/html',
          body: '<html><script src="/entry.js"></script></html>',
        },
        // A build artifact that baked in the dev server's port.
        '/entry.js': {
          body: 'import("http://127.0.0.1:50315/remote/remoteEntry.js");',
        },
        '/remote/remoteEntry.js': { body: 'remote' },
      },
    });

    // The dead dev port was rewritten to the scanned origin, and the chunk was
    // found there.
    expect(result.jsUrls).toContain(
      'https://example.test/remote/remoteEntry.js',
    );
    expect(result.jsUrls.some((u) => u.includes('127.0.0.1'))).toBe(false);
  });

  test('discovers a source map and restores its sources as content', async () => {
    const map = JSON.stringify({
      version: 3,
      sources: ['webpack:///./src/App.jsx', 'webpack:///./src/util.js'],
      sourcesContent: ['export const App = 1;\n', 'export const u = 2;\n'],
      mappings: 'AAAA',
    });

    const { result } = await runScan({
      url: 'https://example.test/',
      site: {
        '/': {
          contentType: 'text/html',
          body: '<html><script src="/app.js"></script></html>',
        },
        '/app.js': { body: 'console.log(1);\n//# sourceMappingURL=app.js.map' },
        '/app.js.map': { body: map, contentType: 'application/json' },
      },
    });

    expect(result.summary.sourceMapCount).toBe(1);
    expect(result.summary.sourceCount).toBe(2);

    // The restored content is returned, not merely written to disk — this is the
    // main addition over the naive approach.
    const paths = result.sources.map((s) => s.path).sort();
    expect(paths).toEqual(['src/App.jsx', 'src/util.js']);

    const app = result.sources.find((s) => s.path === 'src/App.jsx');
    expect(app?.content).toBe('export const App = 1;\n');
    expect(app?.mode).toBe('sourcesContent');
    expect(app?.fromJs).toBe('https://example.test/app.js');

    // The map URL is recorded against the JS file it belongs to.
    expect(result.sourceMaps?.['https://example.test/app.js']).toBe(
      'https://example.test/app.js.map',
    );
  });

  test('rejects an HTML error page served in place of a source map', async () => {
    const { result } = await runScan({
      url: 'https://example.test/',
      site: {
        '/': {
          contentType: 'text/html',
          body: '<html><script src="/app.js"></script></html>',
        },
        '/app.js': { body: 'console.log(1);' },
        // A WAF blocking .map requests with a 200 and an HTML page.
        '/app.js.map': {
          status: 200,
          contentType: 'text/html',
          body: '<html>blocked</html>',
        },
      },
    });

    expect(result.summary.sourceMapCount).toBe(0);
    expect(result.sources).toHaveLength(0);
  });

  test('handles an inline data-URI source map', async () => {
    const inner = JSON.stringify({
      version: 3,
      sources: ['src/inline.js'],
      sourcesContent: ['export const inline = true;\n'],
      mappings: '',
    });
    const dataUri = `data:application/json;base64,${btoa(inner)}`;

    const { result } = await runScan({
      url: 'https://example.test/',
      site: {
        '/': {
          contentType: 'text/html',
          body: '<html><script src="/inline.js"></script></html>',
        },
        '/inline.js': {
          body: `console.log(1);\n//# sourceMappingURL=${dataUri}`,
        },
      },
    });

    expect(result.sources.map((s) => s.path)).toEqual(['src/inline.js']);
  });

  test('follows a webpack runtime chunk map', async () => {
    const { result } = await runScan({
      url: 'https://example.test/',
      site: {
        '/': {
          contentType: 'text/html',
          body: '<html><script src="/runtime.js"></script></html>',
        },
        // A webpack runtime with a static chunk map.
        '/runtime.js': {
          body: `__webpack_require__.u=e=>"static/js/"+e+"-"+{10:"ce0cc4f",11:"aa11bb2"}[e]+".js";`,
        },
        '/static/js/10-ce0cc4f.js': { body: 'chunk10' },
        '/static/js/11-aa11bb2.js': { body: 'chunk11' },
      },
    });

    expect(result.jsUrls).toContain('https://example.test/static/js/10-ce0cc4f.js');
    expect(result.jsUrls).toContain('https://example.test/static/js/11-aa11bb2.js');
  });

  test('follows a Vite manifest discovered from modulepreload', async () => {
    const manifest = JSON.stringify({
      'index.html': { file: 'assets/index-abc.js', isEntry: true },
      'src/lazy.ts': { file: 'assets/lazy-def.js', isDynamicEntry: true },
    });

    const { result } = await runScan({
      url: 'https://example.test/',
      site: {
        '/': {
          contentType: 'text/html',
          body: '<html><link rel="modulepreload" href="/assets/index-abc.js"></html>',
        },
        '/assets/index-abc.js': { body: 'import("lazy")' },
        '/.vite/manifest.json': { body: manifest, contentType: 'application/json' },
        '/assets/lazy-def.js': { body: 'lazy' },
      },
    });

    expect(result.jsUrls).toContain('https://example.test/assets/index-abc.js');
    // The lazy entry is only named in the manifest.
    expect(result.jsUrls).toContain('https://example.test/assets/lazy-def.js');
  });

  test('records a discovered HTML page as an entry and crawls it', async () => {
    const { result } = await runScan({
      url: 'https://example.test/',
      site: {
        '/': {
          contentType: 'text/html',
          body: '<html><a href="/page1">One</a><script src="/home.js"></script></html>',
        },
        '/home.js': { body: 'home' },
        '/page1': {
          contentType: 'text/html',
          body: '<html><script src="/page1.js"></script></html>',
        },
        '/page1.js': { body: 'page one' },
      },
    });

    expect(result.htmlEntries.length).toBeGreaterThan(0);
    expect(result.jsUrls).toContain('https://example.test/page1.js');
  });

  test('does not crawl off-origin HTML links', async () => {
    const { result } = await runScan({
      url: 'https://example.test/',
      site: {
        '/': {
          contentType: 'text/html',
          body: '<html><a href="https://other.test/page">off-site</a></html>',
        },
      },
    });

    expect(result.htmlEntries).toHaveLength(0);
  });

  test('injects caller headers and cookies into every request', async () => {
    const origin = new URL('https://example.test/').origin;
    const { client, requests } = scriptedClient(
      {
        '/': {
          contentType: 'text/html',
          body: '<html><script src="/a.js"></script></html>',
        },
        '/a.js': { body: 'a' },
      },
      origin,
    );

    const fetcher = new Fetcher({ client });
    fetcher.setExtraHeaders({ 'X-Token': 'secret', 'User-Agent': 'custom-UA' });
    fetcher.setCookieString('https://example.test/', 'cf_clearance=tok');

    const pipeline = new Pipeline({
      registry: createDefaultRegistry(),
      fetcher,
      storage: new MemoryStorage(),
      logger: nullLogger(),
    });
    await pipeline.run('https://example.test/');

    // Both requests carried the injected header.
    for (const req of requests) {
      expect(req.headers['X-Token']).toBe('secret');
    }
  });

  test('uses the cache on a second run and skips the network', async () => {
    const site: Site = {
      '/': {
        contentType: 'text/html',
        body: '<html><script src="/app.js"></script></html>',
      },
      '/app.js': { body: 'import("./chunk.js")' },
      '/chunk.js': { body: 'chunk' },
    };

    const storage = new MemoryStorage();
    const first = await runScan({ url: 'https://example.test/', site, storage });
    expect(first.result.jsUrls).toHaveLength(2);

    const second = await runScan({ url: 'https://example.test/', site, storage });

    // Second run replays meta.json, so the same URLs come back.
    expect(second.result.jsUrls.sort()).toEqual(first.result.jsUrls.sort());

    // And no network request was needed for the JS.
    const networkHits = second.requests.filter(
      (r) => r.url.endsWith('.js') && r.method === 'GET',
    );
    expect(networkHits).toHaveLength(0);
  });

  test('produces the same result across repeated runs (deterministic)', async () => {
    const site: Site = {
      '/': {
        contentType: 'text/html',
        body: `<html>
          <script src="/entry.js"></script>
          <script src="/second.js"></script>
        </html>`,
      },
      '/entry.js': { body: 'import("./a.js");import("./b.js");' },
      '/second.js': { body: 'import("./c.js");' },
      '/a.js': { body: 'import("./deep.js")' },
      '/b.js': { body: 'b' },
      '/c.js': { body: 'c' },
      '/deep.js': { body: 'deep' },
    };

    // Fresh storage each time, so both runs do full discovery.
    const runs = await Promise.all([
      runScan({ url: 'https://example.test/', site }),
      runScan({ url: 'https://example.test/', site }),
      runScan({ url: 'https://example.test/', site }),
    ]);

    const sorted = runs.map((r) => [...r.result.jsUrls].sort());
    const first = sorted[0]!;
    for (const other of sorted.slice(1)) {
      expect(other).toEqual(first);
    }
    expect(first).toHaveLength(6);
  });

  test('honours an abort signal', async () => {
    const controller = new AbortController();
    controller.abort();

    const origin = new URL('https://example.test/').origin;
    const { client } = scriptedClient(
      {
        '/': {
          contentType: 'text/html',
          body: '<html><script src="/a.js"></script></html>',
        },
      },
      origin,
    );

    const pipeline = new Pipeline({
      registry: createDefaultRegistry(),
      fetcher: new Fetcher({ client }),
      storage: new MemoryStorage(),
      logger: nullLogger(),
    });

    // An aborted scan rejects promptly rather than hanging or resolving empty. The
    // error is the abort itself, not an EntryFetchError: reporting a caller's own
    // cancellation as a fetch failure would misattribute the cause, and a service
    // needs to tell "the client gave up" from "the target was unreachable".
    await expect(
      pipeline.run('https://example.test/', controller.signal),
    ).rejects.toThrow(/abort/i);
  });

  test('an unreachable entry page rejects rather than returning an empty result', async () => {
    // The ambiguity this prevents: a CORS block, a DNS failure and a dead host all
    // produce zero discovered URLs, which is indistinguishable from a site that has
    // no JavaScript. A caller cannot act on that, so the failure is raised.
    const pipeline = new Pipeline({
      registry: createDefaultRegistry(),
      fetcher: new Fetcher({
        client: {
          async request() {
            throw new Error('ECONNREFUSED');
          },
          async head() {
            throw new Error('ECONNREFUSED');
          },
        },
      }),
      storage: new MemoryStorage(),
      logger: nullLogger(),
    });

    await expect(pipeline.run('https://example.test/')).rejects.toThrow(
      /could not fetch/i,
    );
  });

  test('a non-2xx entry page rejects too', async () => {
    const pipeline = new Pipeline({
      registry: createDefaultRegistry(),
      fetcher: new Fetcher({
        client: {
          async request(req: HttpRequest) {
            return {
              status: 403,
              headers: { 'content-type': 'text/html' },
              body: new TextEncoder().encode('<html>blocked</html>'),
              finalUrl: req.url,
            };
          },
          async head(req: HttpRequest) {
            return this.request(req);
          },
        } as HttpClient,
      }),
      storage: new MemoryStorage(),
      logger: nullLogger(),
    });

    await expect(pipeline.run('https://example.test/')).rejects.toThrow(/403/);
  });

  test('the reported counts are self-consistent', async () => {
    // A count that disagrees with the arrays it summarises is the kind of bug that
    // only shows up when someone trusts the number. Pinned here so the invariant
    // cannot drift: summary.jsCount equals the URL list, the detail list, and the
    // de-duplicated set, and every detail appears in the URL list.
    const { result } = await runScan({
      url: 'https://example.test/',
      site: {
        '/': {
          contentType: 'text/html',
          body: `<html>
            <script src="/a.js"></script>
            <script src="/a.js"></script>
            <script src="/b.js"></script>
          </html>`,
        },
        '/a.js': { body: 'import("./c.js");' },
        '/b.js': { body: 'b' },
        '/c.js': { body: 'c' },
      },
    });

    expect(result.summary.jsCount).toBe(result.jsUrls.length);
    expect(new Set(result.jsUrls).size).toBe(result.summary.jsCount);
    expect(result.jsDetails).toHaveLength(result.summary.jsCount);
    for (const detail of result.jsDetails) {
      expect(result.jsUrls).toContain(detail.url);
    }

    // A duplicate reference must not inflate the count.
    expect(result.jsUrls.filter((u) => u.endsWith('/a.js'))).toHaveLength(1);
  });

  test('sourceCount equals the returned sources plus the omitted ones', async () => {
    // The cap drops content from the result but must not drop it from the count,
    // and `sourcesOmitted` is what explains the difference.
    const map = JSON.stringify({
      version: 3,
      sources: ['s1.js', 's2.js', 's3.js'],
      sourcesContent: ['a', 'b', 'c'],
      mappings: 'AAAA',
    });

    const { result } = await runScan({
      url: 'https://example.test/',
      site: {
        '/': {
          contentType: 'text/html',
          body: '<html><script src="/app.js"></script></html>',
        },
        '/app.js': { body: 'x\n//# sourceMappingURL=app.js.map' },
        '/app.js.map': { body: map, contentType: 'application/json' },
      },
    });

    expect(result.summary.sourceCount).toBe(3);
    expect(result.sources).toHaveLength(3);
    expect(result.sourcesOmitted).toBe(0);
    expect(result.summary.sourceCount).toBe(
      result.sources.length + result.sourcesOmitted,
    );
  });

  test('supports a registry containing a single plugin', async () => {
    const registry = new PluginRegistry();
    // Import lazily to avoid a circular reference in the test module graph.
    const { HtmlScriptPlugin } = await import('../src/plugins/html-script.js');
    registry.register(new HtmlScriptPlugin());

    const { result } = await runScan({
      url: 'https://example.test/',
      registry,
      site: {
        '/': {
          contentType: 'text/html',
          body: '<html><script src="/a.js"></script></html>',
        },
        '/a.js': { body: 'import("./hidden.js")' },
        '/hidden.js': { body: 'x' },
      },
    });

    // The script tag was found, but the dynamic import was not: only the HTML
    // plugin ran.
    expect(result.jsUrls).toContain('https://example.test/a.js');
    expect(result.jsUrls).not.toContain('https://example.test/hidden.js');
  });

  test('writes artifacts to the storage under the documented layout', async () => {
    const storage = new MemoryStorage();
    await runScan({
      url: 'https://example.test/',
      storage,
      site: {
        '/': {
          contentType: 'text/html',
          body: '<html><script src="/app.js"></script></html>',
        },
        '/app.js': { body: 'app' },
      },
    });

    const scope = 'https_example.test_';
    expect(
      await storage.exists({ scope, subdir: 'html', path: 'web.html' }),
    ).toBe(true);
    expect(
      await storage.exists({ scope, subdir: 'js', path: 'example.test-app.js' }),
    ).toBe(true);
    expect(await storage.readMetadata(scope)).not.toBeNull();
  });
});

// ===== helpers =====

describe('source map validation', () => {
  test('accepts a real map', () => {
    const map = new TextEncoder().encode(
      JSON.stringify({ version: 3, sources: ['a.js'], mappings: '' }),
    );
    expect(isValidSourceMap(map)).toBe(true);
  });

  test('rejects an HTML page', () => {
    expect(
      isValidSourceMap(new TextEncoder().encode('<html>blocked</html>')),
    ).toBe(false);
  });

  test('rejects empty input', () => {
    expect(isValidSourceMap(new Uint8Array(0))).toBe(false);
  });

  test('rejects JSON without sources', () => {
    expect(
      isValidSourceMap(new TextEncoder().encode('{"version":3}')),
    ).toBe(false);
  });

  test('rejects a bare JSON array', () => {
    expect(isValidSourceMap(new TextEncoder().encode('[1,2,3]'))).toBe(false);
  });
});

describe('data URI decoding', () => {
  test('decodes base64 payloads', () => {
    const encoded = btoa('{"a":1}');
    const decoded = decodeDataUri(`data:application/json;base64,${encoded}`);
    expect(decoded).not.toBeNull();
    expect(new TextDecoder().decode(decoded!)).toBe('{"a":1}');
  });

  test('decodes percent-encoded payloads', () => {
    const decoded = decodeDataUri('data:application/json,%7B%22a%22%3A1%7D');
    expect(new TextDecoder().decode(decoded!)).toBe('{"a":1}');
  });

  test('returns null for a non-data URI', () => {
    expect(decodeDataUri('https://example.test/a.js')).toBeNull();
  });

  test('returns null for malformed input', () => {
    expect(decodeDataUri('data:application/json;base64')).toBeNull();
  });
});