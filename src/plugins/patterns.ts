/**
 * Simple pattern-matching plugins.
 *
 * This file collects the plugins whose logic is a small number of regular
 * expressions: dynamic `import()`, static ESM imports, `document.createElement`
 * script loading, source map references, and the generic URL fallback.
 */

import type { AnalyzeInput, Plugin, PluginResult } from '../extractor/types.js';
import { decodeContent } from '../extractor/decode.js';
import {
  expandComboLoader,
  isAbsoluteUrl,
  normalizeUrl,
  resolveRelativePath,
} from '../extractor/url.js';
import {
  ResultBuilder,
  cleanUrlTrailing,
  containsAny,
  findAllFirst,
  firstPresent,
  forEachMatch,
  isBundlerInternalPath,
  looksLikeJsUrl,
} from './helpers.js';

function textOf(input: AnalyzeInput): string {
  return input.text ?? new TextDecoder('utf-8', { fatal: false }).decode(input.content);
}

/**
 * Dynamic `import()` extraction.
 *
 * Covers single quotes, double quotes and backtick template literals. Template
 * literals containing `${` are skipped: the value is not statically knowable, so
 * probing it would only produce a 404.
 */
export class DynamicImportPlugin implements Plugin {
  readonly name = 'DynamicImportPlugin';
  private readonly pattern = /import\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;

  precheck(input: AnalyzeInput): boolean {
    return input.contentType === 'js' && textOf(input).includes('import');
  }

  analyze(input: AnalyzeInput): PluginResult {
    const builder = new ResultBuilder(input.sourceUrl);
    forEachMatch(this.pattern, textOf(input), (groups) => {
      const fragment = groups[0];
      if (fragment === undefined || fragment.includes('${')) {
        return;
      }
      builder.add(fragment);
    });
    return builder.build();
  }
}

/**
 * Static ESM `import` extraction.
 *
 * Two forms: `import x from "./a.js"` (with any binding clause) and the
 * side-effect-only `import "./a.js"`. The `.js` suffix is required in the
 * pattern, which is what keeps bare specifiers like `react` out.
 */
export class EsmImportPlugin implements Plugin {
  readonly name = 'ESMImportPlugin';
  private readonly importFrom =
    /import\s*(?:\{[^}]*\}|\*\s*as\s+\w+|\w+)?\s*from\s*["']([^"')]+\.js)["']/g;
  private readonly importOnly = /import\s*["']([^"')]+\.js)["']/g;

  precheck(input: AnalyzeInput): boolean {
    // Minified output can be `import{..}from".."` with no space after `import`.
    return input.contentType === 'js' && textOf(input).includes('import');
  }

  analyze(input: AnalyzeInput): PluginResult {
    const builder = new ResultBuilder(input.sourceUrl);
    const text = textOf(input);

    for (const fragment of [
      ...findAllFirst(this.importFrom, text),
      ...findAllFirst(this.importOnly, text),
    ]) {
      if (isRelevantPath(fragment)) {
        builder.add(fragment);
      }
    }

    return builder.build();
  }
}

/** Reject specifiers that are not paths at all. */
function isRelevantPath(path: string): boolean {
  if (path === '') {
    return false;
  }
  if (path.startsWith('data:') || path.startsWith('blob:')) {
    return false;
  }
  // Absolute URLs, protocol-relative and relative paths are all fine.
  return true;
}

/**
 * Scripts injected at runtime.
 *
 * Covers `script.setAttribute('src', ...)`, `script.src = ...`, `new URL(...)`
 * and a vendor-specific `o('...')` call shape. Catching these matters because
 * loader code frequently builds script tags in JavaScript, so the URLs never
 * appear in the HTML.
 */
export class ScriptCreatePlugin implements Plugin {
  readonly name = 'ScriptCreatePlugin';
  private readonly setAttribute =
    /script\.setAttribute\s*\(\s*["']src["']\s*,\s*["']([^"']+\.js)["']\s*\)/g;
  private readonly srcAssign = /script\.src\s*=\s*["']([^"']+\.js)["']/g;
  private readonly newUrl = /new\s+URL\s*\(\s*["']([^"')]+\.js)["']/g;
  private readonly oCall = /\bo\s*\(\s*["']([^"')]+)/g;

  precheck(input: AnalyzeInput): boolean {
    return (
      input.contentType === 'js' &&
      containsAny(textOf(input), ['createElement', '.src', 'setAttribute'])
    );
  }

  analyze(input: AnalyzeInput): PluginResult {
    const builder = new ResultBuilder(input.sourceUrl);
    const text = textOf(input);

    for (const path of [
      ...findAllFirst(this.setAttribute, text),
      ...findAllFirst(this.srcAssign, text),
      ...findAllFirst(this.newUrl, text),
    ]) {
      builder.add(path);
    }

    // The `o(...)` shape is loose, so the capture is only accepted when it looks
    // like a JS path.
    for (const path of findAllFirst(this.oCall, text)) {
      if (path.endsWith('.js') || path.includes('.js?')) {
        builder.add(path);
      }
    }

    return builder.build();
  }
}

/**
 * Source map reference extraction.
 *
 * Looks in three places: the `X-SourceMap` and `SourceMap`
 * response headers, then a `//# sourceMappingURL=` comment, then the legacy
 * `//@` form, then an inline `data:application/json` URI.
 *
 * The result records whether a map was found in the knowledge base, which stops
 * the pipeline issuing a `HEAD` probe for a map that is already known about.
 */
export class SourceMapPlugin implements Plugin {
  readonly name = 'SourceMapPlugin';
  /** `(?m)` in Go became the `m` flag: the anchor must match per line. */
  private readonly sourceMappingUrl = /^\/\/#\s*sourceMappingURL\s*=\s*(.+)$/gm;
  private readonly sourceMappingOld = /^\/\/@\s*sourceMappingURL\s*=\s*(.+)$/gm;
  private readonly inlineSourceMap = /data:application\/json[^"'\s]+/g;

  precheck(input: AnalyzeInput): boolean {
    return input.contentType === 'js';
  }

  analyze(input: AnalyzeInput): PluginResult {
    const builder = new ResultBuilder(input.sourceUrl);
    const text = textOf(input);
    let found = false;

    // 1. Response headers.
    const headers = input.headers ?? {};
    for (const headerName of ['x-sourcemap', 'sourcemap']) {
      const value = headers[headerName];
      if (value !== undefined && value.trim() !== '') {
        const resolved = resolveSourceMapUrl(input.sourceUrl, value.trim());
        if (resolved !== '') {
          builder.addAbsolute(resolved);
          found = true;
        }
      }
    }

    // 2. Comment directives, newest form first.
    let mapUrl = '';
    const modern = firstCapture(this.sourceMappingUrl, text);
    if (modern !== '') {
      mapUrl = resolveSourceMapUrl(input.sourceUrl, modern.trim());
    }
    if (mapUrl === '') {
      const legacy = firstCapture(this.sourceMappingOld, text);
      if (legacy !== '') {
        mapUrl = resolveSourceMapUrl(input.sourceUrl, legacy.trim());
      }
    }

    // 3. Inline data URI. The last match wins: a source map lives at the end of
    //    the file, and earlier `data:application/json` occurrences are usually
    //    unrelated payloads.
    if (mapUrl === '') {
      const inline = [...text.matchAll(new RegExp(this.inlineSourceMap.source, 'g'))];
      const last = inline[inline.length - 1];
      if (last) {
        mapUrl = last[0];
      }
    }

    if (mapUrl !== '') {
      found = true;
      builder.addAbsolute(mapUrl);
    }

    // `found` is reported through the knowledge base rather than the result, so
    // the pipeline can skip a HEAD probe for a map this plugin already resolved.
    // The write happens here because the plugin is the only place that knows the
    // answer.
    if (found) {
      markJsHasSourceMap(input.sourceUrl);
    }

    return builder.build();
  }
}

/**
 * Source map findings, keyed by JS URL.
 *
 * The plugin writes into the knowledge base through a value carried in the
 * `context.Context`. Here the pipeline publishes a setter for the duration of a
 * dispatch, which keeps plugins free of pipeline imports without hiding the
 * dependency in an ambient channel.
 */
let sourceMapRecorder: ((jsUrl: string, has: boolean) => void) | null = null;

/** Install the recorder for the duration of a plugin dispatch. */
export function setSourceMapRecorder(
  recorder: ((jsUrl: string, has: boolean) => void) | null,
): void {
  sourceMapRecorder = recorder;
}

function markJsHasSourceMap(jsUrl: string): void {
  sourceMapRecorder?.(jsUrl, true);
}

/** Return the first capture of the first match, or `''`. */
function firstCapture(pattern: RegExp, text: string): string {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const match = new RegExp(pattern.source, flags).exec(text);
  return match?.[1] ?? '';
}

/**
 * Resolve a source map reference into an absolute URL.
 *
 * Handles four shapes: `data:` URIs, absolute URLs,
 * protocol-relative `//host/path`, absolute paths, and relative paths.
 */
export function resolveSourceMapUrl(baseUrl: string, mapUrl: string): string {
  if (mapUrl.startsWith('data:')) {
    return mapUrl;
  }
  if (isAbsoluteUrl(mapUrl)) {
    return mapUrl;
  }

  if (mapUrl.startsWith('//')) {
    try {
      const base = new URL(baseUrl);
      return `${base.protocol}${mapUrl}`;
    } catch {
      return `https:${mapUrl}`;
    }
  }

  if (mapUrl.startsWith('/')) {
    try {
      const base = new URL(baseUrl);
      return `${base.protocol}//${base.host}${mapUrl}`;
    } catch {
      return mapUrl;
    }
  }

  return normalizeUrl(resolveRelativePath(baseUrl, mapUrl));
}

/**
 * The generic fallback extractor.
 *
 * This plugin exists for the long tail: `document.write` injecting a script tag,
 * URLs hidden behind escaping, bespoke loaders. Its approach is to mechanically
 * decode the content first — reversing JS string escapes, URL encoding, Unicode
 * escapes and HTML entities — and then run deliberately loose patterns over the
 * result.
 *
 * Because the patterns are loose, three guards keep the false-positive rate
 * down: bundler-internal module paths are dropped, non-JS extensions are
 * rejected (including when they precede the `.js`), and the loosest pattern only
 * runs when nothing else matched.
 */
export class UniversalUrlPlugin implements Plugin {
  /**
   * The plugin name, spelled with a capitalised `URL`.
   *
   * The `name` is a public identifier: it appears in `jsDetails.fromPlugin`, in
   * `meta.json`, and in the CLI's `--only-plugins` / `--exclude-plugins` lists. It
   * therefore uses that spelling rather than the class name's.
   */
  readonly name = 'UniversalURLPlugin';

  private readonly scriptSrc = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+\.js[^"']*)["']/g;
  private readonly importCall = /\bimport\s*\(\s*["'`]([^"'`]+\.js)["'`]/g;
  private readonly requireCall = /\brequire\s*\(\s*["']([^"']+\.js)["']/g;
  private readonly loaderPath = /["']([^"']*!\/[^"']+\.js)["']/g;
  private readonly directSrc = /\bsrc\s*=\s*["']([^"']+\.js)["']/g;
  private readonly bareJs = /["']([^"'\\\s]*?\.js(?:\?[^"'\\]*?)?)["']/g;
  private readonly protocolRelative = /["'](\/\/[a-zA-Z0-9.\-]+\/[^"']+\.js[^"']*)["']/g;
  private readonly systemRegister = /System\.register\s*\(\s*\[([^\]]+)\]/g;
  private readonly quoted = /["']([^"']+\.js[^"']*)["']/g;
  private readonly callArg = /\b\w+\s*\(\s*["'](\/[^"']+\.js[^"']*)["']/g;
  private readonly pathLiteral =
    /["']((?:\/|[.]{1,2}\/)?(?:[a-zA-Z0-9_-]+\/)+(?:[a-zA-Z0-9_-]+)\.js)["']/g;
  private readonly constAssign =
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*["']([^"']{1,200})["']/g;
  private readonly concatAssign =
    /([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\+\s*["']([^"']{1,200})["']/g;
  private readonly importVar = /\bimport\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g;

  precheck(input: AnalyzeInput): boolean {
    if (input.contentType !== 'js' && input.contentType !== 'html') {
      return false;
    }
    return containsAny(textOf(input), [
      '.js',
      'document.write',
      'import(',
      'require(',
      '<script',
    ]);
  }

  analyze(input: AnalyzeInput): PluginResult {
    const builder = new ResultBuilder(input.sourceUrl);
    const sourceUrl = input.sourceUrl;

    const add = (raw: string): void => {
      let candidate = raw.trim();
      if (candidate === '') {
        return;
      }

      // A protocol-relative URL needs the page's scheme.
      if (candidate.startsWith('//')) {
        try {
          candidate = `${new URL(sourceUrl).protocol}${candidate}`;
        } catch {
          return;
        }
      }

      candidate = cleanUrlTrailing(candidate);

      if (!looksLikeJsUrl(candidate)) {
        return;
      }
      if (isBundlerInternalPath(candidate)) {
        return;
      }

      // A combo-loader URL must be expanded *before* URL resolution. The `??` marker
      // is indistinguishable from a query string to the WHATWG URL parser, which
      // turns `/static/??a.js,b.js` into a path of `/static` plus a query of
      // `?a.js,b.js` — re-serialising as `/static??a.js,b.js` and losing the slash
      // that separates the prefix from the file list. Expanding first keeps the
      // original text intact, and the members are ordinary URLs from then on.
      //
      // The pipeline expands combo URLs too, on the already-resolved absolute URL, so
      // this is a second chance rather than the only one — but by then the damage
      // above has already been done.
      for (const member of expandComboLoader(candidate)) {
        // A member that still contains `??` means this was not a combo URL after all;
        // `expandComboLoader` returns the input unchanged in that case.
        const absolute = normalizeUrl(resolveRelativePath(sourceUrl, member));
        if (isAbsoluteUrl(absolute)) {
          builder.addAbsolute(absolute);
        }
      }
    };

    const decoded = decodeContent(textOf(input));

    for (const m of findAllFirst(this.scriptSrc, decoded)) add(m);
    for (const m of findAllFirst(this.importCall, decoded)) add(m);
    for (const m of findAllFirst(this.requireCall, decoded)) add(m);
    for (const m of findAllFirst(this.directSrc, decoded)) add(m);
    for (const m of findAllFirst(this.protocolRelative, decoded)) add(m);

    // `loader!path` — keep only the part after the last `!`.
    forEachMatch(this.loaderPath, decoded, (groups) => {
      const value = groups[0];
      if (value === undefined) return;
      const bang = value.lastIndexOf('!');
      if (bang >= 0) {
        add(value.slice(bang + 1));
      }
    });

    // SystemJS dependency arrays. Not gated on "nothing found yet", because these
    // are genuine module dependencies rather than a loose fallback.
    forEachMatch(this.systemRegister, decoded, (groups) => {
      const arrayBody = groups[0];
      if (arrayBody === undefined) return;
      for (const dep of findAllFirst(this.quoted, arrayBody)) {
        add(dep);
      }
    });

    for (const m of findAllFirst(this.callArg, decoded)) add(m);
    for (const m of findAllFirst(this.pathLiteral, decoded)) add(m);

    // Variable tracking: propagate string constants, then resolve `import(var)`.
    // Covers loaders that assemble a URL at runtime from pieces.
    const constants = new Map<string, string>();
    forEachMatch(this.constAssign, decoded, (groups) => {
      const name = groups[0];
      const value = groups[1];
      if (name !== undefined && value !== undefined) {
        constants.set(name, value);
      }
    });

    // Three passes is enough for the `const a = base + "x"; const b = a + "y"`
    // chain without risking a long iteration on pathological input.
    for (let pass = 0; pass < 3; pass++) {
      let changed = false;
      forEachMatch(this.concatAssign, decoded, (groups) => {
        const target = groups[0];
        const source = groups[1];
        const suffix = groups[2];
        if (target === undefined || source === undefined || suffix === undefined) return;
        const base = constants.get(source);
        if (base === undefined) return;
        const value = base + suffix;
        if (constants.get(target) !== value) {
          constants.set(target, value);
          changed = true;
        }
      });
      if (!changed) break;
    }

    forEachMatch(this.importVar, decoded, (groups) => {
      const name = groups[0];
      if (name === undefined) return;
      const value = constants.get(name);
      if (value !== undefined) {
        add(value);
      }
    });

    // The loosest pattern runs only when everything else came up empty, which is
    // what keeps it from producing noise on ordinary bundles.
    if (builder.urlCount === 0) {
      for (const candidate of findAllFirst(this.bareJs, decoded)) {
        if (candidate.length < 500) {
          add(candidate);
        }
      }
    }

    return builder.build();
  }
}

/** Re-exported for symmetry with the other plugin modules. */
export { firstPresent };