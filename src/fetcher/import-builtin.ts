/**
 * Opaque dynamic imports of Node builtins.
 *
 * A plain `await import('node:fs')` inside a function body is *lazy at runtime but
 * eager at build time*: every bundler still walks the edge, tries to resolve
 * `node:fs`, and fails with
 *
 *     Could not resolve "node:fs" ... Are you trying to bundle for node?
 *
 * So a module that merely mentions a Node builtin in a `import()` it never runs on
 * the browser path still makes `@ejfkdev/jsdj/browser` unbundleable. Being lazy
 * protects the runtime, not the build.
 *
 * {@link importBuiltin} assembles the specifier from parts the bundler cannot
 * constant-fold and marks the call with both ignore hints. Verified to produce a
 * browser bundle with no Node builtin under esbuild, webpack 5 and rollup.
 *
 * Reaching for this is only correct when the caller has already established that
 * the code cannot run off-Node. `hasFilesystem()` is that guard in most cases.
 */

/**
 * Import a Node builtin without the bundler seeing the specifier.
 *
 * The two ignore comments are not interchangeable and both are needed: esbuild
 * rejects a `node:` specifier it can resolve, webpack builds a *context module*
 * over any specifier expression and then fails resolving the file, and rollup
 * needs the conversion left alone. `parts.join('')` defeats the constant folding
 * that would otherwise let a concatenated literal be resolved anyway.
 */
export function importBuiltin<T = unknown>(specifier: string): Promise<T> {
  // Split so the pieces never appear as a single resolvable literal.
  const parts = specifier.split(':');
  const scheme = parts[0] ?? '';
  const rest = parts.slice(1).join(':');
  const target = scheme + ':' + rest;

  return import(
    /* webpackIgnore: true */ /* @vite-ignore */ target
  ) as Promise<T>;
}