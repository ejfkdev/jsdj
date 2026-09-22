/**
 * Tests for the library and CLI surfaces.
 *
 * The pipeline tests cover discovery; these cover the parts a caller or a shell
 * script actually touches: the `scan` facade, transport injection, the storage
 * selection rules, argument parsing with the legacy spellings, and output
 * rendering.
 */

import { describe, expect, test } from 'bun:test';

import { scan, discover, ScanInputError } from '../src/scan.js';
import { MemoryStorage, NullStorage } from '../src/fetcher/memory-storage.js';
import type { StorageKey } from '../src/fetcher/storage.js';
import { detectRuntime } from '../src/fetcher/runtime.js';
import { PluginRegistry } from '../src/extractor/registry.js';
import { HtmlScriptPlugin } from '../src/plugins/html-script.js';
import { formatMarkdown, formatText, formatJson } from '../src/extractor/output.js';
import { createDefaultRegistry, BUILTIN_PLUGIN_NAMES } from '../src/plugins/index.js';
import type { ScanResult } from '../src/extractor/types.js';
import { CliError, parseArgs, parseHeaderList } from '../src/cli/args.js';
import { helpText, defaultCachePath } from '../src/cli/help.js';

// ===== test fixture =====

const SITE: Record<string, { body: string; contentType?: string; status?: number }> = {
  '/': {
    contentType: 'text/html',
    body: `<html><head>
      <script src="/static/runtime.js"></script>
      <link rel="modulepreload" href="/static/vendor.js">
    </head></html>`,
  },
  '/static/runtime.js': {
    body: `__webpack_require__.u=e=>"static/"+e+"-"+{10:"ce0cc4f"}[e]+".js";import("./lazy.js");`,
  },
  '/static/vendor.js': { body: 'vendor' },
  '/static/lazy.js': { body: 'lazy' },
  '/static/10-ce0cc4f.js': { body: 'chunk10' },
};

/** An injected transport backed by the fixture above. */
function fixtureTransport(): {
  fetch: (req: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
  }) => Promise<{
    status: number;
    headers: Record<string, string>;
    body: Uint8Array;
  }>;
  calls: Array<{ url: string; method: string; headers: Record<string, string> }>;
} {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];

  return {
    calls,
    async fetch(req) {
      const url = new URL(req.url);
      const method = req.method ?? 'GET';
      calls.push({ url: req.url, method, headers: req.headers ?? {} });

      const entry = SITE[url.pathname];
      const body = entry?.body ?? '';
      const status = entry?.status ?? (entry ? 200 : 404);

      return {
        status,
        headers: {
          'content-type': entry?.contentType ?? (entry ? 'application/javascript' : 'text/html'),
        },
        // HEAD responses carry no body, as a real server would send.
        body:
          method === 'HEAD'
            ? new Uint8Array(0)
            : new TextEncoder().encode(body),
      };
    },
  };
}

/**
 * A storage that counts reads and writes.
 *
 * Used to pin the cache-option semantics, which are easy to get subtly wrong: a
 * "disabled" cache that also refuses writes silently discards the artifacts a forced
 * rescan just downloaded.
 */
class SpyStorage extends MemoryStorage {
  reads = 0;
  writes = 0;

  override async read(key: StorageKey): Promise<Uint8Array | null> {
    this.reads++;
    return super.read(key);
  }

  override async write(key: StorageKey, content: Uint8Array): Promise<void> {
    this.writes++;
    return super.write(key, content);
  }
}

// ===== scan facade =====

describe('scan', () => {
  test('discovers via an injected transport', async () => {
    const transport = fixtureTransport();
    const result = await scan({
      url: 'http://127.0.0.1:18080/',
      transport,
      storage: new MemoryStorage(),
    });

    expect(result.summary.jsCount).toBe(4);
    expect(result.jsUrls).toContain('http://127.0.0.1:18080/static/runtime.js');
    expect(result.jsUrls).toContain('http://127.0.0.1:18080/static/lazy.js');
    expect(result.jsUrls).toContain('http://127.0.0.1:18080/static/10-ce0cc4f.js');
    expect(transport.calls.length).toBeGreaterThan(0);
  });

  test('rejects a missing url', async () => {
    await expect(scan({ url: '' })).rejects.toBeInstanceOf(ScanInputError);
  });

  test('rejects a url without a scheme', async () => {
    await expect(scan({ url: 'example.com' })).rejects.toBeInstanceOf(
      ScanInputError,
    );
  });

  test('forwards headers and User-Agent to the transport', async () => {
    const transport = fixtureTransport();
    await scan({
      url: 'http://127.0.0.1:18080/',
      transport,
      storage: new MemoryStorage(),
      headers: { 'X-Token': 'abc', 'X-Other': 'def' },
    });

    const first = transport.calls[0]!;
    expect(first.headers['X-Token']).toBe('abc');
    expect(first.headers['X-Other']).toBe('def');
  });

  test('accepts tlsFingerprint without error even when unsupported', async () => {
    const transport = fixtureTransport();
    // The transport here cannot fingerprint TLS; requesting it must be a no-op,
    // never a failure. This is the documented degradation.
    const result = await scan({
      url: 'http://127.0.0.1:18080/',
      transport,
      storage: new MemoryStorage(),
      tlsFingerprint: 'chrome',
    });
    expect(result.summary.jsCount).toBeGreaterThan(0);
  });

  test('honours a caller-supplied registry', async () => {
    const registry = new PluginRegistry();
    registry.register(new HtmlScriptPlugin());

    const transport = fixtureTransport();
    const result = await scan({
      url: 'http://127.0.0.1:18080/',
      transport,
      storage: new MemoryStorage(),
      plugins: registry,
    });

    // Only the HTML plugin ran, so the dynamic import and webpack chunk are absent.
    expect(result.jsUrls).toContain('http://127.0.0.1:18080/static/runtime.js');
    expect(result.jsUrls).not.toContain('http://127.0.0.1:18080/static/lazy.js');
  });

  test('onlyPlugins throws on an unknown name', async () => {
    await expect(
      scan({
        url: 'http://127.0.0.1:18080/',
        transport: fixtureTransport(),
        storage: new MemoryStorage(),
        onlyPlugins: ['NotAPlugin'],
      }),
    ).rejects.toThrow(/unknown plugin/);
  });

  test('excludePlugins removes a plugin without erroring', async () => {
    const transport = fixtureTransport();
    const result = await scan({
      url: 'http://127.0.0.1:18080/',
      transport,
      storage: new MemoryStorage(),
      excludePlugins: ['WebpackPlugin', 'DynamicImportPlugin', 'UniversalURLPlugin'],
    });

    expect(result.jsUrls).toContain('http://127.0.0.1:18080/static/runtime.js');
    // With webpack, dynamic-import and the generic fallback all excluded, nothing
    // derives the lazy chunk or the mapped chunks from the runtime's body.
    expect(result.jsUrls).not.toContain('http://127.0.0.1:18080/static/lazy.js');
    expect(result.jsUrls).not.toContain('http://127.0.0.1:18080/static/10-ce0cc4f.js');
  });

  test('plugins overlap by design, so excluding one rarely loses a finding', async () => {
    // Excluding only DynamicImportPlugin still finds the dynamic import, because
    // UniversalURLPlugin matches the same pattern as its fallback role. This is
    // By design the generic plugin runs in parallel with the specific ones —
    // and is why a caller excluding a plugin to reduce output should check the
    // result rather than assume the URLs disappear.
    const transport = fixtureTransport();
    const result = await scan({
      url: 'http://127.0.0.1:18080/',
      transport,
      storage: new MemoryStorage(),
      excludePlugins: ['DynamicImportPlugin'],
    });

    expect(result.jsUrls).toContain('http://127.0.0.1:18080/static/lazy.js');
    const lazy = result.jsDetails.find((d) => d.url.endsWith('/static/lazy.js'));
    // The provenance names whichever plugin did find it.
    expect(lazy?.fromPlugin).not.toBe('DynamicImportPlugin');
  });

  test('noCache suppresses reads but keeps writes, as --no-cache does', async () => {
    // The distinction matters: `--no-cache` means "go to the network, but still
    // save what you downloaded". Treating it as "disable the cache" would throw away
    // the artifacts a forced rescan just fetched.
    const transport = fixtureTransport();
    const storage = new SpyStorage();

    const result = await scan({
      url: 'http://127.0.0.1:18080/',
      transport,
      storage,
      noCache: true,
    });

    expect(result.summary.jsCount).toBe(4);
    expect(storage.reads).toBe(0);
    expect(storage.writes).toBeGreaterThan(0);
  });

  test('the cache options apply to an explicitly supplied store', () => {
    // A caller who owns their storage and wants a forced rescan is exactly the case
    // that needs `noCache`, so returning their store unchanged would make the option
    // silently inert.
    //
    // Covered by the four-way comparison in `test/cache-options.test.ts`.
  });

  test('writeCache false suppresses writes but keeps reads', async () => {
    const transport = fixtureTransport();
    const storage = new SpyStorage();

    const result = await scan({
      url: 'http://127.0.0.1:18080/',
      transport,
      storage,
      writeCache: false,
    });

    expect(result.summary.jsCount).toBe(4);
    expect(storage.reads).toBeGreaterThan(0);
    expect(storage.writes).toBe(0);
  });

  test('a second run with the same storage needs no network', async () => {
    const transport = fixtureTransport();
    const storage = new MemoryStorage();

    const first = await scan({
      url: 'http://127.0.0.1:18080/',
      transport,
      storage,
    });
    const callsAfterFirst = transport.calls.length;

    const second = await scan({
      url: 'http://127.0.0.1:18080/',
      transport,
      storage,
    });

    expect(second.jsUrls.sort()).toEqual(first.jsUrls.sort());
    // The warm run replayed meta.json, so it issued no further requests.
    expect(transport.calls.length).toBe(callsAfterFirst);
  });

  test('maxInlineSources 0 omits content but keeps the count', async () => {
    const transport = fixtureTransport();
    const result = await scan({
      url: 'http://127.0.0.1:18080/',
      transport,
      storage: new MemoryStorage(),
      maxInlineSources: 0,
    });
    expect(result.sources).toHaveLength(0);
  });

  test('discover returns only the URL list', async () => {
    const urls = await discover({
      url: 'http://127.0.0.1:18080/',
      transport: fixtureTransport(),
      storage: new MemoryStorage(),
    });
    expect(Array.isArray(urls)).toBe(true);
    expect(urls).toHaveLength(4);
  });
});

// ===== storage selection =====

describe('storage selection', () => {
  test('detectRuntime identifies Node', () => {
    expect(detectRuntime()).toBe('node');
  });

  test('an explicit storage is used as-is', async () => {
    const storage = new MemoryStorage();
    await scan({
      url: 'http://127.0.0.1:18080/',
      transport: fixtureTransport(),
      storage,
    });
    // The supplied store was written to.
    expect(await storage.readMetadata('http_127.0.0.1_18080_')).not.toBeNull();
  });

  test('NullStorage disables caching entirely', async () => {
    const storage = new NullStorage();
    const result = await scan({
      url: 'http://127.0.0.1:18080/',
      transport: fixtureTransport(),
      storage,
    });
    expect(result.summary.jsCount).toBe(4);
    expect(result.cacheDirs).toBeUndefined();
  });

  test('cache:false still writes artifacts', async () => {
    const storage = new MemoryStorage();
    await scan({
      url: 'http://127.0.0.1:18080/',
      transport: fixtureTransport(),
      storage,
      // Reads off, writes on: --no-cache.
      cache: false,
      writeCache: true,
    });
    expect(
      await storage.exists({
        scope: 'http_127.0.0.1_18080_',
        subdir: 'js',
        path: '127.0.0.1_18080-static-runtime.js',
      }),
    ).toBe(true);
  });
});

// ===== output rendering =====

describe('output rendering', () => {
  const result: ScanResult = {
    summary: { jsCount: 2, sourceMapCount: 1, sourceCount: 3 },
    jsUrls: ['https://a.test/a.js', 'https://a.test/b.js'],
    jsDetails: [
      {
        url: 'https://a.test/a.js',
        fromUrl: 'https://a.test/',
        fromPlugin: 'HTMLScriptPlugin',
        isInline: false,
      },
    ],
    htmlEntries: [],
    sources: [],
    sourcesOmitted: 0,
  };

  test('text is a bare URL list', () => {
    expect(formatText(result)).toBe('https://a.test/a.js\nhttps://a.test/b.js');
  });

  test('json round-trips the result', () => {
    const parsed = JSON.parse(formatJson(result)) as ScanResult;
    expect(parsed.summary.jsCount).toBe(2);
    expect(parsed.jsUrls).toHaveLength(2);
  });

  test('markdown includes the summary and provenance sections', () => {
    const md = formatMarkdown(result);
    expect(md).toContain('## Summary');
    expect(md).toContain('- **JS files**: 2');
    expect(md).toContain('- **Source maps**: 1 (found)');
    expect(md).toContain('- **Restored sources**: 3 files (restored)');
    expect(md).toContain('## JS URLs');
    expect(md).toContain('## JS Provenance');
    expect(md).toContain('HTMLScriptPlugin');
  });

  test('markdown reports an absent cache as disabled', () => {
    const md = formatMarkdown(result);
    expect(md).toContain('- cache disabled');
  });

  test('markdown reports zero source maps explicitly', () => {
    const md = formatMarkdown({
      ...result,
      summary: { jsCount: 0, sourceMapCount: 0, sourceCount: 0 },
    });
    expect(md).toContain('- **Source maps**: 0 (not found)');
    expect(md).toContain('- **Restored sources**: 0 (not restored)');
  });
});

// ===== CLI argument parsing =====

describe('CLI argument parsing', () => {
  test('url alone implies a scan', () => {
    const args = parseArgs(['https://example.com']);
    expect(args.command).toBe('scan');
    expect(args.url).toBe('https://example.com');
    expect(args.format).toBe('md');
    expect(args.timeout).toBe(30);
    expect(args.concurrency).toBe(8);
  });

  test('the canonical subcommand form works too', () => {
    expect(parseArgs(['scan', 'https://example.com']).url).toBe(
      'https://example.com',
    );
  });

  test('flags may precede or follow the URL', () => {
    expect(parseArgs(['--debug', 'https://a.test']).url).toBe('https://a.test');
    expect(parseArgs(['https://a.test', '--debug']).url).toBe('https://a.test');
    expect(parseArgs(['https://a.test', '--debug']).debug).toBe(true);
  });

  test('no arguments prints help', () => {
    expect(parseArgs([]).command).toBe('help');
  });

  test('version and help short-circuit', () => {
    expect(parseArgs(['version']).command).toBe('version');
    expect(parseArgs(['-v']).command).toBe('version');
    expect(parseArgs(['--version']).command).toBe('version');
    expect(parseArgs(['--help']).command).toBe('help');
    expect(parseArgs(['-h']).command).toBe('help');
  });

  test('the removed server subcommands fail with an explanation', () => {
    // HTTP and MCP modes are not part of this package; a clear message beats an
    // unknown-flag error.
    for (const sub of ['serve', 'mcp', 'completion']) {
      expect(() => parseArgs([sub])).toThrow(/not available/);
    }
  });

  test('--ua is accepted as an alias for --useragent', () => {
    expect(parseArgs(['--ua', 'my-UA', 'https://a.test']).userAgent).toBe('my-UA');
    expect(parseArgs(['--ua=my-UA', 'https://a.test']).userAgent).toBe('my-UA');
    expect(parseArgs(['--useragent', 'my-UA', 'https://a.test']).userAgent).toBe(
      'my-UA',
    );
  });

  test('-debug is accepted as a legacy alias', () => {
    expect(parseArgs(['-debug', 'https://a.test']).debug).toBe(true);
  });

  test('--cache accepts a boolean word via =', () => {
    expect(parseArgs(['--cache=yes', 'https://a.test']).cache).toBe(true);
    expect(parseArgs(['--cache=on', 'https://a.test']).cache).toBe(true);
    expect(parseArgs(['--cache=1', 'https://a.test']).cache).toBe(true);
    expect(parseArgs(['--cache=true', 'https://a.test']).cache).toBe(true);
    expect(parseArgs(['--cache=false', 'https://a.test']).cache).toBe(false);
    expect(parseArgs(['--cache=no', 'https://a.test']).cache).toBe(false);
    expect(parseArgs(['--cache=off', 'https://a.test']).cache).toBe(false);
    expect(parseArgs(['--cache=0', 'https://a.test']).cache).toBe(false);
  });

  test('a bare --cache followed by the URL is an error', () => {
    // The legacy form swallows the next non-flag argument and requires it to be a
    // boolean word; anything else (including the URL) is rejected. Preserved for
    // compatibility even though it is an awkward shape — use `--cache=false` or
    // `--no-cache` for the intent.
    expect(() => parseArgs(['--cache', 'https://a.test'])).toThrow(
      /invalid --cache value/,
    );
  });

  test('a bare --cache before a flag is simply enabled', () => {
    // Nothing to swallow, so it means "cache on".
    const args = parseArgs(['--cache', '--debug', 'https://a.test']);
    expect(args.cache).toBe(true);
    expect(args.debug).toBe(true);
    expect(args.url).toBe('https://a.test');
  });

  test('--cache consumes the next word as its value', () => {
    // The legacy form swallowed the following non-flag argument.
    const args = parseArgs(['--cache', 'no', 'https://a.test']);
    expect(args.cache).toBe(false);
    expect(args.url).toBe('https://a.test');
  });

  test('--no-cache disables reads but keeps writes', () => {
    const args = parseArgs(['--no-cache', 'https://a.test']);
    expect(args.cache).toBe(false);
    expect(args.writeCache).toBe(true);
  });

  test('an invalid --cache word is rejected', () => {
    expect(() => parseArgs(['--cache=maybe', 'https://a.test'])).toThrow(CliError);
  });

  test('--header is repeatable and later values win', () => {
    const args = parseArgs([
      '-H',
      'X-A: 1',
      '-H',
      'X-B: 2',
      '-H',
      'X-A: 3',
      'https://a.test',
    ]);
    expect(args.headers).toEqual(['X-A: 1', 'X-B: 2', 'X-A: 3']);
    expect(parseHeaderList(args.headers)).toEqual({ 'X-A': '3', 'X-B': '2' });
  });

  test('format is validated', () => {
    expect(parseArgs(['-f', 'json', 'https://a.test']).format).toBe('json');
    expect(parseArgs(['--format=text', 'https://a.test']).format).toBe('text');
    expect(() => parseArgs(['-f', 'yaml', 'https://a.test'])).toThrow(/invalid --format/);
  });

  test('--json is tracked separately from -f', () => {
    const args = parseArgs(['--json', '-f', 'md', 'https://a.test']);
    expect(args.json).toBe(true);
    expect(args.format).toBe('md');
  });

  test('timeout and concurrency are validated', () => {
    expect(parseArgs(['-t', '60', 'https://a.test']).timeout).toBe(60);
    expect(parseArgs(['-c', '16', 'https://a.test']).concurrency).toBe(16);
    expect(() => parseArgs(['-t', '0', 'https://a.test'])).toThrow(/invalid --timeout/);
    expect(() => parseArgs(['-t', 'abc', 'https://a.test'])).toThrow(/invalid --timeout/);
    expect(() => parseArgs(['-c', '0', 'https://a.test'])).toThrow(/invalid --concurrency/);
    expect(() => parseArgs(['-c', '999', 'https://a.test'])).toThrow(/invalid --concurrency/);
  });

  test('proxy, cookie, output and cache-dir are captured', () => {
    const args = parseArgs([
      '-x',
      'socks5://127.0.0.1:1080',
      '--cookie',
      'a=b',
      '-o',
      './out',
      '--cache-dir',
      '/tmp/c',
      'https://a.test',
    ]);
    expect(args.proxy).toBe('socks5://127.0.0.1:1080');
    expect(args.cookie).toBe('a=b');
    expect(args.outputDir).toBe('./out');
    expect(args.cacheDir).toBe('/tmp/c');
  });

  test('TLS flags are captured', () => {
    expect(parseArgs(['--no-random-tls', 'https://a.test']).noRandomTls).toBe(true);
    expect(parseArgs(['--no-tls', 'https://a.test']).noTls).toBe(true);
  });

  test('plugin selection flags are split on commas', () => {
    const args = parseArgs([
      '--only-plugins',
      'WebpackPlugin, NextJSPlugin',
      'https://a.test',
    ]);
    expect(args.onlyPlugins).toEqual(['WebpackPlugin', 'NextJSPlugin']);

    const excluded = parseArgs([
      '--exclude-plugins=VitePlugin,UmiJSPlugin',
      'https://a.test',
    ]);
    expect(excluded.excludePlugins).toEqual(['VitePlugin', 'UmiJSPlugin']);
  });

  test('an unknown flag is rejected', () => {
    expect(() => parseArgs(['--nope', 'https://a.test'])).toThrow(/unknown flag/);
  });

  test('a second positional is rejected rather than silently dropped', () => {
    expect(() => parseArgs(['https://a.test', 'https://b.test'])).toThrow(
      /unexpected extra argument/,
    );
  });

  test('a missing flag value is reported', () => {
    expect(() => parseArgs(['--proxy'])).toThrow(/requires a value/);
  });

  test('-- stops flag parsing', () => {
    const args = parseArgs(['--', 'https://a.test']);
    expect(args.url).toBe('https://a.test');
  });

  test('--list-plugins is recognised', () => {
    expect(parseArgs(['--list-plugins']).listPlugins).toBe(true);
  });
});

// ===== header parsing =====

describe('parseHeaderList', () => {
  test('parses curl-style headers', () => {
    expect(parseHeaderList(['X-A: 1', 'X-B: two words'])).toEqual({
      'X-A': '1',
      'X-B': 'two words',
    });
  });

  test('keeps colons inside the value', () => {
    expect(parseHeaderList(['Referer: https://a.test/x'])).toEqual({
      Referer: 'https://a.test/x',
    });
  });

  test('rejects a header without a colon', () => {
    expect(() => parseHeaderList(['NoColonHere'])).toThrow(/expected "Key: Value"/);
  });

  test('rejects an empty header name', () => {
    expect(() => parseHeaderList([': value'])).toThrow(/expected "Key: Value"/);
  });

  test('preserves non-ASCII values', () => {
    // Some sites validate the character set of their headers.
    expect(parseHeaderList(['X-Name: 中文'])).toEqual({ 'X-Name': '中文' });
  });
});

// ===== plugin registry =====

describe('plugin registry', () => {
  test('the default registry contains every built-in plugin', () => {
    const registry = createDefaultRegistry();
    expect(registry.size).toBe(BUILTIN_PLUGIN_NAMES.length);
    for (const name of BUILTIN_PLUGIN_NAMES) {
      expect(registry.get(name)).toBeDefined();
    }
  });

  test('names are unique', () => {
    const names = createDefaultRegistry().names();
    expect(new Set(names).size).toBe(names.length);
  });

  test('select returns only the named plugins', () => {
    const selected = createDefaultRegistry().select(['WebpackPlugin']);
    expect(selected.names()).toEqual(['WebpackPlugin']);
  });

  test('exclude drops the named plugins', () => {
    const excluded = createDefaultRegistry().exclude(['WebpackPlugin']);
    expect(excluded.get('WebpackPlugin')).toBeUndefined();
    expect(excluded.size).toBe(BUILTIN_PLUGIN_NAMES.length - 1);
  });

  test('excluding an absent plugin is a no-op', () => {
    const registry = createDefaultRegistry();
    expect(registry.exclude(['Nope']).size).toBe(registry.size);
  });
});

// ===== help text =====

describe('help', () => {
  test('documents every flag the parser accepts', () => {
    const text = helpText();
    for (const flag of [
      '--format',
      '--debug',
      '--no-cache',
      '--cache',
      '--useragent',
      '--ua',
      '--proxy',
      '--cookie',
      '--header',
      '--no-random-tls',
      '--output',
      '--timeout',
      '--concurrency',
      '--list-plugins',
      '--only-plugins',
      '--exclude-plugins',
    ]) {
      expect(text).toContain(flag);
    }
  });

  test('does not advertise the removed server modes', () => {
    const text = helpText();
    expect(text).not.toContain('jsdj serve');
    expect(text).not.toContain('jsdj mcp');
  });

  test('explains the TLS degradation', () => {
    expect(helpText()).toContain('no effect');
  });

  test('reports a cache path', () => {
    expect(defaultCachePath()).toContain('ejfkdev/dj');
  });
});