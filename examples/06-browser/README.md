# Example: jsdj in the browser

A real page running the real pipeline. It was driven in Chrome to verify this, and
the result matched the Node CLI exactly — same 11 URLs, same 3 restored sources.

## Setup

```bash
npm install
npm run build          # bundles app.js -> dist/app.js with bun
node serve.mjs         # serves the page *and* a CORS proxy
```

Then open <http://127.0.0.1:3001/>.

The scan target is the shared fixture; start it too:

```bash
node ../fixture-site/serve.mjs
```

## The three platform differences

Everything else is identical to Node — the same pipeline, the same 26 plugins, the
same source map restoration. Three things are not, and the example is built around
them.

### 1. No filesystem, so you supply the storage

The browser entry defaults to no caching. To get cache reuse you implement `Storage`,
which is five async methods. `app.js` implements it on **OPFS** — a real filesystem
inside the origin's sandbox, so the layout mirrors the Node cache exactly:

```
jsdj/http_example.test_/
├── js/          example.test-a.js, example.test-b.js
├── html/        web.html
├── source_map/
└── meta.json
```

Verified in the browser: the cold scan took 20ms, the warm scan 3ms, and inspecting
OPFS showed that tree on disk. A `meta.json` replay works exactly as it does on Node.

OPFS is preferred over IndexedDB for file-shaped data because the code that walks a
`sources/` tree is the same code as on Node. The implementation falls back to
`MemoryStorage` when OPFS is unavailable (private browsing, some webviews) rather
than failing — the scan still works, it just does not persist.

### 2. No TLS fingerprinting, ever

A page cannot control its own TLS handshake. `tlsFingerprint` is accepted and inert,
so one options object works on both platforms. There is no error, because a browser
lacking a capability is not a mistake.

### 3. CORS applies

This is the one that shapes the architecture. A page cannot read a cross-origin
response the target did not opt into, so scanning an arbitrary site from a browser
requires routing requests through an origin you control.

`serve.mjs` provides a minimal `/proxy?url=` for that, and the page's injected
transport talks to it — which is precisely what the injectable transport exists for.

## Three ways to run it

| Button | What it does |
|---|---|
| **Offline demo** | An injected transport answering from a fixed map. No server, no CORS, whole pipeline. |
| **Scan via proxy** | Reaches the real fixture through this page's own origin. 32 proxy requests, 11 URLs. |
| **Scan directly** | Demonstrates the CORS failure, on purpose. |

### The CORS failure is reported, not hidden

Worth reading in the console, because the behaviour here changed as a result of
building this example. A direct cross-origin scan throws:

```
EntryFetchError: could not fetch http://127.0.0.1:18080/: request failed: Failed to fetch
```

It does **not** resolve with `{ jsCount: 0 }`. That distinction matters: a CORS
block, a DNS failure, an unreachable host and a site with no JavaScript all produce
zero discovered URLs, so a resolved empty result is indistinguishable between them.
The scan now raises when the entry page cannot be fetched, and a non-2xx entry page
is likewise an error. An abort is rethrown unchanged, since a caller's own
cancellation is not a fetch failure.

## Notes

**The bundle has no static Node imports.** Bundling with `--target browser` pulls in
49 modules, and the only `node:` reference is a lazy `import('node:fs/promises')`
inside `FsStorage`'s `fs()` method — reachable only if a caller constructs an
`FsStorage`, which the browser entry does not export.

**`maxInlineSources` matters more here.** A browser holds the whole result in memory,
so the example caps it at 50 for the proxied path. The files are still written to
OPFS; only the in-memory copy is limited.

**The proxy forwards GET and HEAD only.** A scanning proxy should not be a
general-purpose request forwarder — that is an open proxy. Only `content-type` is
relayed back with the body, deliberately: copying every response header would bring
`set-cookie` into your origin, and content classification needs only the content type.

## What was verified in Chrome

- OPFS storage detected and used; the cache tree inspected on disk afterwards
- `detectRuntime()` returns `browser`
- Cold scan 20ms, warm scan 3ms, same result both times
- Proxied scan of the fixture: 32 requests, 11 URLs, 3 restored sources
- **Browser output identical to the Node CLI** — diffed, no differences
- Direct cross-origin scan raises `EntryFetchError` with the CORS cause