/**
 * Running a single plugin over content you already have.
 *
 * `scan()` walks a site. A plugin walks a string. If you already have a bundle's
 * contents — from a proxy log, a downloaded file, a database — you can run the
 * detection over it directly, with no network and no pipeline.
 *
 * Every plugin is an object with three members:
 *
 *   name       the identifier recorded as provenance
 *   precheck   a cheap "could this apply?" test, so irrelevant plugins skip work
 *   analyze    the actual pattern matching
 *
 * Both methods take `(input, context)`. `input` is the content plus where it came
 * from; `context` is the read-only state a scan has accumulated (`knownPaths`,
 * `prependUrls`, `publicPaths`), which plugins consult to resolve relative
 * references.
 */

import { WebpackPlugin, DynamicImportPlugin, VitePlugin, NextJsPlugin, HtmlScriptPlugin, decodeContent } from 'jsdj';

// A read-only context. A standalone call has nothing accumulated yet, so an empty
// one is correct.
const emptyContext = { publicPaths: [], prependUrls: [], knownPaths: [] };

/** Build the input a plugin expects. `text` is decoded once and shared. */
function inputFor(sourceUrl, text, contentType = 'js') {
  return {
    sourceUrl,
    contentType,
    content: new TextEncoder().encode(text),
    text,
  };
}

// ===== A webpack runtime =====

// This is the shape a real runtime has: a chunk-URL builder with an inlined
// id-to-hash map, plus dynamic imports elsewhere in the bundle.
const webpackRuntime = `
__webpack_require__.u = function (e) {
  return "static/js/" + e + "-" + { 10: "ce0cc4f", 11: "aa11bb2" }[e] + ".js";
};
import("./lazy.js");
`;

console.log('Input');
console.log('─'.repeat(66));
console.log(webpackRuntime.trim());
console.log();

const webpack = new WebpackPlugin();
const webpackInput = inputFor('https://example.test/static/runtime.js', webpackRuntime);

console.log(`precheck: ${webpack.precheck(webpackInput, emptyContext)}`);
console.log();

const webpackResult = webpack.analyze(webpackInput, emptyContext);

console.log('urls — fetchable directly, host already known');
for (const found of webpackResult.urls ?? []) {
  console.log(`  ${found.url}`);
}
console.log();

console.log('probeTargets — fragments needing resolution against a known URL');
if ((webpackResult.probeTargets ?? []).length === 0) {
  console.log('  (none — the prefix was absolute enough to resolve)');
} else {
  for (const found of webpackResult.probeTargets) {
    console.log(`  ${found.url}`);
  }
}
console.log();

// The distinction is the important part of the plugin contract. A plugin says
// "here is a URL" or "here is a path fragment I cannot place" and lets the pipeline
// decide. `urls` are queued; `probeTargets` are matched against URLs already known
// to exist, which is how an unhosted fragment gets resolved.
console.log('Why the split matters');
console.log('─'.repeat(66));
console.log('  A chunk-URL builder produces paths, not URLs. The plugin cannot know');
console.log('  which host serves them, so it reports fragments and the pipeline');
console.log('  resolves them. Calling a plugin standalone, you decide yourself —');
console.log('  and `resolveFragment` on a Pipeline is available if you want the');
console.log('  pipeline\'s own resolution.');
console.log();

// ===== Dynamic imports, with a fragment =====

const bundle = `
  import("./chunk-home.js");
  import("./chunks/async/detail.js");
`;

const dynamic = new DynamicImportPlugin();
const bundleInput = inputFor('https://example.test/assets/app.js', bundle);

console.log('DynamicImportPlugin on a bundle with relative imports');
console.log('─'.repeat(66));
console.log(`precheck: ${dynamic.precheck(bundleInput, emptyContext)}`);
const dynamicResult = dynamic.analyze(bundleInput, emptyContext);
for (const found of [...(dynamicResult.urls ?? []), ...(dynamicResult.probeTargets ?? [])]) {
  console.log(`  ${found.url}`);
}
console.log();

// ===== Template literals are skipped =====

const withTemplate = `import(\`./widgets/\${name}.js\`);`;

console.log('Template literals are skipped, deliberately');
console.log('─'.repeat(66));
console.log(`  input:   ${withTemplate}`);
const templateResult = dynamic.analyze(
  inputFor('https://example.test/app.js', withTemplate),
  emptyContext,
);
console.log(`  found:   ${(templateResult.urls ?? []).length + (templateResult.probeTargets ?? []).length} (the value is not statically knowable)`);
console.log();

// ===== precheck as a filter =====

console.log('precheck exists to skip work');
console.log('─'.repeat(66));

const plugins = [
  ['WebpackPlugin', new WebpackPlugin()],
  ['VitePlugin', new VitePlugin()],
  ['NextJsPlugin', new NextJsPlugin()],
  ['DynamicImportPlugin', new DynamicImportPlugin()],
];

const samples = [
  ['a webpack runtime', webpackRuntime, 'js'],
  ['a Vite bundle', `__vitePreload(() => import("./x.js"));`, 'js'],
  ['an HTML page', `<!doctype html><script src="/a.js"></script>`, 'html'],
  ['plain text', `just some prose, no code at all`, 'js'],
];

// A scan runs precheck over every plugin for every input. For 26 plugins and 1129
// requests that is ~29k checks, so a cheap precheck is what keeps it viable.
console.log(`  ${'input'.padEnd(20)} ${plugins.map(([n]) => n.replace('Plugin', '').padEnd(14)).join('')}`);
for (const [label, content, type] of samples) {
  const input = inputFor('https://example.test/x', content, type);
  const row = plugins
    .map(([, plugin]) => {
      let applies;
      try {
        applies = plugin.precheck(input, emptyContext);
      } catch {
        applies = false;
      }
      return (applies ? 'yes' : '—').padEnd(14);
    })
    .join('');
  console.log(`  ${label.padEnd(20)} ${row}`);
}
console.log();
console.log('  A precheck that throws is treated as "no" by the pipeline, so a buggy');
console.log('  plugin cannot take down a scan.');
console.log();

// ===== Decoding first =====

// Plugins that do loose matching run the content through `decodeContent` first,
// which reverses JS escapes, URL encoding, Unicode escapes and HTML entities. Doing
// it yourself is sometimes useful — for instance to see why a URL was not matched.
const escaped = `document.write('<script src="/js/\\u0061pp.js"><\\/script>');`;
console.log('decodeContent, for when escaping hides a URL');
console.log('─'.repeat(66));
console.log(`  raw:     ${escaped}`);
console.log(`  decoded: ${decodeContent(escaped)}`);
console.log();

// ===== The HTML plugin =====

const html = `
<!doctype html>
<html><head>
  <script src="/static/app.js"></script>
  <link rel="modulepreload" href="/static/vendor.js">
  <link rel="prefetch" href="/static/lazy.js">
</head><body>
  <script>window.__CONFIG__ = { api: "/api" };</script>
</body></html>
`;

const htmlPlugin = new HtmlScriptPlugin();
const htmlInput = inputFor('https://example.test/', html, 'html');

console.log('HTMLScriptPlugin on a page with four loading hints')
console.log('─'.repeat(66));
const htmlResult = htmlPlugin.analyze(htmlInput, emptyContext);
for (const found of htmlResult.urls ?? []) {
  console.log(`  ${found.url}`);
}
console.log();
console.log(`inline scripts lifted for separate analysis: ${(htmlResult.inlineScripts ?? []).length}`);
for (const script of htmlResult.inlineScripts ?? []) {
  console.log(`  [${script.index}] ${script.content.trim()}`);
}
console.log();
console.log('  Inline bodies come back as data, not URLs, because they need');
console.log('  analysing as JavaScript with the *document* as their base URL — a');
console.log('  relative import inside an inline script resolves against the page.');
console.log();

console.log('Summary');
console.log('─'.repeat(66));
console.log('  A plugin is three members and no I/O. That is what makes them usable');
console.log(`  standalone: 26 plugins, each a pure function of content to findings.`);