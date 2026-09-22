# Example: the fine-grained API

`scan()` is a convenience wrapper. Everything beneath it is exported, so you can use
one piece without the rest — run a single plugin over content you already have,
parse a source map, resolve a URL, build your own plugin registry.

## Setup

```bash
npm install
node ../fixture-site/serve.mjs      # in another terminal
```

## Run

```bash
node 01-single-plugin.mjs       # run one plugin over content you have
node 02-custom-registry.mjs     # select plugins, and write your own
node 03-sourcemap-standalone.mjs # parse maps and restore sources, no network
node 04-url-helpers.mjs         # the URL helpers, with the surprising cases
```

## What each script shows

**`01-single-plugin.mjs`** — a plugin is three members (`name`, `precheck`,
`analyze`) and no I/O. The script runs `WebpackPlugin`, `DynamicImportPlugin` and
`HtmlScriptPlugin` directly over strings, with a table showing how `precheck` filters
across plugins and inputs.

The key thing it makes concrete is the `urls` / `probeTargets` split: a plugin
reports either a fetchable URL or a path fragment it cannot place. A webpack chunk
builder produces paths, so the plugin reports fragments and lets the pipeline match
them against URLs already known to exist.

**`02-custom-registry.mjs`** — three ways to shape the plugin set (`plugins`,
`onlyPlugins`, `excludePlugins`), plus writing a plugin of your own.

It also documents two things that surprise people:

- **Discovery is a chain.** `onlyPlugins: ['WebpackPlugin']` finds *nothing*, because
  the webpack runtime is only reached via the page's `<script src>`, which the HTML
  plugin finds. Dropping a plugin can remove more than its own findings.
- **Plugins overlap.** Excluding `WebpackPlugin` barely changes the total, because
  `UniversalURLPlugin` matches most of the same patterns as a fallback.

**`03-sourcemap-standalone.mjs`** — the source map layer with no network involved:
both restoration modes, path normalisation (including a traversal that gets clamped),
the mappings string decoded segment by segment, and why invalid input is rejected
loudly.

**`04-url-helpers.mjs`** — about two dozen URL functions over the cases that actually
come up, including the ones that look like bugs until explained: why a bare origin
keeps no trailing slash, why `path.Clean` semantics matter, why
`isLikelyStaticResource` says yes to a `.json` path, and why assigning `url.host`
does not replace a port.

## Writing a plugin

The whole contract:

```js
const plugin = {
  name: 'MyPlugin',

  // Cheap filter. Called for every plugin on every fetched resource, so keep it
  // narrow — a scan of a large site runs tens of thousands of these.
  precheck(input, context) {
    return input.contentType === 'js' && (input.text ?? '').includes('my-marker');
  },

  // Pattern matching. Return findings; throw only on a real bug, since a throw is
  // caught and logged as a plugin failure.
  analyze(input, context) {
    const urls = [];
    for (const match of (input.text ?? '').matchAll(/.../g)) {
      urls.push({ url: match[1], fromUrl: input.sourceUrl });
    }
    return { urls };
  },
};
```

`input` gives you `sourceUrl`, `contentType`, `content` (bytes) and `text` (decoded
once and shared, so use it rather than re-decoding).

`context` is read-only accumulated state: `knownPaths` (URLs confirmed to exist),
`prependUrls` (prefixes for resolving bare filenames) and `publicPaths`. A plugin
that needs to place a fragment uses these; a standalone call passes empty arrays.

The result fields:

| Field | Meaning |
|---|---|
| `urls` | Fetchable URLs, queued immediately |
| `probeTargets` | Path fragments, resolved against known URLs |
| `publicPaths` | `publicPath` values, used as prefixes later |
| `prependUrls` | URL prefixes for resolving bare filenames |
| `intermediates` | Manifests to fetch and re-dispatch (subject to the crawl budget) |
| `inlineScripts` | Inline bodies to analyse as JS, with the document as base URL |
| `probeRequests` | Requests to issue for data not in the page (a `RSC: 1` probe) |

## Notes

**Regenerate `/g` regexes per call.** A global regex carries `lastIndex`, so reusing
one instance across inputs silently skips matches. Every built-in plugin does
`new RegExp(pattern.source, 'g')` per invocation for this reason.

**Two plugins must not share a `name`.** The name is the provenance identifier and
appears in `jsDetails.fromPlugin`, `meta.json` and the CLI's `--only-plugins`.
Registering two plugins under one name replaces the first.

**`onlyPlugins` validates, `excludePlugins` does not.** A typo in an allow-list would
otherwise produce an empty scan silently; excluding a plugin that is not present is a
harmless no-op.