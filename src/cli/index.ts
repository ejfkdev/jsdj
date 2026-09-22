#!/usr/bin/env node
/**
 * The jsdj command-line interface.
 *
 * Runs the same `scan` the library exposes, with the CLI flag surface, output
 * rendering and exit codes. The only pieces that differ from the library call are
 * the ones a CLI must own: writing to stdout, sending debug output to stderr, and
 * translating a failure into an exit code.
 *
 * Exit codes: `0` on success, `1` for a usage or runtime error (the
 * legacy code for usage errors, not the `2` its framework would have used).
 */

import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scan } from '../scan.js';
import type { ScanResult } from '../extractor/types.js';
import { formatMarkdown, formatText } from '../extractor/output.js';
import { stderrLogger } from '../extractor/logger.js';
import { createDefaultRegistry } from '../plugins/index.js';
import { detectRuntime } from '../fetcher/runtime.js';
import {
  CliError,
  EXIT_ERROR,
  EXIT_SUCCESS,
  parseArgs,
  parseHeaderList,
} from './args.js';
import { VERSION, helpText, usageHint } from './help.js';

/**
 * Run the CLI.
 *
 * Returns the process exit code rather than calling `process.exit`, so the whole
 * flow stays testable.
 */
export async function main(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    return fail(err, false);
  }

  switch (parsed.command) {
    case 'help':
      process.stdout.write(helpText());
      return EXIT_SUCCESS;

    case 'version':
      process.stdout.write(`jsdj ${VERSION}\n`);
      return EXIT_SUCCESS;

    case 'scan':
      break;
  }

  if (parsed.listPlugins) {
    const registry = createDefaultRegistry();
    for (const name of registry.names()) {
      process.stdout.write(`${name}\n`);
    }
    return EXIT_SUCCESS;
  }

  if (parsed.url === undefined || parsed.url === '') {
    process.stderr.write('error: a URL is required\n');
    process.stderr.write(`${usageHint()}\n`);
    return EXIT_ERROR;
  }

  // Warn early when the runtime cannot do what was asked, rather than silently
  // carrying on. TLS fingerprinting is the common case.
  if (detectRuntime() === 'browser') {
    process.stderr.write(
      'warning: scanning from a browser runtime is not supported by the CLI\n',
    );
  }

  try {
    const headers = parseHeaderList(parsed.headers);

    // `--json` is a global override: it wins over `-f`.
    const format = parsed.json ? 'json' : parsed.format;

    const result = await scan({
      url: parsed.url,
      // `format` is not a scan option: the scan always produces the structured
      // result, and the CLI is what renders it. Kept in `render` below.
      headers,
      proxy: parsed.proxy,
      cookie: parsed.cookie,
      userAgent: parsed.userAgent,
      tlsFingerprint: parsed.noTls
        ? 'off'
        : parsed.noRandomTls
          ? 'chrome'
          : 'random',
      timeoutMs: parsed.timeout * 1000,
      concurrency: parsed.concurrency,
      cache: parsed.cache,
      writeCache: parsed.writeCache,
      cacheDir: parsed.cacheDir,
      outputDir: parsed.outputDir,
      onlyPlugins: parsed.onlyPlugins,
      excludePlugins: parsed.excludePlugins,
      debug: parsed.debug,
      logger: stderrLogger(parsed.debug),
    });

    process.stdout.write(render(result, format));

    // A scan that found nothing is not an error, but saying so on stderr helps
    // distinguish "nothing there" from "the output was swallowed".
    if (result.summary.jsCount === 0) {
      process.stderr.write('no JS files found\n');
    }

    return EXIT_SUCCESS;
  } catch (err) {
    return fail(err, parsed.debug);
  }
}

/** Render the result in the requested format. */
function render(result: ScanResult, format: 'md' | 'json' | 'text'): string {
  switch (format) {
    case 'json':
      return `${JSON.stringify(result, null, 2)}\n`;
    case 'text':
      // Bare URLs one per line, then a summary block.
      return result.jsUrls.length === 0
        ? ''
        : `${formatText(result)}\n`;
    case 'md':
    default:
      return formatMarkdown(result);
  }
}

/** Report an error and produce the exit code. */
function fail(err: unknown, showStack: boolean): number {
  if (err instanceof CliError) {
    process.stderr.write(`error: ${err.message}\n`);
    process.stderr.write(`${usageHint()}\n`);
    return EXIT_ERROR;
  }

  if (err instanceof Error) {
    process.stderr.write(`error: ${err.message}\n`);
    if (showStack && err.stack !== undefined) {
      process.stderr.write(`${err.stack}\n`);
    }
    return EXIT_ERROR;
  }

  process.stderr.write(`error: ${String(err)}\n`);
  return EXIT_ERROR;
}

/**
 * Whether this module is the process entry point.
 *
 * Not a plain `import.meta.url === pathToFileURL(process.argv[1]).href` check,
 * which fails in the case that matters most: when the CLI is installed as a
 * package, `process.argv[1]` is the `node_modules/.bin/jsdj` **symlink** while
 * `import.meta.url` resolves to the real file. On macOS the symlink path also
 * differs from the real path by the `/private` prefix. Comparing raw strings
 * therefore never matches, and the process exits silently with status 0.
 *
 * Both sides are resolved to real paths before comparing. `realpathSync` can
 * throw if the path has since been removed, so each side is guarded and a failure
 * falls back to a basename comparison.
 */
function isDirectInvocation(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) {
    return false;
  }

  const selfPath = fileURLToPath(import.meta.url);

  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };

  if (real(argv1) === real(selfPath)) {
    return true;
  }

  // A last resort for wrapper setups that exec through an intermediate script.
  // Both files must share a basename for this to be plausible.
  return basename(real(argv1)) === basename(real(selfPath));
}

if (isDirectInvocation() || process.env['JSDJ_FORCE_MAIN'] === '1') {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = EXIT_ERROR;
    });
}

export { EXIT_ERROR, EXIT_SUCCESS };