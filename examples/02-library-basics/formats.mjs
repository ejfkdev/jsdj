/**
 * Rendering a result yourself.
 *
 * The CLI renders output, but the renderers are ordinary exported functions, so a
 * service that wants the same Markdown report does not have to shell out to the
 * CLI or reimplement the formatting.
 */

import {
  scan,
  MemoryStorage,
  formatMarkdown,
  formatJson,
  formatText,
} from 'jsdj';

const url = process.argv[2] ?? 'http://127.0.0.1:18080/';

const result = await scan({
  url,
  storage: new MemoryStorage(),
  // A service usually does not want hundreds of source files in memory. The
  // files are still written by a file-backed cache and the counts stay accurate;
  // only the in-memory copy is skipped.
  maxInlineSources: 0,
});

console.log('='.repeat(70));
console.log('text — bare URL list, the format to diff or pipe');
console.log('='.repeat(70));
console.log(formatText(result));
console.log();

console.log('='.repeat(70));
console.log('json — the structured result');
console.log('='.repeat(70));
// `formatJson` is what the CLI's `-f json` emits. `JSON.stringify(result)` works
// too; the helper exists so the CLI and a library caller cannot drift apart.
const parsed = JSON.parse(formatJson(result));
console.log('top-level keys:', Object.keys(parsed).join(', '));
console.log('summary       :', JSON.stringify(parsed.summary));
console.log();

console.log('='.repeat(70));
console.log('markdown — the empty-cache variant, showing the "cache disabled" branch');
console.log('='.repeat(70));
// Rendering a result that never went through a file cache exercises the branch a
// service would hit on a machine with no writable temp directory. Note that the
// result itself is unchanged; only `cacheDirs` is absent.
console.log(formatMarkdown({ ...result, cacheBase: undefined, cacheDirs: undefined }));

// ===== Composing a custom report =====

// The structured result is designed to be re-rendered. Here is a compact report in
// a shape none of the built-in renderers produce.
const lines = [
  `# ${url}`,
  '',
  `${result.summary.jsCount} JS files, ` +
    `${result.summary.sourceMapCount} source maps, ` +
    `${result.summary.sourceCount} restored sources`,
  '',
];

// Group by the plugin that found each file, which is a useful way to see which
// loading schemes a site uses.
const byPlugin = new Map();
for (const detail of result.jsDetails) {
  const key = detail.fromPlugin ?? 'unknown';
  byPlugin.set(key, [...(byPlugin.get(key) ?? []), detail.url]);
}

for (const [plugin, urls] of [...byPlugin].sort((a, b) => b[1].length - a[1].length)) {
  lines.push(`## ${plugin} (${urls.length})`);
  lines.push('');
  for (const u of urls) {
    lines.push(`- ${u}`);
  }
  lines.push('');
}

console.log('='.repeat(70));
console.log('custom render — grouped by the plugin that found each URL');
console.log('='.repeat(70));
console.log(lines.join('\n'));