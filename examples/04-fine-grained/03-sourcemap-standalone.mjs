/**
 * Source maps, standalone.
 *
 * The source map layer has no dependency on the network or the pipeline. If you
 * have a map — from a `.map` file, a `data:` URI in a bundle, a build artifact —
 * you can parse it and recover the original sources directly.
 *
 * Two things this example makes concrete:
 *
 *  - The two restoration modes, and why the fallback is labelled as incomplete.
 *  - `sourcesContent` versus `mappings`, which is the difference between recovering
 *    the original text and reconstructing fragments of it.
 */

import {
  parseSourceMap,
  restoreFiles,
  hasSourcesContent,
  parseMappings,
  normalizeSourcePath,
  buildSourceMapUrl,
} from 'jsdj';

// ===== A map with sourcesContent: the original text survives =====

const withContent = JSON.stringify({
  version: 3,
  file: 'app.min.js',
  sources: [
    'webpack:///./src/App.tsx',
    'webpack:///./src/utils/format.ts',
    '../../../../node_modules/lodash/isObjectLike.js',
  ],
  sourcesContent: [
    'export function App() {\n  return <div>hello</div>;\n}\n',
    'export const format = (n) => n.toFixed(2);\n',
    'export default function isObjectLike(value) { return typeof value === "object"; }\n',
  ],
  mappings: 'AAAA',
});

console.log('Mode 1: sourcesContent');
console.log('─'.repeat(66));

const map1 = parseSourceMap(withContent);
console.log(`  sources: ${map1.sources.length}`);
console.log(`  has usable sourcesContent: ${hasSourcesContent(map1)}`);
console.log();

const files1 = restoreFiles(map1);
for (const file of files1) {
  console.log(`  ${file.path}  [${file.mode}]`);
  console.log(`      ${JSON.stringify(file.content.slice(0, 48))}…`);
}
console.log();

// The paths are normalised into something safe to write to disk, and that
// normalisation is visible here. The last entry is interesting: it climbed out of
// `node_modules` via `../../../../`, and rather than escaping the output directory
// the traversal is resolved and then clamped at the root.
console.log('Path normalisation');
console.log('─'.repeat(66));
console.log('  Raw sources are whatever the bundler wrote — webpack URLs, absolute');
console.log('  paths, deep relative traversals. They are normalised into safe');
console.log('  relative paths that keep the original structure:');
console.log();
for (const raw of map1.sources) {
  console.log(`    ${raw}`);
  console.log(`      -> ${normalizeSourcePath(raw, '')}`);
}
console.log();
console.log('  A traversal that would climb above the root is dropped rather than');
console.log('  followed, so a hostile map cannot write outside the output tree.');
console.log();

// ===== A map without sourcesContent: mapping reconstruction =====

// This is the weaker case. `mappings` describes where generated code came from; it
// does not contain the original text. So what can be recovered is the minified
// fragments that map to each source, reassembled in generated order — no variable
// names, no comments, no original formatting.
const minified = `var a=1;var b=2;function c(){return a+b}`;

const withoutContent = JSON.stringify({
  version: 3,
  sources: ['src/part-a.js', 'src/part-b.js'],
  sourcesContent: [null, null],
  // Two mappings on line 0, the second pointing at source index 1.
  // Decoded VLQ values, and the deltas they produce:
  //   "AAAA" -> 0,0,0,0     genCol +0, srcIdx +0, srcLine +0, srcCol +0
  //   "QACAA" -> 8,0,1,0,0  genCol +8, srcIdx +1, srcLine +0, srcCol +0, nameIdx +0
  mappings: 'AAAA,QACAA',
});

console.log('Mode 2: mappings reconstruction');
console.log('─'.repeat(66));

const map2 = parseSourceMap(withoutContent);
console.log(`  has usable sourcesContent: ${hasSourcesContent(map2)}`);
console.log();

// Supplying the minified body is what makes the fallback possible.
const files2 = restoreFiles(map2, minified);
for (const file of files2) {
  console.log(`  ${file.path}  [${file.mode}]`);
  for (const line of file.content.split('\n')) {
    console.log(`      ${line}`);
  }
  console.log();
}

console.log('  Notice the header the restored file carries. A mappings-only result');
console.log('  cannot be complete — the original identifiers and comments were');
console.log('  discarded at build time — so the content is labelled as reconstructed');
console.log('  rather than presented as the original. Treating the two modes the same');
console.log('  is how you end up believing you have recovered source you have not.');
console.log();

// ===== Parsing the VLQ mappings yourself =====

console.log('The mappings string, decoded');
console.log('─'.repeat(66));

// `mappings` is base64 VLQ: lines separated by `;`, segments by `,`, and each
// segment is 1, 4 or 5 deltas. Parsing it directly is useful when you want the
// position correspondence rather than restored files — for mapping a stack trace
// back to source, say.
const decoded = parseMappings(withoutContent ? map2.mappings : '');
console.log(`  mappings: ${JSON.stringify(map2.mappings)}`);
console.log();
console.log('  segment                                    genLine genCol srcIdx srcLine srcCol');
for (const m of decoded) {
  const seg = `${m.generatedLine}:${m.generatedColumn} -> ${m.sourceIndex}:${m.sourceLine}:${m.sourceColumn}`;
  console.log(
    `  ${seg.padEnd(42)} ${String(m.generatedLine).padEnd(7)} ${String(m.generatedColumn).padEnd(6)} ${String(m.sourceIndex).padEnd(6)} ${String(m.sourceLine).padEnd(7)} ${m.sourceColumn}`,
  );
}
console.log();
console.log('  Deltas accumulate across segments and carry across lines, except');
console.log('  generatedColumn which resets to 0 at the start of each line. That is');
console.log('  why two segments on one line share a source but differ in column.');
console.log();

// ===== Deriving a map URL =====

console.log('Deriving the map URL for a bundle');
console.log('─'.repeat(66));
for (const js of [
  'https://example.test/js/app.js',
  'https://example.test/js/app.js?v=1.2.3',
  'https://example.test/js/chunk.mjs',
]) {
  console.log(`  ${js}`);
  console.log(`    -> ${buildSourceMapUrl(js)}`);
}
console.log();
console.log('  The extension goes before the query string, so a cache-busting');
console.log('  parameter survives onto the map request.');
console.log();

// ===== Error handling =====

console.log('Invalid input');
console.log('─'.repeat(66));
for (const [label, content] of [
  ['empty', ''],
  ['not JSON', '<html>404</html>'],
  ['JSON without sources', '{"version":3}'],
  ['a bare array', '[1,2,3]'],
]) {
  try {
    parseSourceMap(content);
    console.log(`  ${label.padEnd(22)} parsed (unexpectedly)`);
  } catch (err) {
    console.log(`  ${label.padEnd(22)} rejected: ${err.name}`);
  }
}
console.log();
console.log('  A WAF answering a `.map` request with a 200 and an HTML error page is');
console.log('  common, which is why parsing is strict and failures are loud. The');
console.log('  pipeline uses `isValidSourceMap` to apply the same check before it');
console.log('  treats a response as a map.');