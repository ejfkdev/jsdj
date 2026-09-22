# Contributing

Thanks for taking the time. This document covers the things that are not obvious from
reading the code.

## Getting set up

```bash
git clone https://github.com/ejfkdev/jsdj.git
cd jsdj

npm install          # or bun install
npm run verify       # typecheck + build + browser check + tests
```

`npm run verify` is the same chain CI runs, so a green local run means a green CI run.

| Command | What it does |
|---|---|
| `bun test` | Run the test suite (~250 tests, under a second) |
| `bun test test/pipeline.test.ts` | Run one file |
| `npm run typecheck` | `tsc --noEmit` under `strict` and `noUncheckedIndexedAccess` |
| `npm run build` | Emit `dist/` (the published artifact) |
| `npm run check:browser` | Fail if the browser entry statically imports a Node builtin |
| `npm run verify` | All of the above |

Tests run under [Bun](https://bun.sh) because it is much faster on a `.ts` suite, but
**the library and CLI are plain Node ESM** — no Bun API is used in `src/`, and nothing
in the published package depends on Bun. Keep it that way.

## Project layout

```
src/
├── index.ts            Node entry point — every public export
├── browser.ts          Browser entry point (no filesystem, no Node builtins)
├── scan.ts             The `scan()` facade: assemble transport + storage + plugins
├── scan-options.ts     `ScanOptions`
├── sourcemap/          Source map parsing and source restoration (platform-neutral)
├── fetcher/            HTTP transport, storage, cookies, proxy, TLS sidecar
├── extractor/          Pipeline, plugin contract, URL/content helpers, output
├── plugins/            26 plugins, one loading scheme each
└── cli/                Argument parsing, help text, entry point
examples/               Six runnable examples plus a shared fixture site
scripts/                Repo tooling
test/                   The test suite
```

Two rules keep the platform split honest:

1. **`src/browser.ts` must not reach a Node builtin through a static import.** Put
   Node-only code behind a dynamic `import()` inside a function body, as
   `fetcher/fs-storage.ts` does. `npm run check:browser` enforces this.
2. **Node-specific modules are imported lazily from `scan.ts`**, so a browser bundle
   never contains them.

## Writing a plugin

A plugin is three members and no I/O:

```ts
const plugin = {
  name: 'MyPlugin',

  // Cheap filter. Called for every plugin on every fetched resource — a scan of a
  // large site runs tens of thousands of these, so keep it narrow.
  precheck(input, context) {
    return input.contentType === 'js' && (input.text ?? '').includes('my-marker');
  },

  // Pattern matching. Return findings; a throw is caught and logged as a plugin
  // failure, so only throw on a real bug.
  analyze(input, context) {
    const urls = [];
    for (const match of (input.text ?? '').matchAll(/.../g)) {
      urls.push({ url: match[1], fromUrl: input.sourceUrl });
    }
    return { urls };
  },
};
```

`input` gives you `sourceUrl`, `contentType`, `content` (bytes) and `text` (decoded once
and shared — use it rather than decoding again).

`context` is read-only accumulated state: `knownPaths` (URLs confirmed to exist),
`prependUrls` (prefixes for resolving bare filenames) and `publicPaths`.

Return one of:

| Field | Meaning |
|---|---|
| `urls` | Fetchable URLs, queued immediately |
| `probeTargets` | Path fragments, resolved against known URLs |
| `publicPaths` | `publicPath` values, used as prefixes later |
| `prependUrls` | URL prefixes for resolving bare filenames |
| `intermediates` | Manifests to fetch and re-dispatch (subject to the crawl budget) |
| `inlineScripts` | Inline bodies to analyse as JS, with the document as base URL |
| `probeRequests` | Requests for data not in the page (a `RSC: 1` probe) |

The distinction between `urls` and `probeTargets` matters: a webpack runtime names its
chunks without a host, so a plugin that knows the reference is a path reports a fragment
and lets the pipeline match it against a known-good directory.

Register it with `PluginRegistry`, or add it to `createDefaultRegistry()`. See
[`examples/04-fine-grained`](./examples/04-fine-grained) for a worked example.

### Three things that bite

**Regenerate `/g` regexes per call.** A global regex carries `lastIndex`, so reusing one
instance across inputs silently skips matches. Every plugin does
`new RegExp(pattern.source, 'g')` per invocation for this reason — see
`forEachMatch` in `plugins/helpers.ts`.

**Cap unbounded output.** A page's navigation can list far more pages than the crawl
budget allows. `MAX_MICRO_APP_ENTRIES` exists because one page's 139 candidates consumed
a 64-page budget before the pages it linked to were fetched, and their scripts were lost.

**Do not share a `name`.** It is the provenance identifier, and it appears in
`jsDetails.fromPlugin`, `meta.json` and the CLI's `--only-plugins`.

## Testing

The suite is behavioural rather than unit-test-per-function: it runs the pipeline
against a scripted HTTP client and asserts what was discovered. `test/pipeline.test.ts`
is the place to start.

Some conventions worth following:

- **Assert the *set*, not the count**, where the count alone could pass for the wrong
  reason.
- **Pin behaviour that looks like a bug** with a comment saying why. Several places
  deliberately reproduce a quirk of the Go original, and a future reader will otherwise
  "fix" it. The comments in `src/` flag those places explicitly.
- **When a fixed-size budget meets concurrent work, admit in a sorted order** derived
  from the input. `test/determinism.test.ts` covers this; if you touch admission
  ordering, assert the fixture actually reaches the budget or the test passes without
  exercising the path.

## Commits and pull requests

- One logical change per commit. A message that says *why* is worth more than one that
  restates the diff.
- Run `npm run verify` before opening a PR; CI runs the same thing.
- For a behaviour change, say which site or fixture showed the problem, and what the
  before/after URL sets were. "It finds more now" is hard to review; "`tsinghua.edu.cn`
  went from 25 to 36 URLs" is not.
- Adding a plugin? Add it to `createDefaultRegistry()` and to
  `BUILTIN_PLUGIN_NAMES`, and note in the PR what it recognises that the existing set
  does not.

## Release process

Releases are tag-driven:

1. Bump `version` in `package.json` and commit it.
2. Tag `vX.Y.Z` and push the tag.
3. `.github/workflows/release.yml` verifies the tag matches `package.json`, runs the
   full check, publishes to npm with provenance, and creates a GitHub release with
   generated notes.

## License

By contributing you agree your work is licensed under [MPL-2.0](./LICENSE).
