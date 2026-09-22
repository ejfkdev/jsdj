# jsdj - Dynamic JS File Extractor

[中文](./README.zh.md) | English

[![npm](https://img.shields.io/npm/v/jsdj?style=flat-square)](https://www.npmjs.com/package/jsdj)
[![License](https://img.shields.io/badge/License-MPL%202.0-blue.svg?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/ejfkdev/jsdj/ci.yml?style=flat-square)](https://github.com/ejfkdev/jsdj/actions)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-20.11+-339933.svg?style=flat-square)](https://nodejs.org/)
[![Stars](https://img.shields.io/github/stars/ejfkdev/jsdj?style=flat-square)](https://github.com/ejfkdev/jsdj/stargazers)
[![Issues](https://img.shields.io/github/issues/ejfkdev/jsdj?style=flat-square)](https://github.com/ejfkdev/jsdj/issues)

`jsdj` extracts dynamically loaded JavaScript from a website by statically analysing
its HTML and JS: webpack chunks, `import()` lazy loading, framework manifests, and
more. It then finds the source maps and restores the original sources from them.

It is a TypeScript port of the Go tool [`dj`](https://github.com/ejfkdev/dj), preserving
its CLI surface while adding what a library needs — an injectable HTTP transport, a
pluggable cache, and restored source **content** rather than only paths.

## Features

- **Static analysis of dynamic loading** — `import()`, `require()`, `webpack` chunk
  maps, Vite preload, micro-frontend entries, and more across **26 plugins**
- **Source map restoration** — finds maps beside each bundle and recovers the original
  sources, preferring `sourcesContent` and falling back to `mappings` reconstruction
- **Library and CLI from one package** — `import { scan } from 'jsdj'`, or
  `npx jsdj <url>`
- **Node and browser** — the browser entry has no filesystem dependency; supply a
  `Storage` backend if you want cache reuse
- **Injectable HTTP transport** — replace the network layer with your own TLS stack,
  proxy, or recorder
- **TLS fingerprinting** — via an optional native sidecar, for sites that reject the
  handshake itself
- **Deterministic** — the same site produces the same URL set on every run
- **Cache reuse** — a second scan of the same site replays `meta.json` and skips the
  network

## Install

```bash
npm install jsdj        # or: pnpm add jsdj / bun add jsdj / yarn add jsdj
```

No runtime dependencies. TLS fingerprinting ships as an optional dependency; when it
is absent everything else still works.

## CLI

```bash
npx jsdj https://example.com              # or: bunx jsdj https://example.com
```

```bash
jsdj <url> [options]              scan a website
jsdj scan <url> [options]         same, canonical form
jsdj version                      print version
jsdj --list-plugins               list the built-in plugins
```

| Option | Description |
|--------|-------------|
| `-f, --format <fmt>` | Output format: `md` (default), `json`, `text` (bare URL list) |
| `--json` | Emit raw JSON instead of the rendered format |
| `-d, --debug` | Debug output on stderr |
| `--useragent <UA>`, `--ua <UA>` | Custom User-Agent (non-ASCII supported) |
| `-x, --proxy <URL>` | Proxy: `http://`, `https://`, `socks5://` |
| `--cookie <cookies>` | Cookies, e.g. `cf_clearance=...` to get past a bot check |
| `-H, --header <K: V>` | Extra header, repeatable; later values override earlier ones |
| `--no-random-tls` | Pin the TLS fingerprint to Chrome instead of randomising |
| `--no-tls` | Disable TLS fingerprinting entirely |
| `-o, --output <dir>` | Also write artifacts here, without the site subdirectory |
| `-t, --timeout <secs>` | Per-request timeout (default 30) |
| `-c, --concurrency <N>` | Max concurrent requests (default 8) |
| `--no-cache` | Skip cache reads; artifacts are still written |
| `--cache[=bool]` | Legacy form: `--cache=yes`, `--cache=false` |
| `--cache-dir <dir>` | Cache root (default `<tmpdir>/ejfkdev/dj`) |
| `--only-plugins <names>` | Run only these plugins (comma-separated) |
| `--exclude-plugins <names>` | Run everything except these |

Exit codes: `0` on success, `1` for a usage or runtime error.

```bash
jsdj -f json --cookie 'cf_clearance=xxx' https://example.com
jsdj -H 'Referer: https://google.com' -x socks5://127.0.0.1:7890 https://example.com
jsdj --only-plugins WebpackPlugin,NextJSPlugin https://example.com
```

## Library

```ts
import { scan } from 'jsdj';

const result = await scan({
  url: 'https://example.com',
  headers: { Referer: 'https://example.com' },
  cookie: 'cf_clearance=xxx',
  tlsFingerprint: 'chrome',
  concurrency: 8,
});

result.jsUrls;    // string[] — discovered JS URLs
result.jsDetails; // per-URL provenance: which plugin found it, from which document
result.sources;   // restored source files, with content
result.summary;   // { jsCount, sourceMapCount, sourceCount }
```

Restored sources come back as **content**, not just paths:

```ts
for (const file of result.sources) {
  console.log(file.path);    // 'src/App.tsx'
  console.log(file.content); // the original source
  console.log(file.mode);    // 'sourcesContent' | 'mappings'
  console.log(file.fromJs);  // which bundle it was restored from
}
```

### Injecting your own HTTP transport

The scan accepts a transport, so you can do your own TLS work, route through a proxy
you control, or record and replay requests in tests.

```ts
const result = await scan({
  url: 'https://example.com',
  transport: {
    async fetch(req) {
      // req: { url, method, headers }
      // `headers` arrives already composed: the browser default set, then your
      // `headers` option, then your cookies.
      const res = await myTlsStack(req.url, {
        method: req.method,
        headers: req.headers,
      });
      return {
        status: res.status,
        headers: res.headers,
        body: res.body,          // Uint8Array or string
        finalUrl: res.finalUrl,  // optional
      };
    },
  },
});
```

The function receives `GET` and `HEAD` requests, so it must honour `method` — jsdj
probes for source maps with `HEAD`. To replace the client wholesale instead, pass a
full `HttpClient` as `transport: { client }`.

Two semantics are worth knowing:

- **A transport failure must reject**, not resolve. jsdj retries rejections with
  backoff but treats a resolved response as final, so swallowing an error turns a
  transient failure into a permanent "not found".
- **A non-2xx status resolves normally.** `{ status: 404 }` is a result, not an error.

### Fine-grained API

`scan` is a convenience wrapper. Every layer beneath it is exported, so you can use one
piece without the rest:

```ts
import {
  // Discovery
  Pipeline, PluginRegistry, createDefaultRegistry, WebpackPlugin,
  // One URL, one request
  Fetcher,
  // Source maps
  parseSourceMap, restoreFiles, parseMappings, normalizeSourcePath,
  // URL and content helpers
  normalizeUrl, resolveRelativePath, expandComboLoader,
  decodeContent, detectContentKind, unwrapJsonp,
  // Transport and storage
  NodeHttpClient, BrowserHttpClient, MemoryStorage, NullStorage, FsStorage,
  // Output
  formatMarkdown, formatJson, formatText,
} from 'jsdj';
```

Running a single plugin over content you already have:

```ts
import { WebpackPlugin } from 'jsdj';

const plugin = new WebpackPlugin();
const input = {
  sourceUrl: 'https://example.com/runtime.js',
  contentType: 'js',
  content: new TextEncoder().encode(runtimeSource),
  text: runtimeSource,
};
const context = { publicPaths: [], prependUrls: [], knownPaths: [] };

if (plugin.precheck(input, context)) {
  const found = plugin.analyze(input, context);
  console.log(found.urls, found.probeTargets);
}
```

Restoring a source map you fetched yourself:

```ts
import { parseSourceMap, restoreFiles } from 'jsdj';

const map = parseSourceMap(mapJson);
const files = restoreFiles(map, minifiedJs); // minifiedJs optional
for (const f of files) {
  console.log(f.path, f.mode, f.content);
}
```

## Platform behaviour

| | Node | Browser |
|---|---|---|
| File cache | on by default, configurable | none — inject a `Storage` |
| TLS fingerprint | via the optional sidecar, else ignored | never available |
| Requests | any host | subject to CORS |

Nothing throws because a platform lacks a capability. `tlsFingerprint` is accepted and
ignored where it cannot apply; caching degrades to pass-through.

### TLS fingerprinting

Randomising the TLS ClientHello cannot be done from JavaScript — the handshake happens
inside the runtime. It requires a native transport, shipped as the optional dependency
**`@jsdj/tls-sidecar`**.

When that package is absent the CLI and library still work. The TLS options are
accepted and silently have no effect, so one options object works everywhere. This is
deliberate: a missing optional capability should not be an error, and a browser can
never have it.

### Browser use

```ts
import { scan, MemoryStorage } from 'jsdj/browser';

const result = await scan({
  url: 'https://example.com',
  storage: new MemoryStorage(), // or your own OPFS/IndexedDB store
});
```

A browser cannot scan arbitrary cross-origin sites: CORS blocks the requests. Supply a
`transport` that routes through an origin you control, which is what the injectable
transport is for. The browser entry exports the whole pipeline except the
filesystem-backed pieces, and importing it never pulls in a Node builtin.

## Caching

On Node the cache lives under the system temp directory:

```
<tmpdir>/ejfkdev/dj/<origin>/
├── js/            downloaded JS
├── source_map/    source maps
├── sources/       restored sources, original directory structure preserved
├── html/          the initial page
└── meta.json      site metadata
```

A second run over the same site replays `meta.json` and skips discovery entirely,
including reading the restored sources back from disk so the returned content matches a
cold run. On a large site that turns a minute of scanning into milliseconds.

Use `--no-cache` to force a full re-scan (artifacts are still written), or
`--cache-dir` to relocate the cache.

## How it works

1. Fetch the target page.
2. Run every applicable plugin over it in parallel. Each plugin is a pattern matcher
   for one loading scheme.
3. Plugins yield either absolute URLs to fetch next, or path fragments to resolve
   against URLs already known to exist — a webpack runtime names its chunks without a
   host, so the fragment is matched against a known-good directory.
4. Probe for source maps beside each bundle (`HEAD` first, since maps are usually
   absent).
5. Restore sources from each map: `sourcesContent` when present, otherwise reassemble
   from `mappings` and label the output as incomplete.
6. Report the JS URLs with full provenance.

Concurrency is bounded by a single semaphore shared across downloads, probes and `HEAD`
requests, so `--concurrency` is a real ceiling rather than a per-stage limit.

### Determinism

A scan is deterministic: the same site produces the same URL set on every run. The
crawler uses an awaitable work queue and admits work in an order derived from the input
rather than from completion order. Verified by `test/determinism.test.ts`.

### Verifying a scan

These sites are good smoke tests; each exercises a different loading scheme.

| Site | Loading scheme | URLs |
|---|---|---|
| `react.dev` | Vite + SPA routing | ~38 |
| `www.tsinghua.edu.cn` | Large multi-page site; the crawl budget binds | ~36 |
| `developer.mozilla.org` | Mostly server-rendered, few bundles | ~5 |
| `vuejs.org` | VitePress with many chunks | ~56 |

Counts are what the default settings find at the time of writing — they move as the
sites change. Every URL reported was checked to resolve; no false positives were found
on any of these sites.

## Plugins

26 plugins cover the loading schemes below. `jsdj --list-plugins` prints the names;
`--only-plugins` / `--exclude-plugins` select a subset.

| Plugin | Handles |
|--------|---------|
| `HTMLScriptPlugin` | `<script src>`, `modulepreload`, `prefetch`, inline scripts |
| `DynamicImportPlugin` | `import()` |
| `ESMImportPlugin` | static `import` / `from` |
| `ScriptCreatePlugin` | `createElement('script')`, `src =`, `new URL()` |
| `WebpackPlugin` | chunk maps, `publicPath`, `webpackChunk`, rspack, runtime fingerprints |
| `NextJSPlugin` | App/Pages Router chunks, `_buildManifest`, Turbopack, RSC flight data |
| `VitePlugin` | `__vitePreload`, `__vite__mapDeps`, build manifest |
| `NuxtJSPlugin` | `/_nuxt/` assets |
| `SvelteKitPlugin` | `/_app/immutable/` nodes and chunks |
| `RequireJSPlugin` | `data-main`, `require([...])`, `define([...])` |
| `ModuleFederationPlugin` | `remoteEntry.js`, sibling manifests |
| `ModuleFederationManifestPlugin` | standard and Vmok manifest shapes |
| `HelMicroPlugin` | component metadata documents |
| `EmpPlugin` | `emp.json` federation manifest |
| `ModernJSPlugin` | `_MODERNJS_ROUTE_MANIFEST` |
| `URLPatternPlugin` | protocol-relative CDN origins, quoted `.js` strings |
| `SourceMapPlugin` | `sourceMappingURL`, `X-SourceMap`, inline data URIs |
| `UmiJSPlugin` | Umi route manifest |
| `TrunkPlugin` | Rust/wasm-bindgen `sitemap.json` |
| `QiankunPlugin` | `entry` / `proEntry` sub-app HTML |
| `GarfishPlugin` | `apps[].entry` |
| `MicroAppPlugin` | `microApp.start` config |
| `WujiePlugin` | `startApp` config |
| `IcestarkPlugin` | `url` as a single value or array |
| `HTMLPivotPlugin` | same-origin links, iframes, quoted `.html` literals |
| `UniversalURLPlugin` | encoding-aware fallback for everything else |

Plugins overlap by design — the generic fallback runs alongside the specific ones — so
excluding one plugin does not always remove its findings. A single plugin's contribution
is capped at 50 entries, so one page with a very long link list cannot consume the whole
crawl budget before the pages it links to have been fetched.

Writing your own plugin: implement `name`, `precheck(input, context)` and
`analyze(input, context)`, then register it with `PluginRegistry`. See
[`examples/04-fine-grained`](./examples/04-fine-grained) for a worked example.

## Examples

Six runnable examples in [`examples/`](./examples), each installing the package from the
parent so they are real installs:

| Directory | What it shows |
|---|---|
| [`01-npx-cli`](./examples/01-npx-cli) | The CLI via `npx` / `bunx` — every flag, formats, exit codes |
| [`02-library-basics`](./examples/02-library-basics) | `scan()`, the result shape, restored sources, rendering |
| [`03-custom-transport`](./examples/03-custom-transport) | Injecting your own HTTP transport, cookies, TLS fingerprinting |
| [`04-fine-grained`](./examples/04-fine-grained) | One plugin, one source map, one URL helper, a custom registry |
| [`05-http-service`](./examples/05-http-service) | A scan endpoint: jobs, concurrency limits, cancellation, caching |
| [`06-browser`](./examples/06-browser) | A real page: OPFS storage, injected transport, CORS reality |

They share a dependency-free fixture site, so they run offline:

```bash
node examples/fixture-site/serve.mjs     # the scan target
cd examples/02-library-basics && npm install && node index.mjs
```

## Not included

- **No HTTP or MCP server.** Those came from dj's `xyz-go` framework and are out of
  scope; `serve` / `mcp` report that clearly instead of failing obscurely.
- **No native TLS fingerprint by default.** It ships as the optional
  `@jsdj/tls-sidecar`; without it, TLS options are accepted and ignored.

CLI flags, aliases, output layout, cache paths, exit codes and plugin names follow dj, so
an existing dj workflow transfers as-is. On top of that:

- **Restored source content is returned**, not only written to disk.
- **JSONP is classified explicitly** — a `.js` URL whose body is a JSONP callback is
  reported as `jsonp` rather than treated as JavaScript.
- **Debug output goes through an injectable logger.** The library is silent by default;
  the CLI sends it to stderr.

## Development

```bash
git clone https://github.com/ejfkdev/jsdj.git
cd jsdj

bun install         # or npm install
bun test            # 252 tests
npm run typecheck   # tsc --noEmit
npm run build       # tsc -> dist/
```

Requires Node 20.11+ and TypeScript 5.7+. Tests run under
[`bun test`](https://bun.sh/docs/cli/test) for speed, but the library and CLI are plain
Node ESM with no Bun dependency.

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the development workflow.

## License

[MPL-2.0](./LICENSE).
