/**
 * URL helpers.
 *
 * About two dozen small functions carry the URL handling, and several encode
 * decisions that are not obvious. This example exercises them with the cases that
 * actually come up when scanning real sites, including the ones that look like bugs
 * until you know why.
 */

import {
  normalizeUrl,
  resolveRelativePath,
  isAbsoluteUrl,
  isLikelyStaticResource,
  isSourceMapUrl,
  buildSourceMapUrl,
  expandComboLoader,
  rebaseLoopbackOrigin,
  getBaseUrl,
  getDirFromUrl,
  joinUrlPath,
  unique,
} from 'jsdj';

function show(label, input, output) {
  const shown = typeof input === 'string' ? JSON.stringify(input) : String(input);
  console.log(`  ${label}`);
  if (shown === '') {
    console.log(`      -> ${output}`);
  } else {
    console.log(`      ${shown.padEnd(52)} -> ${output}`);
  }
}

// ===== normalizeUrl =====

console.log('normalizeUrl — the pipeline\'s identity for a resource');
console.log('─'.repeat(66));
console.log('  The normalised string keys dedup, discovery context and cache filenames,');
console.log('  so two URLs that normalise the same are treated as one resource.');
console.log();

const normCases = [
  ['a bare origin keeps no trailing slash', 'https://a.test'],
  ['an explicit root keeps its slash', 'https://a.test/'],
  ['a non-empty path loses a trailing slash', 'https://a.test/guide/'],
  ['the fragment is dropped', 'https://a.test/app.js?v=1#section'],
  ['the query is kept', 'https://a.test/app.js?v=1'],
  ['dot segments collapse', 'https://a.test/x/../y'],
  ['duplicate slashes collapse', 'https://a.test/a//b'],
];
for (const [label, input] of normCases) {
  show(label, input, JSON.stringify(normalizeUrl(input)));
}
console.log();

console.log('  Two of these are subtler than they look.');
console.log();
console.log('  The bare-origin case: `new URL("https://a.test").pathname` is "/", so a');
console.log('  naive port adds a slash the input never had. The trailing-slash case');
console.log('  goes the other way — a non-empty path loses its slash, because that is');
console.log('  what Go\'s path.Clean does, and the reference implementation is what this');
console.log('  must agree with. Both matter because they change URL identity.');
console.log();

// Idempotence is relied on: the pipeline normalises on enqueue and again on
// dequeue, keyed by the result.
const sample = 'https://a.test/guide/?q=1#x';
console.log(`  Idempotent, which the pipeline relies on:`);
console.log(`    once   -> ${JSON.stringify(normalizeUrl(sample))}`);
console.log(`    twice  -> ${JSON.stringify(normalizeUrl(normalizeUrl(sample)))}`);
console.log();

// ===== resolveRelativePath =====

console.log('resolveRelativePath — fragment to absolute URL');
console.log('─'.repeat(66));
const base = 'https://a.test/app/bundle.js';
for (const frag of ['./chunk.js', '../shared/util.js', '/root.js', '//cdn.test/lib.js', 'plain.js']) {
  console.log(`  ${frag.padEnd(24)} -> ${resolveRelativePath(base, frag)}`);
}
console.log();
console.log('  An unparseable fragment comes back unchanged rather than throwing, so');
console.log('  it can still be carried forward as a probe target.');
console.log(`  ${'http://[bad'.padEnd(24)} -> ${JSON.stringify(resolveRelativePath(base, 'http://[bad'))}  (returned unchanged, no throw)`);
console.log();

// ===== isLikelyStaticResource =====

console.log('isLikelyStaticResource — is this worth reporting as JS?');
console.log('─'.repeat(66));
const staticCases = [
  'https://a.test/app.js',
  'https://a.test/app.mjs',
  'https://a.test/load?type=module.js',
  'https://a.test/hm.js?t=1',
  'https://a.test/.vite/manifest.json',
  'https://a.test/page',
  'https://a.test/data.css',
];
for (const url of staticCases) {
  console.log(`  ${url.padEnd(46)} ${isLikelyStaticResource(url) ? 'yes' : 'no'}`);
}
console.log();
console.log('  The check is deliberately loose, and one consequence is worth knowing:');
console.log('  it tests whether the URL *contains* ".js", and ".json" contains it. So a');
console.log('  manifest path matches. That is inherited behaviour, not an oversight, and');
console.log('  the pipeline combines it with a content-type check so a manifest whose');
console.log('  body is HTML is still dropped.');
console.log();

// ===== source map URLs =====

console.log('Source map URL handling');
console.log('─'.repeat(66));
for (const js of ['https://a.test/app.js', 'https://a.test/app.js?v=2', 'https://a.test/x.mjs']) {
  console.log(`  ${js.padEnd(38)} -> ${buildSourceMapUrl(js)}`);
}
console.log();
console.log('  The extension goes before the query, so a cache-buster survives.');
console.log();
console.log(`  isSourceMapUrl('https://a.test/app.js.map?v=1') = ${isSourceMapUrl('https://a.test/app.js.map?v=1')}`);
console.log(`  isSourceMapUrl('https://a.test/app.js')         = ${isSourceMapUrl('https://a.test/app.js')}`);
console.log();

// ===== CDN combo-loader =====

console.log('expandComboLoader — one request, several files');
console.log('─'.repeat(66));
console.log('  WordPress and Alibaba Cloud CDN bundle multiple files behind "??". The');
console.log('  bundle itself is not a JS file, so its members are what get queued.');
console.log();
for (const combo of [
  'https://a.test/_static/??/js/a.js,/js/b.js',
  'https://g.alicdn.com/path/??a.js,b.js',
  'https://a.test/??x.js,y.js?v=9',
]) {
  console.log(`  ${combo}`);
  for (const expanded of expandComboLoader(combo)) {
    console.log(`      -> ${expanded}`);
  }
}
console.log();

// ===== loopback rebasing =====

console.log('rebaseLoopbackOrigin — recovering a baked-in dev address');
console.log('─'.repeat(66));
console.log('  Build artifacts sometimes bake in a dev-server address. When the same');
console.log('  build is served from elsewhere, that address is dead but the path is valid,');
console.log('  so the origin is rewritten and the chunk is recovered.');
console.log();
show(
  'a baked-in port, rewritten',
  'http://127.0.0.1:50315/remote/entry.js',
  rebaseLoopbackOrigin('http://127.0.0.1:50315/remote/entry.js', 'https://a.test/'),
);
console.log(
    `  the port is dropped, not merged -> host is ${new URL(rebaseLoopbackOrigin('http://127.0.0.1:50315/x.js', 'https://a.test/')).host}`,
  );
show(
  'a non-loopback target is left alone',
  'https://cdn.test/x.js',
  rebaseLoopbackOrigin('https://cdn.test/x.js', 'https://a.test/'),
);
console.log();
console.log('  "The port is dropped, not merged" is the subtle one. Assigning');
console.log('  `url.host = "a.test"` does not replace the port — the WHATWG host setter');
console.log('  parses the incoming string and merges its components, so a target port of');
console.log('  50315 survives and you get "a.test:50315". The origin is rebuilt from');
console.log('  parts instead.');
console.log();

// ===== path joining =====

console.log('Path arithmetic');
console.log('─'.repeat(66));
show('getBaseUrl', 'https://a.test:8443/x/y', getBaseUrl('https://a.test:8443/x/y'));
show('getDirFromUrl', 'https://a.test/a/b/c.js', getDirFromUrl('https://a.test/a/b/c.js'));
show('getDirFromUrl (root)', 'https://a.test/a.js', getDirFromUrl('https://a.test/a.js'));
console.log(`  joinUrlPath('https://a.test/x/', 'y.js')  -> ${joinUrlPath('https://a.test/x/', 'y.js')}`);
console.log(`  joinUrlPath('https://a.test/x', '/y.js')  -> ${joinUrlPath('https://a.test/x', '/y.js')}  (no doubled slash)`);
console.log();

// ===== misc =====

console.log('Small utilities');
console.log('─'.repeat(66));
show('isAbsoluteUrl', 'https://a.test/x', isAbsoluteUrl('https://a.test/x'));
show('isAbsoluteUrl', '/relative/x.js', isAbsoluteUrl('/relative/x.js'));
console.log(`  unique([1,2,2,3,1])                       -> ${JSON.stringify(unique([1, 2, 2, 3, 1]))}  (first-seen order kept)`);
console.log();

console.log('Where these are used');
console.log('─'.repeat(66));
console.log('  Every plugin calls into this layer, and so can you. A custom plugin finds');
console.log('  a relative reference and calls `resolveRelativePath`; a custom storage');
console.log('  backend derives a key with `normalizeUrl`; a report generator groups URLs');
console.log('  by `getBaseUrl`. None of it requires the pipeline.');