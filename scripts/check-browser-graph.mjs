/**
 * Fail if the `browser` export reaches a Node builtin in a way a bundler would
 * follow.
 *
 * An earlier revision of this check only followed *static* import/export-from
 * edges, on the theory that a dynamic `import()` in a function body is lazy and
 * therefore safe. That theory is wrong, and it let a real defect ship: esbuild,
 * webpack and rollup all walk a `import('node:zlib')` edge regardless of whether
 * the branch is ever taken, so `@ejfkdev/jsdj/browser` failed to bundle with
 *
 *     Could not resolve "node:zlib" ... Are you trying to bundle for node?
 *
 * Lazy protects the runtime, not the build. This check now follows dynamic imports
 * as well, and passes only when a builtin import is made *opaque* — see
 * `src/fetcher/import-builtin.ts`, which assembles the specifier so no bundler can
 * resolve it.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';

const ENTRY = 'dist/browser.js';

/** Matches `import ... from '...'`, `export ... from '...'`, and `import '...'`. */
const STATIC_IMPORT =
  /^\s*(?:import|export)\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;

/**
 * Matches `import('...')` with a literal specifier — the form a bundler resolves.
 *
 * A specifier assembled at runtime (as `importBuiltin` does) does not match, which
 * is the whole point: it is the only shape that reliably stays out of a bundle.
 */
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Type positions are erased by tsc and never reach a bundler. */
const TYPE_POSITION = /\b(?:typeof|:)\s*import\s*\(\s*['"][^'"]+['"]\s*\)/g;

/**
 * Strip comments before scanning.
 *
 * Without this, prose mentioning a builtin counts as a leak: `dist/browser.js`
 * carries the doc comment "a browser build never follows an `import('node:fs')`
 * path", and a naive scan reports the browser entry as leaking `node:fs`. Both
 * banner comments and trailing line comments are removed; the scan only cares
 * about code, so dropping strings' contents is not a concern (a specifier inside a
 * string literal is not an import statement).
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

const seen = new Set();
const leaks = [];

function stripTypePositions(source) {
  return stripComments(source).replace(TYPE_POSITION, '/* type-only */');
}

function walk(file) {
  const resolved = resolve(file);
  if (seen.has(resolved) || !existsSync(resolved)) return;
  if (!statSync(resolved).isFile()) return;
  seen.add(resolved);

  const source = stripTypePositions(readFileSync(resolved, 'utf8'));
  const specifiers = [
    ...[...source.matchAll(STATIC_IMPORT)].map((m) => m[1]),
    ...[...source.matchAll(DYNAMIC_IMPORT)].map((m) => m[1]),
  ];

  for (const specifier of specifiers) {
    if (specifier === undefined) continue;
    if (specifier.startsWith('node:')) {
      leaks.push(`${relative('.', resolved)} -> ${specifier}`);
      continue;
    }
    if (specifier.startsWith('.')) {
      walk(resolve(dirname(resolved), specifier));
    }
  }
}

walk(ENTRY);

if (leaks.length > 0) {
  console.error(
    'the browser entry reaches Node builtins through imports a bundler would follow:',
  );
  for (const leak of leaks) console.error(`  ${leak}`);
  console.error(
    '\nWrap the import with `importBuiltin()` from src/fetcher/import-builtin.ts.',
  );
  process.exit(1);
}
console.log(
  `browser graph clean: ${seen.size} modules, no bundler-visible node: import`,
);