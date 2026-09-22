/**
 * Hel-Micro and generic URL-pattern plugins.
 *
 * The hel-micro plugin handles two payload kinds: a bundle that points at a
 * component metadata document, and the metadata document itself, which lists each
 * component's `url` and `offlineChunks`. The URL-pattern plugin is the
 * protocol-relative discovery pass: `//cdn.host/path` literals become prepend
 * prefixes, and quoted `.js` strings become probe targets.
 */

import type {
  AnalyzeInput,
  Plugin,
  PluginResult,
} from '../extractor/types.js';
import {
  ResultBuilder,
  containsAny,
  findAllFirst,
  forEachMatch,
  isBundlerInternalPath,
  looksLikeHtmlEntry,
} from './helpers.js';

function textOf(input: AnalyzeInput): string {
  return input.text ?? new TextDecoder('utf-8', { fatal: false }).decode(input.content);
}

/** Placeholders Hel-Micro leaves in its metadata paths. */
function cleanPlaceholders(path: string): string {
  return path
    .replaceAll('{{specifiedVersionKey}}', '.v1')
    .replaceAll('{{', '')
    .replaceAll('}}', '');
}

/** Hel-Micro: component metadata documents and their component URLs. */
export class HelMicroPlugin implements Plugin {
  readonly name = 'HelMicroPlugin';
  private readonly metadata = /["']([^"']*metadata[^"']*\.json)["']/g;
  private readonly metadataConcat = /["']([^"']*\/components\/docs\/metadata[^"']+\.json[^"']*)["']/g;
  private readonly componentPath = /["']([^"']*\/components\/[^"']+\.js)["']/g;
  private readonly cdnPrefix =
    /(?:window\.)?COMPONENT_CDN_PREFIX\s*=\s*["']([^"']+)["']/g;
  private readonly cdnFallback = /\|\|\s*["'](\/\/[^"'\s]+)["']/g;

  private readonly helMarkers = [
    'hel-micro',
    'helMicro',
    'hel_meta',
    'components/docs/metadata',
    'COMPONENT_CDN_PREFIX',
    'componentCdnPrefix',
    'window.COMPONENT_CDN_PREFIX',
  ];

  precheck(input: AnalyzeInput): boolean {
    const text = textOf(input);
    if (input.contentType === 'js') {
      return containsAny(text, this.helMarkers);
    }
    if (input.contentType === 'json') {
      return isHelMicroMetadata(text);
    }
    return false;
  }

  analyze(input: AnalyzeInput): PluginResult {
    if (input.contentType === 'json') {
      return this.analyzeMetadata(input);
    }
    return this.analyzeJs(input);
  }

  private analyzeJs(input: AnalyzeInput): PluginResult {
    const builder = new ResultBuilder(input.sourceUrl);
    const content = textOf(input);

    // Metadata paths, with build placeholders neutralised so the URL is
    // fetchable.
    for (const raw of findAllFirst(this.metadata, content)) {
      // A path built from `window` or `location` is not statically resolvable.
      if (raw.includes('window') || raw.includes('location')) {
        continue;
      }
      builder.add(cleanPlaceholders(raw));
    }

    // The same path, assembled by string concatenation. Deliberately a probe
    // target rather than a URL, so the resolver can combine it with whichever
    // known origin actually serves it.
    for (const raw of findAllFirst(this.metadataConcat, content)) {
      builder.addProbe(cleanPlaceholders(raw));
    }

    for (const path of findAllFirst(this.componentPath, content)) {
      builder.add(path);
    }

    // CDN prefix, either assigned outright or hidden behind `||` as a fallback.
    for (const prefix of findAllFirst(this.cdnPrefix, content)) {
      builder.addPrependUrl(prefix);
    }
    for (const prefix of findAllFirst(this.cdnFallback, content)) {
      // Protocol-relative, so the page's scheme applies.
      builder.addPrependUrl(prefix.startsWith('//') ? `https:${prefix}` : prefix);
    }

    // A hel-micro bundle implies a conventional metadata location.
    if (
      containsAny(content, [
        'hel-micro',
        'helMicro',
        'components/docs/metadata',
      ])
    ) {
      builder.addProbe('/components/docs/metadata.v1.json');
    }

    return builder.build();
  }

  private analyzeMetadata(input: AnalyzeInput): PluginResult {
    const builder = new ResultBuilder(input.sourceUrl);

    let parsed: unknown;
    try {
      parsed = JSON.parse(textOf(input));
    } catch {
      return {};
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      // Test and mock components point at fixtures that may not exist.
      if (name.startsWith('test') || name.startsWith('mock')) {
        continue;
      }
      if (value === null || typeof value !== 'object') {
        continue;
      }

      const component = value as { url?: unknown; offlineChunks?: unknown };

      if (typeof component.url === 'string' && component.url !== '') {
        builder.addProbe(component.url);
      }

      if (Array.isArray(component.offlineChunks)) {
        for (const chunk of component.offlineChunks) {
          if (typeof chunk === 'string') {
            builder.addProbe(chunk);
          }
        }
      }
    }

    return builder.build();
  }
}

/**
 * Whether a JSON body looks like a Hel-Micro metadata document.
 *
 * The shape is `{"ComponentName":{"url":"x.js"},...}` — an object whose values
 * are objects carrying `url` or `offlineChunks`. Requiring one of those two keys
 * is what distinguishes it from arbitrary nested JSON.
 */
export function isHelMicroMetadata(content: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false;
  }

  for (const value of Object.values(parsed as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') {
      continue;
    }
    const component = value as Record<string, unknown>;
    if ('url' in component || 'offlineChunks' in component) {
      return true;
    }
  }
  return false;
}

/**
 * Generic URL patterns.
 *
 * Two jobs. First, harvest `//host/path` literals as prepend prefixes — these are
 * CDN origins that the relative-path resolution later relies on. Second, treat
 * every quoted `.js` string as a probe target, which catches loaders whose shape
 * is not otherwise recognisable.
 *
 * Bundler-internal module ids are filtered out. Without that filter, a wrapped
 * bundle's `./node_modules/lodash/isObjectLike.js` specifiers would be probed as
 * URLs and produce a wall of 404s.
 */
export class UrlPatternPlugin implements Plugin {
  readonly name = 'URLPatternPlugin';

  /**
   * Protocol-relative origin with optional path segments, rejecting file
   * extensions by excluding `.` from path segments.
   */
  private readonly cdnPrefix =
    /["'`](\/\/[a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z0-9]+(?:\/[a-zA-Z0-9_-]+)*\/?)["'`]/g;

  /** Any quoted `.js` string, in single, double or backtick quotes. */
  private readonly jsString = /["'`]([^"'`]+\.js)["'`]/g;

  precheck(input: AnalyzeInput): boolean {
    return input.contentType === 'js';
  }

  analyze(input: AnalyzeInput): PluginResult {
    const builder = new ResultBuilder(input.sourceUrl);
    const content = textOf(input);

    const seenPrefixes = new Set<string>();
    forEachMatch(this.cdnPrefix, content, (groups) => {
      const prefix = groups[0];
      if (prefix === undefined || seenPrefixes.has(prefix)) {
        return;
      }
      seenPrefixes.add(prefix);
      // Protocol-relative origins become `https://...` prefixes with no trailing
      // slash, so callers can append a path uniformly.
      builder.addPrependUrl(`https:${prefix}`.replace(/\/+$/, ''));
    });

    const seenPaths = new Set<string>();
    forEachMatch(this.jsString, content, (groups) => {
      const jsPath = groups[0];
      if (jsPath === undefined || seenPaths.has(jsPath)) {
        return;
      }
      if (isBundlerInternalPath(jsPath)) {
        return;
      }
      seenPaths.add(jsPath);
      builder.addProbe(jsPath);
    });

    return builder.build();
  }
}

export { looksLikeHtmlEntry };