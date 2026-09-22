/**
 * Logging.
 *
 * The library is silent by default. Writing debug output straight to stderr would
 * is right for a CLI and wrong for a library that a caller may embed in a server
 * where stdout is meaningful. So debug output goes through an injectable sink: the
 * CLI supplies one bound to stderr, and the library's default discards it.
 */

/** Receives diagnostic output from a scan. */
export interface Logger {
  /** Emit a debug message. */
  debug(message: string): void;
  /** Emit a warning. */
  warn(message: string): void;
}

/** A logger that discards everything. The library default. */
export function nullLogger(): Logger {
  return {
    debug() {},
    warn() {},
  };
}

/** Collect messages in memory. Useful in tests and for library callers. */
export function memoryLogger(): Logger & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    debug(message: string) {
      messages.push(message);
    },
    warn(message: string) {
      messages.push(`[warn] ${message}`);
    },
  };
}

/**
 * A logger writing to stderr.
 *
 * Warnings always print; debug output only when `enabled`, which is what the
 * CLI's `--debug` flag controls.
 */
export function stderrLogger(enabled: boolean): Logger {
  return {
    debug(message: string) {
      if (enabled) {
        process.stderr.write(`[debug] ${message}\n`);
      }
    },
    warn(message: string) {
      process.stderr.write(`${message}\n`);
    },
  };
}