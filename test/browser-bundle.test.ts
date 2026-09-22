/**
 * Guards the property that `@ejfkdev/jsdj/browser` can actually be bundled.
 *
 * The defect this exists for: a plain `await import('node:zlib')` inside a function
 * body is lazy at *runtime* but eager at *build time*. Every bundler still walks
 * that edge, tries to resolve `node:zlib`, and fails with
 *
 *     Could not resolve "node:zlib" ... Are you trying to bundle for node?
 *
 * so the browser entry was unusable in esbuild, webpack and rollup even though the
 * branch is never taken in a browser. The fix routes runtime builtin loads through
 * `importBuiltin()`, which assembles the specifier so no bundler can resolve it.
 *
 * These tests assert the property at the source level, which is where the mistake
 * is made. The end-to-end proof (an actual browser bundle) lives in the release
 * verification, not here, because invoking three bundlers from a unit test would
 * make the suite depend on network installs.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dir, '..', 'src');

/** Every `.ts` file under `src/`, recursively. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return entry.endsWith('.ts') ? [full] : [];
  });
}

/** Strip comments so prose mentioning a builtin is not read as code. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

describe('browser bundle-ability', () => {
  test('no runtime import() takes a literal node: specifier', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const code = stripComments(readFileSync(file, 'utf8'));
      // Type positions (`typeof import('node:fs')`) are erased by tsc, and
      // `importBuiltin` call sites do not match because their argument is a
      // variable, not a string literal. So anything matching here is a real edge a
      // bundler would follow.
      const literal = /\bimport\s*\(\s*['"](node:[^'"]+)['"]\s*\)/g;
      for (const match of code.matchAll(literal)) {
        const line = code.slice(0, match.index).split('\n').length;
        const isType = /(?:typeof|:)\s*$/.test(
          code.slice(Math.max(0, (match.index ?? 0) - 12), match.index),
        );
        if (!isType) {
          offenders.push(`${relative(SRC, file)}:${line} -> ${match[1]}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test('importBuiltin assembles the specifier from parts', () => {
    // If this ever became a pass-through (`import(specifier)` directly), bundlers
    // would follow the edge again and the test above would not catch it, because
    // the argument is still a variable.
    //
    // The hint comments are asserted against the raw source: `stripComments` is
    // what makes the scan above precise, so it also removes these markers.
    const raw = readFileSync(join(SRC, 'fetcher', 'import-builtin.ts'), 'utf8');
    const code = stripComments(raw);

    expect(code).toContain('split');
    expect(code).toContain('join');
    // Reassembled through variables, so the value never appears as a literal the
    // bundler could constant-fold.
    expect(code).toMatch(/scheme\s*\+\s*':'/);
    // The import must not receive the original parameter directly.
    expect(code).not.toMatch(/import\(\s*specifier\s*\)/);
    // Both ignore hints are required: esbuild rejects a resolvable node: specifier,
    // webpack builds a context module over a specifier expression, and rollup needs
    // the conversion left alone.
    expect(raw).toContain('webpackIgnore');
    expect(raw).toContain('@vite-ignore');
  });

  test('the built browser entry has no bundler-visible node: import', () => {
    const entry = join(import.meta.dir, '..', 'dist', 'browser.js');
    if (!existsSync(entry)) {
      // `dist/` is gitignored; skip rather than fail on a fresh checkout.
      return;
    }

    const seen = new Set<string>();
    const leaks: string[] = [];
    const visit = (file: string): void => {
      if (seen.has(file) || !existsSync(file)) return;
      seen.add(file);
      const code = stripComments(readFileSync(file, 'utf8'));
      const patterns = [
        /^\s*(?:import|export)\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/gm,
        /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      ];
      for (const pattern of patterns) {
        for (const match of code.matchAll(pattern)) {
          const specifier = match[1];
          if (specifier === undefined) continue;
          if (specifier.startsWith('node:')) {
            leaks.push(`${relative(join(import.meta.dir, '..'), file)} -> ${specifier}`);
          } else if (specifier.startsWith('.')) {
            let next = join(file, '..', specifier);
            if (!existsSync(next) && existsSync(`${next}.js`)) next = `${next}.js`;
            visit(next);
          }
        }
      }
    };
    visit(entry);

    expect(leaks).toEqual([]);
    expect(seen.size).toBeGreaterThan(10);
  });
});