/**
 * Command-line argument parsing.
 *
 * The flag surface includes the legacy spellings, because those
 * are the interface scripts already use: `--ua` as an alias for `--useragent`,
 * `-debug`, and the `--cache` boolean words (`--cache=yes`, `--cache=false`).
 *
 * Parsing is hand-rolled rather than delegated to `node:util`'s `parseArgs`
 * because three behaviours fall outside what that supports: flags may appear
 * before *or* after the positional URL, `--header` is repeatable with later values
 * overriding earlier ones, and the legacy `--cache` form optionally consumes the
 * following non-flag argument as its value.
 */

/** Exit codes. */
export const EXIT_SUCCESS = 0;
export const EXIT_ERROR = 1;

/** A parse failure carrying the message to show the user. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

/** Parsed command-line state. */
export interface ParsedArgs {
  /** Subcommand to run. */
  command: 'scan' | 'version' | 'help';
  /** Target URL, for `scan`. */
  url?: string;
  /** Output format. */
  format: 'md' | 'json' | 'text';
  /** Emit debug output. */
  debug: boolean;
  /** Custom User-Agent. */
  userAgent?: string;
  /** Proxy URL. */
  proxy?: string;
  /** Cookie string. */
  cookie?: string;
  /** Repeatable `Key: Value` headers. */
  headers: string[];
  /** Disable TLS fingerprint randomisation, pinning Chrome. */
  noRandomTls: boolean;
  /** Explicitly disable TLS fingerprinting entirely. */
  noTls: boolean;
  /** Output directory for a second copy of the artifacts. */
  outputDir?: string;
  /** Per-request timeout in seconds. */
  timeout: number;
  /** Maximum concurrent requests. */
  concurrency: number;
  /** Read from cache. */
  cache: boolean;
  /** Write to cache. */
  writeCache: boolean;
  /** Cache root override. */
  cacheDir?: string;
  /** Emit raw JSON instead of the rendered format. */
  json: boolean;
  /** Restrict to these plugins. */
  onlyPlugins?: string[];
  /** Exclude these plugins. */
  excludePlugins?: string[];
  /** List plugin names and exit. */
  listPlugins: boolean;
}

/** Defaults. */
const DEFAULTS = {
  format: 'md' as const,
  timeout: 30,
  concurrency: 8,
};

/**
 * Parse `argv` (excluding the node binary and script path).
 *
 * Recognises the legacy spellings and normalises them, so downstream code only
 * ever sees the canonical names.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const result: ParsedArgs = {
    command: 'scan',
    format: DEFAULTS.format,
    debug: false,
    headers: [],
    noRandomTls: false,
    noTls: false,
    timeout: DEFAULTS.timeout,
    concurrency: DEFAULTS.concurrency,
    cache: true,
    writeCache: true,
    json: false,
    listPlugins: false,
  };

  if (argv.length === 0) {
    return { ...result, command: 'help' };
  }

  // A leading subcommand is handled first. Anything else means the implicit
  // `scan` form, i.e. `<flags> <url>`.
  let index = 0;
  const first = argv[0]!;
  if (first === 'scan') {
    index = 1;
  } else if (first === 'version' || first === '--version' || first === '-v') {
    return { ...result, command: 'version' };
  } else if (first === 'help' || first === '--help' || first === '-h') {
    return { ...result, command: 'help' };
  } else if (first === 'serve' || first === 'mcp' || first === 'completion') {
    // These subcommands belonged to the Go binary's HTTP and MCP modes, which this
    // port does not provide. Failing with a clear message beats an obscure parse
    // error.
    throw new CliError(
      `the "${first}" subcommand is not available: this port provides the scan CLI ` +
        `and a library, not the HTTP or MCP server`,
    );
  }

  while (index < argv.length) {
    const arg = argv[index]!;

    // `--` ends flag parsing; the rest is positional.
    if (arg === '--') {
      for (const rest of argv.slice(index + 1)) {
        if (result.url === undefined) {
          result.url = rest;
        }
      }
      break;
    }

    // Split `--flag=value` once, so the value handling below is uniform.
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = equals > 0 ? arg.slice(0, equals) : arg;
    const inlineValue = equals > 0 ? arg.slice(equals + 1) : undefined;

    switch (name) {
      // ===== Informational =====
      case '-h':
      case '--help':
        return { ...result, command: 'help' };

      case '-v':
      case '--version':
        return { ...result, command: 'version' };

      // ===== Output =====
      case '-f':
      case '--format': {
        const value = takeValue(argv, index, inlineValue, name);
        index = value.next;
        if (value.value !== 'md' && value.value !== 'json' && value.value !== 'text') {
          throw new CliError(
            `invalid --format value: ${JSON.stringify(value.value)} (expected: text|json|md)`,
          );
        }
        result.format = value.value;
        break;
      }

      case '--json':
        result.json = true;
        break;

      // ===== Diagnostics =====
      case '-d':
      case '--debug':
      case '-debug':
        result.debug = true;
        break;

      // ===== Transport =====
      case '--ua':
      case '--useragent': {
        const value = takeValue(argv, index, inlineValue, name);
        index = value.next;
        result.userAgent = value.value;
        break;
      }

      case '-x':
      case '--proxy': {
        const value = takeValue(argv, index, inlineValue, name);
        index = value.next;
        result.proxy = value.value;
        break;
      }

      case '--cookie': {
        const value = takeValue(argv, index, inlineValue, name);
        index = value.next;
        result.cookie = value.value;
        break;
      }

      case '-H':
      case '--header': {
        const value = takeValue(argv, index, inlineValue, name);
        index = value.next;
        // Repeatable; validated later so the error can name the offending value.
        result.headers.push(value.value);
        break;
      }

      case '--no-random-tls':
        result.noRandomTls = true;
        break;

      case '--no-tls':
        result.noTls = true;
        break;

      case '-t':
      case '--timeout': {
        const value = takeValue(argv, index, inlineValue, name);
        index = value.next;
        const seconds = Number(value.value);
        if (!Number.isFinite(seconds) || seconds <= 0) {
          throw new CliError(
            `invalid --timeout value: ${JSON.stringify(value.value)} (expected a positive number of seconds)`,
          );
        }
        result.timeout = seconds;
        break;
      }

      case '-c':
      case '--concurrency': {
        const value = takeValue(argv, index, inlineValue, name);
        index = value.next;
        const count = Number(value.value);
        if (!Number.isInteger(count) || count < 1 || count > 256) {
          throw new CliError(
            `invalid --concurrency value: ${JSON.stringify(value.value)} (expected an integer from 1 to 256)`,
          );
        }
        result.concurrency = count;
        break;
      }

      // ===== Storage =====
      case '--no-cache':
        result.cache = false;
        // Artifacts are still written when reads are disabled; only the read side
        // is turned off here too.
        break;

      case '--cache': {
        // Legacy form: a bare `--cache` optionally consumes the next
        // non-flag argument as a boolean word, and rejects it when it is not one.
        // That means `--cache <url>` is an error too — an awkward but
        // documented shape, preserved for compatibility. `--cache=false` and
        // `--no-cache` are the clear spellings.
        let word = inlineValue;
        if (word === undefined) {
          const next = argv[index + 1];
          if (next !== undefined && !next.startsWith('-')) {
            word = next;
            index++;
          }
        }
        applyCacheWord(result, word);
        break;
      }

      case '-o':
      case '--output': {
        const value = takeValue(argv, index, inlineValue, name);
        index = value.next;
        result.outputDir = value.value;
        break;
      }

      case '--cache-dir': {
        const value = takeValue(argv, index, inlineValue, name);
        index = value.next;
        result.cacheDir = value.value;
        break;
      }

      // ===== Plugins =====
      case '--only-plugins': {
        const value = takeValue(argv, index, inlineValue, name);
        index = value.next;
        result.onlyPlugins = splitList(value.value);
        break;
      }

      case '--exclude-plugins': {
        const value = takeValue(argv, index, inlineValue, name);
        index = value.next;
        result.excludePlugins = splitList(value.value);
        break;
      }

      case '--list-plugins':
        result.listPlugins = true;
        break;

      default:
        if (arg.startsWith('-') && arg !== '-') {
          throw new CliError(`unknown flag: ${arg}`);
        }
        // Positional: the URL. A second positional is an error rather than a
        // silent overwrite.
        if (result.url !== undefined) {
          throw new CliError(
            `unexpected extra argument: ${JSON.stringify(arg)} (only one URL is accepted)`,
          );
        }
        result.url = arg;
        break;
    }

    index++;
  }

  return result;
}

/** Read a flag's value from `--flag=value` or the following argument. */
function takeValue(
  argv: readonly string[],
  index: number,
  inlineValue: string | undefined,
  flagName: string,
): { value: string; next: number } {
  if (inlineValue !== undefined) {
    return { value: inlineValue, next: index };
  }
  const next = argv[index + 1];
  if (next === undefined) {
    throw new CliError(`flag ${flagName} requires a value`);
  }
  return { value: next, next: index + 1 };
}

/**
 * Apply a `--cache` boolean word.
 *
 * `--cache`, `--cache=yes`, `--cache=1`, `--cache=false` and friends are accepted;
 * an empty word meant `true`.
 */
function applyCacheWord(result: ParsedArgs, word: string | undefined): void {
  if (word === undefined || word === '') {
    result.cache = true;
    result.writeCache = true;
    return;
  }
  switch (word.toLowerCase()) {
    case 'true':
    case '1':
    case 'yes':
    case 'on':
      result.cache = true;
      result.writeCache = true;
      return;
    case 'false':
    case '0':
    case 'no':
    case 'off':
      result.cache = false;
      // Writes stay on: save-only mode.
      result.writeCache = true;
      return;
    default:
      throw new CliError(
        `invalid --cache value: ${JSON.stringify(word)} (expected yes/no/true/false/1/0/on/off)`,
      );
  }
}

/** Split a comma-separated flag value into trimmed, non-empty parts. */
function splitList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/**
 * Parse curl-style `Key: Value` headers into a map.
 *
 * Later values override earlier ones for the same key, which is what curl does and
 * what `--header` being repeatable implies.
 */
export function parseHeaderList(rawList: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const raw of rawList) {
    const idx = raw.indexOf(':');
    if (idx <= 0) {
      throw new CliError(
        `invalid --header value ${JSON.stringify(raw)} (expected "Key: Value" format)`,
      );
    }
    const key = raw.slice(0, idx).trim();
    const value = raw.slice(idx + 1).trim();
    if (key === '') {
      throw new CliError(
        `invalid --header value ${JSON.stringify(raw)} (empty header name)`,
      );
    }
    headers[key] = value;
  }
  return headers;
}