/**
 * Fail if the `browser` export reaches a Node builtin through a *static* import.
 *
 * A bundler follows static import/export-from edges unconditionally, so one of them
 * pointing at `node:fs` puts a Node builtin into a browser build. A dynamic
 * `import()` inside a function body is a lazy edge and is exactly how the
 * filesystem-backed pieces are kept out, so those are deliberately not followed.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';

const ENTRY = 'dist/browser.js';

/** Matches `import ... from '...'`, `export ... from '...'`, and `import '...'`. */
const STATIC_IMPORT =
  /^\s*(?:import|export)\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;

const seen = new Set();
const leaks = [];

function walk(file) {
  const resolved = resolve(file);
  if (seen.has(resolved) || !existsSync(resolved)) return;
  if (!statSync(resolved).isFile()) return;
  seen.add(resolved);

  const source = readFileSync(resolved, 'utf8');
  for (const [, specifier] of source.matchAll(STATIC_IMPORT)) {
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
  console.error(`the browser entry reaches Node builtins through static imports:`);
  for (const leak of leaks) console.error(`  ${leak}`);
  process.exit(1);
}
console.log(`browser graph clean: ${seen.size} modules, no static node: import`);
