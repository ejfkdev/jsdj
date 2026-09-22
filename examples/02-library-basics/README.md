# Example: jsdj as a library

Three scripts showing the ordinary library use: scan a site, work with the restored
sources, and render your own output.

## Setup

```bash
# once
npm install

# in another terminal, leave running
node ../fixture-site/serve.mjs
```

`npm install` pulls jsdj from the parent directory (`file:../..`), so it installs
the real package — not a path alias, and not a copy of the source.

## Run

```bash
node index.mjs        # scan a site and print everything it found
node sources.mjs      # work with the restored source content
node formats.mjs      # render Markdown / JSON / text yourself
```

Or pass a different target:

```bash
node index.mjs https://example.com
```

## What each script shows

**`index.mjs`** — the whole result shape: counts, the JS URL list, per-URL
provenance (which plugin found it, in which document), the restored sources with
their content, and the source maps.

**`sources.mjs`** — treating the restored sources as a project. It groups them by
directory, scans the content for markers (credentials, debug flags, TODO, internal
URLs), reports file and line numbers, and concatenates the tree into one document.
The same shape works for any static analysis you want to run over someone else's
frontend code.

**`formats.mjs`** — rendering. `formatMarkdown`, `formatJson` and `formatText` are
the same functions the CLI uses, so a service produces identical output without
shelling out. The script also builds a custom report grouped by discovering plugin,
which is the kind of thing the built-in renderers do not do.

## Notes

**`maxInlineSources`.** By default up to 2000 restored source files come back with
their content, which keeps a library caller from needing the filesystem. Lower it —
or set `0` — when you do not want the text: `formats.mjs` passes `0`. The files are
still written by a file-backed cache and `summary.sourceCount` stays accurate; only
the in-memory copy is skipped.

**Storage.** These scripts pass `MemoryStorage` so they leave nothing behind and give
the same result every run. Omit `storage` on Node and you get the file cache under
the system temp directory, which is what makes a second run nearly instant — the
CLI section of this repo shows that.

**TypeScript.** The package ships `.d.ts` files, so `import { scan } from '@ejfkdev/jsdj'`
is typed with no extra setup and no `@types` package. The result type is
`ScanResult` if you want to name it:

```ts
import { scan, type ScanResult } from '@ejfkdev/jsdj';

const result: ScanResult = await scan({ url: 'https://example.com' });
```