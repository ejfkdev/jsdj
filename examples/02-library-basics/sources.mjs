/**
 * Working with the restored source content.
 *
 * The reason jsdj returns source *content* rather than only writing files: a
 * caller can search it, feed it to a parser, count things, or hand it to another
 * tool — all without a filesystem round trip.
 *
 * This example does something realistic: it flags restored files that contain
 * suspicious markers. The same shape works for any static analysis.
 */

import { scan, MemoryStorage } from '@ejfkdev/jsdj';

const url = process.argv[2] ?? 'http://127.0.0.1:18080/';

const result = await scan({ url, storage: new MemoryStorage() });

if (result.sources.length === 0) {
  console.log('No sources were restored.');
  console.log('This fixture does have a source map, so check the server is running:');
  console.log('  node ../fixture-site/serve.mjs');
  process.exit(1);
}

// ===== Treat the restored tree as a project =====

console.log(`${result.sources.length} restored source(s)\n`);

// Group by top-level directory, the way a developer would browse it.
const byDirectory = new Map();
for (const file of result.sources) {
  const slash = file.path.indexOf('/');
  const dir = slash >= 0 ? file.path.slice(0, slash) : '(root)';
  const list = byDirectory.get(dir) ?? [];
  list.push(file);
  byDirectory.set(dir, list);
}

console.log('By directory');
for (const [dir, files] of byDirectory) {
  console.log(`  ${dir}/  (${files.length} file${files.length === 1 ? '' : 's'})`);
}
console.log();

// ===== Search the content =====

/** Markers worth surfacing when you have someone else's source in hand. */
const MARKERS = [
  { label: 'credentials', pattern: /(api[_-]?key|secret|password|token)\s*[:=]/i },
  { label: 'debug flag', pattern: /debug\s*[:=]\s*true/i },
  { label: 'internal URL', pattern: /https?:\/\/[^\s'"]*\.(internal|local|corp)\b/i },
  { label: 'TODO', pattern: /\b(TODO|FIXME|HACK)\b/ },
  { label: 'sourceMappingURL', pattern: /sourceMappingURL/ },
];

const findings = [];
for (const file of result.sources) {
  for (const marker of MARKERS) {
    const match = marker.pattern.exec(file.content);
    if (match) {
      findings.push({
        path: file.path,
        label: marker.label,
        // Report the line number, and a trimmed excerpt rather than the whole match,
        // since a match can span a long string.
        line: file.content.slice(0, match.index).split('\n').length,
        excerpt: match[0].slice(0, 80).replace(/\s+/g, ' '),
      });
    }
  }
}

console.log('Marker scan');
if (findings.length === 0) {
  console.log('  nothing flagged');
} else {
  for (const f of findings) {
    console.log(`  ${f.path}:${f.line}  [${f.label}]`);
    console.log(`      ${f.excerpt}`);
  }
}
console.log();

// ===== Write a plain-text bundle =====

// Concatenating the tree into one document is a common next step — for review, for
// pasting into a model, or for archiving.
let bundle = '';
for (const file of [...result.sources].sort((a, b) => a.path.localeCompare(b.path))) {
  const rule = '='.repeat(70);
  bundle += `${rule}\n// ${file.path}  (${file.mode})\n${rule}\n${file.content}\n\n`;
}

console.log(`Concatenated bundle: ${bundle.length} bytes`);
console.log('First 200 bytes:');
console.log(JSON.stringify(bundle.slice(0, 200)));
console.log();

// Handy when you want the whole tree on disk in one go:
//
//   import { mkdir, writeFile } from 'node:fs/promises';
//   import { dirname, join } from 'node:path';
//   for (const file of result.sources) {
//     const target = join('./restored', file.path);
//     await mkdir(dirname(target), { recursive: true });
//     await writeFile(target, file.content);
//   }
//
// The file-based cache already does exactly this under its `sources/` directory, so
// you only need the above if you want a different layout or destination.