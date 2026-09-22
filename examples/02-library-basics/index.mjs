/**
 * The basic library call.
 *
 * `scan()` fetches a site, discovers its JavaScript, finds source maps and restores
 * the original sources, then returns everything as one structured object — no
 * filesystem, no CLI, no subprocess.
 *
 * Run `node ../fixture-site/serve.mjs` first, then `node index.mjs`.
 */

import { scan, MemoryStorage } from 'jsdj';

const url = process.argv[2] ?? 'http://127.0.0.1:18080/';

// In-memory storage keeps this example self-contained. On Node the default is a
// file cache under the system temp directory, which is what the CLI uses; passing
// `MemoryStorage` avoids leaving anything behind and makes repeat runs identical.
const result = await scan({
  url,
  storage: new MemoryStorage(),
});

console.log('Summary');
console.log('  JS files       :', result.summary.jsCount);
console.log('  source maps    :', result.summary.sourceMapCount);
console.log('  restored sources:', result.summary.sourceCount);
console.log();

console.log('JS URLs');
for (const jsUrl of result.jsUrls) {
  console.log('  ', jsUrl);
}
console.log();

// Every URL carries provenance: which plugin found it, and in which document.
// That answers "why is this URL here", which matters when a scan finds something
// unexpected.
console.log('Provenance');
for (const detail of result.jsDetails) {
  const from = detail.fromUrl ?? '—';
  const inline = detail.isInline ? ' (inline)' : '';
  console.log(`  ${detail.fromPlugin ?? '?'}${inline}`);
  console.log(`      ${detail.url}`);
  console.log(`      found in ${from}`);
}
console.log();

console.log('Restored sources');
if (result.sources.length === 0) {
  console.log('  (none — this site has no source maps)');
} else {
  for (const file of result.sources) {
    // `content` holds the file text, so a caller never has to read the disk.
    console.log(`  ${file.path}`);
    console.log(`      ${file.mode}, ${file.content.length} bytes, from ${file.fromJs ?? '?'}`);
  }
}
console.log();

// `sourceMaps` maps each JS URL to the map that was found beside it.
if (result.sourceMaps) {
  console.log('Source maps found');
  for (const [js, map] of Object.entries(result.sourceMaps)) {
    console.log(`  ${js}`);
    console.log(`      -> ${map}`);
  }
}
console.log();

// A scan that found nothing is not an error, so check the count rather than
// assuming success.
if (result.summary.jsCount === 0) {
  console.log('No JavaScript found. Is the fixture server running?');
  console.log('  node ../fixture-site/serve.mjs');
  process.exitCode = 1;
}