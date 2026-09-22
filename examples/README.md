# Examples

Runnable examples for jsdj, from a one-line `npx` call to a browser page. Each
directory has its own README and installs the package from the parent, so these are
real installs rather than path aliases into the source.

## The shared fixture

Most examples scan a small site that lives in [`fixture-site/`](./fixture-site). It
needs no dependencies:

```bash
node fixture-site/serve.mjs        # http://127.0.0.1:18080/
```

It is deliberately built to exercise the interesting paths:

| Feature | What it exercises |
|---|---|
| A webpack runtime with a static chunk map | `WebpackPlugin`, and the `urls` / `probeTargets` split |
| `import()` calls in two bundles | `DynamicImportPlugin`, transitive discovery |
| `<script src>`, `modulepreload`, `prefetch` | `HTMLScriptPlugin` |
| Two linked sub-pages | `HTMLPivotPlugin`, the crawl budget |
| A source map with `sourcesContent` | restoration, and content in the result |
| `/private-assets/` references | a custom plugin (in example 04) |

It scans to **11 JS URLs and 3 restored sources**. That number is the expected result
throughout these examples, so a mismatch means something changed.

## The examples

| Directory | What it shows |
|---|---|
| [`01-npx-cli`](./01-npx-cli) | The CLI via `npx` / `bunx` — every flag, formats, exit codes |
| [`02-library-basics`](./02-library-basics) | `scan()`, the result shape, restored sources, rendering |
| [`03-custom-transport`](./03-custom-transport) | Injecting your own HTTP transport, cookies, TLS fingerprinting |
| [`04-fine-grained`](./04-fine-grained) | One plugin, one source map, one URL helper, a custom registry |
| [`05-http-service`](./05-http-service) | A scan endpoint: jobs, concurrency limits, cancellation, caching |
| [`06-browser`](./06-browser) | A real page: OPFS storage, injected transport, CORS reality |

Suggested order: **01 → 02** for the basics, then whichever matches your use case.
**03** and **04** are the two that show what "usable as a library" actually means
here — injectable transport and individually callable pieces.

## Running them

Each directory is independent:

```bash
cd 02-library-basics
npm install
node index.mjs
```

Two need the fixture running (01, 02, 03, 04, 05 target it), and 05 additionally runs
its own service. 06 serves its own page.

## What building these found

Writing examples against a library is an effective way to find its bugs. Six issues
surfaced, all in the injection and option paths — the parts a CLI never exercises:

- **An injected transport lost the entire browser header set.** It received only the
  caller's extra headers, so a custom transport sent a bare request that anti-bot
  systems reject. `Fetcher` now composes the defaults for an injected client.
- **Cookies were silently dropped with an injected transport.** The jar lived inside
  the built-in clients, which an injected one has not got, so `cookie` did nothing.
  `Fetcher` now owns a jar for that case and adds the `Cookie` header itself.
- **The cache options were ignored when you supplied your own storage.** `noCache`
  and `cache: false` returned early on an explicit store, making them inert for
  exactly the caller most likely to want them.
- **`noCache` also suppressed writes.** It should mean "go to the network, still save
  what you fetched" — the reference CLI's `--no-cache` — or a forced rescan throws
  away the artifacts it just downloaded.
- **`getHeader` was not actually case-insensitive.** It only looked up a
  lower-cased key, so a transport passing the server's original `Content-Type`
  through got `''` back, silently breaking content classification.
- **An unreachable entry page produced an empty successful result.** A CORS block, a
  DNS failure and a site with no JavaScript were indistinguishable. The scan now
  raises `EntryFetchError` for a failed or non-2xx entry page, while an abort is
  rethrown unchanged and a failure on a *discovered* URL stays non-fatal.

Each has a regression test, and the tests that asserted the old behaviour were
updated with a note on why.