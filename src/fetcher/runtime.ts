/**
 * Runtime detection.
 *
 * The cache and TLS features differ by platform, so the library decides what to
 * enable based on where it is running rather than requiring the caller to say.
 */

/** The runtime the library believes it is running in. */
export type Runtime = 'node' | 'browser' | 'unknown';

/**
 * Detect the current runtime.
 *
 * `bun` and `deno` are reported as `node` in spirit — both provide Node's
 * builtins and filesystem — but only when they also expose `process.versions`.
 * Detecting by capability rather than by user-agent keeps this working under
 * bundlers that rewrite `process`.
 */
export function detectRuntime(): Runtime {
  const global = globalThis as {
    process?: { versions?: Record<string, string | undefined> };
    window?: unknown;
    document?: unknown;
  };

  // A real DOM plus no Node versions is a browser. Checking for `document`
  // rather than `window` avoids classifying worker contexts as Node.
  const hasDom = typeof global.document !== 'undefined';
  const hasNodeVersions =
    typeof global.process?.versions?.node === 'string' ||
    typeof global.process?.versions?.bun === 'string' ||
    typeof global.process?.versions?.deno === 'string';

  if (hasNodeVersions && !hasDom) {
    return 'node';
  }
  if (hasDom) {
    return 'browser';
  }
  if (hasNodeVersions) {
    // Node with a DOM shim present (jsdom, happy-dom). Filesystem access still
    // works, so treat it as Node.
    return 'node';
  }
  return 'unknown';
}

/** Whether a real filesystem is available. */
export function hasFilesystem(): boolean {
  const runtime = detectRuntime();
  if (runtime !== 'node') {
    return false;
  }
  const global = globalThis as {
    process?: { getBuiltinModule?: (name: string) => unknown };
  };
  // `process.getBuiltinModule` exists on Node 22+; older versions can still
  // import node:fs, so absence is not proof either way. Fall back to trusting
  // the runtime detection.
  if (typeof global.process?.getBuiltinModule === 'function') {
    return global.process.getBuiltinModule('fs') !== undefined;
  }
  return true;
}