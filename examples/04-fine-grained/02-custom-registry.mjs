/**
 * Composing a plugin registry.
 *
 * A scan runs every plugin whose `precheck` passes. Sometimes you want a subset:
 * to cut noise, to focus on one loading scheme, to skip a slow plugin, or to add
 * your own.
 *
 * There are three ways to shape the set — `plugins`, `onlyPlugins`,
 * `excludePlugins` — plus the option of building a registry by hand and adding a
 * custom plugin to it.
 */

import { scan, MemoryStorage, PluginRegistry, createDefaultRegistry, BUILTIN_PLUGIN_NAMES } from 'jsdj';

const target = process.argv[2] ?? 'http://127.0.0.1:18080/';

// ===== What is available =====

console.log('The built-in plugin set');
console.log('─'.repeat(66));
console.log(`  ${BUILTIN_PLUGIN_NAMES.length} plugins:`);
const names = [...BUILTIN_PLUGIN_NAMES];
for (let i = 0; i < names.length; i += 2) {
  console.log(`    ${names[i].padEnd(32)} ${names[i + 1] ?? ''}`);
}
console.log();

// The names are the public identifiers: they appear in a result's provenance, in
// `meta.json`, and in the CLI's `--only-plugins`. They match the reference
// implementation's spelling, so they are stable.
console.log(`  These names are the identifiers you pass to the options below, and the`);
console.log(`  strings you will see in a result's \`fromPlugin\` field.`);
console.log();

// ===== onlyPlugins / excludePlugins =====

console.log('Narrowing with onlyPlugins');
console.log('─'.repeat(66));

// With only the webpack plugin, nothing is found. That is not a bug: a plugin sees
// content it is handed, and the webpack plugin is handed nothing, because the page's
// `<script src>` — the thing that leads to the runtime — is found by the HTML
// plugin. Plugins are chained through the URLs they discover, so a registry has to
// include the entry points of the chain it needs.
const webpackOnly = await scan({
  url: target,
  storage: new MemoryStorage(),
  onlyPlugins: ['WebpackPlugin'],
});

console.log(`  onlyPlugins: ['WebpackPlugin']  -> ${webpackOnly.summary.jsCount} URLs`);
console.log();

console.log('  Nothing found, and the reason is worth seeing: a plugin only sees content');
console.log('  it is handed. The webpack runtime is reached via the page\'s <script src>,');
console.log('  which the HTML plugin finds — so without that plugin the runtime is never');
console.log('  fetched and the chunk map is never parsed. Discovery is a chain.');
console.log();

// Including the HTML plugin as well gives the chain its entry point.
const entryPlusWebpack = await scan({
  url: target,
  storage: new MemoryStorage(),
  onlyPlugins: ['HTMLScriptPlugin', 'WebpackPlugin'],
});

console.log(`  onlyPlugins: ['HTMLScriptPlugin', 'WebpackPlugin'] -> ${entryPlusWebpack.summary.jsCount} URLs`);
for (const detail of entryPlusWebpack.jsDetails) {
  console.log(`      ${(detail.fromPlugin ?? '?').padEnd(20)} ${detail.url}`);
}
console.log();
console.log('  Now the runtime is fetched and its chunk map is read. Note that the');
console.log('  runtime\'s own dynamic imports are missing — those need');
console.log('  DynamicImportPlugin. Each plugin you drop removes part of the chain.');
console.log();

console.log('Narrowing with excludePlugins');
console.log('─'.repeat(66));

const withoutWebpack = await scan({
  url: target,
  storage: new MemoryStorage(),
  // The generic fallback also matches the chunk map, so excluding only the
  // webpack plugin does not remove those URLs. See the note below.
  excludePlugins: ['WebpackPlugin'],
});

console.log(`  excludePlugins: ['WebpackPlugin']  -> ${withoutWebpack.summary.jsCount} URLs`);
console.log('  Excluding one plugin barely changes the total, because the others still');
console.log('  find most of the same URLs by different routes.');
console.log();

// This is worth understanding before using exclusions to reduce output: plugins
// overlap by design. The generic fallback exists precisely so that a loading scheme
// no specific plugin recognises still gets caught.
const stillWebpack = withoutWebpack.jsDetails.filter((d) => d.url.includes('ce0cc4f'));
console.log('  Plugins overlap by design');
console.log('─'.repeat(66));
console.log('  The fixture chunk `10-ce0cc4f.js` is still found after excluding');
console.log('  WebpackPlugin, because `UniversalURLPlugin` is a generic fallback that');
console.log('  matches the same pattern. That plugin exists so an unrecognised loader');
console.log('  still gets caught, and it runs alongside the specific ones rather than');
console.log('  after them.');
console.log();
if (stillWebpack.length > 0) {
  console.log(`  Found by: ${stillWebpack.map((d) => d.fromPlugin).join(', ')}`);
  console.log();
}
console.log('  To actually remove those URLs, exclude the fallback too:');
const bare = await scan({
  url: target,
  storage: new MemoryStorage(),
  excludePlugins: ['WebpackPlugin', 'UniversalURLPlugin'],
});
console.log(`    excludePlugins: ['WebpackPlugin', 'UniversalURLPlugin'] -> ${bare.summary.jsCount} URLs`);
const chunkUrls = bare.jsUrls.filter((u) => /-(ce0cc4f|aa11bb2|ff00ee1)\.js$/.test(u));
console.log(`    of which chunk-map URLs: ${chunkUrls.length} (was 3 before excluding both)`);
console.log();

// ===== An unknown name is an error =====

console.log('An unknown plugin name');
console.log('─'.repeat(66));
try {
  await scan({
    url: target,
    storage: new MemoryStorage(),
    onlyPlugins: ['NotAPlugin'],
  });
  console.log('  (unexpectedly succeeded)');
} catch (err) {
  // `onlyPlugins` validates, because a typo in an allow-list silently producing an
  // empty scan is worse than a loud failure. `excludePlugins` does not, since
  // excluding a plugin that is not present is a harmless no-op.
  console.log(`  onlyPlugins  -> throws: ${err.message.slice(0, 60)}…`);
}

const excluded = await scan({
  url: target,
  storage: new MemoryStorage(),
  excludePlugins: ['NotAPlugin', 'AlsoNotAPlugin'],
});
console.log(`  excludePlugins -> no error, ${excluded.summary.jsCount} URLs found`);
console.log();

// ===== Building a registry by hand =====

console.log('A registry built by hand');
console.log('─'.repeat(66));

// `createDefaultRegistry()` returns a fresh registry, so mutating it with
// `register` does not affect any other scan.
const trimmed = createDefaultRegistry().exclude(['UmiJSPlugin']);
console.log(`  createDefaultRegistry().exclude(['UmiJSPlugin']).size = ${trimmed.size}`);
console.log(`  createDefaultRegistry().size                          = ${createDefaultRegistry().size}`);
console.log();

// Or select explicitly, which throws on an unknown name for the same reason
// `onlyPlugins` does.
const selected = createDefaultRegistry().select(['HTMLScriptPlugin', 'DynamicImportPlugin']);
console.log(`  select(['HTMLScriptPlugin','DynamicImportPlugin']) -> ${selected.names().join(', ')}`);
console.log();

// ===== Adding a custom plugin =====

// A plugin is three members. This one recognises a path prefix that no specific
// built-in plugin knows about.
//
// An honest note before the code: the generic fallback, `UniversalURLPlugin`,
// already matches any quoted `.js` path, so it finds these URLs too. A custom plugin
// earns its place when it knows something the fallback does not — how to *resolve* a
// reference, or which of many matches are real. This one does the resolving
// explicitly, and the example runs it with the fallback excluded so you can see it
// working alone.
const PRIVATE_ASSETS = /["'](\/private-assets\/[^"']+\.js)["']/g;

const privateAssetsPlugin = {
  name: 'PrivateAssetsPlugin',

  // A cheap test. Returning false skips `analyze` entirely, so it should be the
  // narrowest check that still covers every case analyze handles.
  precheck(input) {
    return input.contentType === 'js' && (input.text ?? '').includes('/private-assets/');
  },

  analyze(input) {
    const urls = [];
    const seen = new Set();

    // Regenerate the regex per call: a `/g` pattern carries `lastIndex`, so reusing
    // one across inputs would skip matches.
    for (const match of (input.text ?? '').matchAll(new RegExp(PRIVATE_ASSETS.source, 'g'))) {
      const path = match[1];
      if (path === undefined || seen.has(path)) {
        continue;
      }
      seen.add(path);
      urls.push({
        // Resolve against the document the reference was found in, which is the
        // part a generic matcher cannot do — it reports a bare path and leaves
        // placement to the pipeline.
        url: new URL(path, input.sourceUrl).toString(),
        fromUrl: input.sourceUrl,
        isInline: false,
      });
    }

    return { urls };
  },
};

// Start from the full default set rather than an empty registry. The chaining
// described above means a minimal registry cannot reach much: the bundles holding a
// custom reference are themselves discovered by other plugins. The generic fallback
// is excluded so the custom plugin's contribution is its own.
const customRegistry = createDefaultRegistry()
  .exclude(['UniversalURLPlugin'])
  .register(privateAssetsPlugin);

const withCustom = await scan({
  url: target,
  storage: new MemoryStorage(),
  plugins: customRegistry,
});
console.log(`  custom plugin + default set, fallback excluded -> ${withCustom.summary.jsCount} URLs`);
console.log();

const customFound = withCustom.jsDetails.filter((d) => d.fromPlugin === 'PrivateAssetsPlugin');
console.log(`  Found by the custom plugin: ${customFound.length}`);
for (const detail of customFound) {
  console.log(`      ${detail.url}`);
  console.log(`          referenced in ${detail.fromUrl}`);
}
console.log();
console.log('  A custom plugin reports its own provenance, so `fromPlugin` still');
console.log('  explains every URL. Register it under the same name across scans and');
console.log('  results stay comparable.');
console.log();

console.log('Choosing between the three options');
console.log('─'.repeat(66));
console.log('  plugins         a whole registry you built — for a custom plugin, or a');
console.log('                  fixed set you control');
console.log('  onlyPlugins     a subset by name, validated — for a focused scan');
console.log('  excludePlugins  everything except these, lenient — for cutting noise');
console.log();
console.log('  `plugins` wins if both it and a name list are given.');