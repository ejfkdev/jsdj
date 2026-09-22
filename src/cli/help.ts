/**
 * Help text.
 *
 * The HTTP and MCP sections are omitted, since this package provides neither;
 * library usage is documented in their place.
 */

export const VERSION = '0.1.2';

/** The full help output. */
export function helpText(): string {
  return `jsdj ${VERSION} - Dynamic JS File Extractor

Extract JS URLs and source maps from websites: discover dynamically loaded JS
(webpack chunks, import(), framework manifests...), restore original sources
from source maps, and reuse results from a local cache.

GitHub:  https://github.com/ejfkdev/jsdj
License: MPL-2.0

Usage:
  jsdj <url> [options]              scan a website
  jsdj scan <url> [options]         canonical subcommand form
  jsdj version                      print version and exit
  jsdj --list-plugins               list available plugins and exit

Scan options:
  -v, --version            print version and exit
  -d, --debug              enable debug output
  -f, --format <fmt>       output format: md (default) | json | text (bare URL list)
      --json               output raw JSON instead of rendered text
      --no-cache           disable cache reads (still saves to disk)
      --cache[=bool]       legacy compat: --cache / --cache=false / --cache=yes
      --cache-dir <dir>    cache root (default: <tmpdir>/ejfkdev/dj)
      --useragent <UA>     custom User-Agent string (non-ASCII supported)
      --ua <UA>            short alias for --useragent
  -x, --proxy <URL>        proxy URL: http://, https://, socks5://
      --cookie <cookies>   cookies for bypassing Cloudflare
  -H, --header <K: V>      custom HTTP header, repeatable (curl-style)
      --no-random-tls      disable randomized TLS fingerprint (use fixed Chrome)
      --no-tls             disable TLS fingerprinting entirely
  -o, --output <dir>       output directory (saves a copy without site subdir)
  -t, --timeout <secs>     per-request timeout in seconds (default: 30)
  -c, --concurrency <N>    max concurrent HTTP requests (default: 8)

Plugin selection:
      --list-plugins           print the built-in plugin names and exit
      --only-plugins <names>   run only these plugins (comma-separated)
      --exclude-plugins <names>
                               run everything except these (comma-separated)

Notes:
  - URL is the first positional argument; flags can appear before or after it
  - Flag values can be passed as --flag=value or as the next argument
  - --header can be specified multiple times; later values override earlier ones
  - --header overrides default browser headers (e.g. User-Agent, Accept)
  - environment proxies are honored: HTTPS_PROXY, HTTP_PROXY, ALL_PROXY, NO_PROXY
  - -o saves a copy of all files to the output dir (js/, html/, source_map/, sources/)
    without the site subdirectory level; the cache dir is still written normally
  - exit codes: 0 success, 1 usage or runtime error

TLS fingerprinting:
  Randomising the TLS ClientHello requires a native transport, shipped as the
  optional dependency ${'@jsdj/tls-sidecar'}. When it is not installed the scan still
  runs; the TLS options are accepted and silently have no effect.

Examples:
  jsdj https://example.com
  jsdj -f md https://example.com
  jsdj --debug --no-cache https://example.com
  jsdj --useragent='Mozilla/5.0 ...' https://example.com
  jsdj -x socks5://127.0.0.1:7890 https://example.com
  jsdj -f json --cookie 'cf_clearance=xxx; key=val' https://example.com
  jsdj -H 'Referer: https://google.com' -H 'X-Token: abc' https://example.com
  jsdj -o ./output -t 60 -c 16 https://example.com
  jsdj https://example.com -f text
  jsdj --only-plugins WebpackPlugin,NextJSPlugin https://example.com

Library:
  import { scan } from '@ejfkdev/jsdj';

  const result = await scan({ url: 'https://example.com', headers: { ... } });
  result.jsUrls    // discovered JS URLs
  result.sources   // restored source files, with content

Cache path: ${defaultCachePath()}
`;
}

/** A short usage summary, for flag errors. */
export function usageHint(): string {
  return 'Usage: jsdj [options] <url>   (run jsdj --help for details)';
}

/** The default cache directory, resolved for the current platform. */
export function defaultCachePath(): string {
  const tmp =
    process.env['TMPDIR'] ?? process.env['TEMP'] ?? process.env['TMP'] ?? '/tmp';
  const base = tmp.endsWith('/') ? tmp.slice(0, -1) : tmp;
  return `${base}/ejfkdev/dj`;
}