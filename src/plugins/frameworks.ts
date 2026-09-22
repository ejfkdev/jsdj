/**
 * Framework-specific plugins, part one: Vite, Nuxt, SvelteKit, RequireJS,
 * modern.js and Trunk.
 */

import type {
  AnalyzeInput,
  Plugin,
  PluginResult,
} from '../extractor/types.js';
import { decodeContent } from '../extractor/decode.js';
import {
  ResultBuilder,
  containsAny,
  findAllFirst,
  forEachMatch,
  firstPresent,
} from './helpers.js';

function textOf(input: AnalyzeInput): string {
  return input.text ?? new TextDecoder('utf-8', { fatal: false }).decode(input.content);
}

/** Vite: `__vitePreload`, `__vite__mapDeps`, modulepreload links, build manifest. */
export class VitePlugin implements Plugin {
  readonly name = 'VitePlugin';

  private readonly modulePreload =
    /<link[^>]+rel=["']modulepreload["'][^>]+href=["']([^"']+)["']/g;
  private readonly vitePreload =
    /__vitePreload\s*\(\s*\(\s*\)\s*=>\s*import\s*\(\s*["']([^"']+)["']/g;
  /** The whole `__vite__mapDeps = ...` function body. */
  private readonly mapDepsFunc = /__vite__mapDeps\s*=\s*[^;]+/gs;
  private readonly mapDepsJs = /["']([^"']+\.js)["']/g;
  private readonly moduleScript = /<script[^>]*type=["']module["'][^>]*src=["']([^"']+)["']/g;

  precheck(input: AnalyzeInput): boolean {
    const text = textOf(input);
    if (input.contentType === 'html') {
      return containsAny(text, ['@vite/client', 'type="module"', 'modulepreload']);
    }
    if (input.contentType === 'js') {
      return containsAny(text, ['__vite', '__vitePreload', 'import.meta.env']);
    }
    // Vite's build manifest (`build.manifest = true`). Vite 8 / Rolldown and
    // vite-plus emit the same shape.
    if (input.contentType === 'json') {
      return text.includes('"isEntry"') && text.includes('"file"');
    }
    return false;
  }

  analyze(input: AnalyzeInput): PluginResult {
    if (input.contentType === 'json') {
      return this.analyzeManifest(input);
    }
    if (input.contentType === 'html') {
      return this.analyzeHtml(input);
    }
    return this.analyzeJs(input);
  }

  /**
   * Parse a Vite build manifest.
   *
   * Shape: `{"index.html":{"file":"assets/index-abc.js","src":"main.ts","isEntry":true}}`.
   * `file` is the artifact path relative to the site root, and this manifest is
   * always probed from the root, so the manifest's own origin is the base.
   */
  private analyzeManifest(input: AnalyzeInput): PluginResult {
    const builder = new ResultBuilder(input.sourceUrl);

    let manifest: Record<string, { file?: string }>;
    try {
      manifest = JSON.parse(textOf(input)) as Record<string, { file?: string }>;
    } catch {
      return {};
    }

    const root = originOf(input.sourceUrl) + '/';
    for (const entry of Object.values(manifest)) {
      const file = entry.file;
      if (file === undefined || file === '' || !file.endsWith('.js')) {
        continue;
      }
      builder.addAbsolute(root + file.replace(/^\/+/, ''));
    }

    return builder.build();
  }

  private analyzeHtml(input: AnalyzeInput): PluginResult {
    const builder = new ResultBuilder(input.sourceUrl);
    const text = textOf(input);
    let moduleish = 0;

    for (const href of findAllFirst(this.modulePreload, text)) {
      moduleish++;
      if (href.endsWith('.js') || href.endsWith('.css')) {
        builder.add(href);
      }
    }

    for (const src of findAllFirst(this.moduleScript, text)) {
      moduleish++;
      builder.add(src);
    }

    // A page with module scripts is a Vite build, so probe the conventional
    // manifest location from the site root.
    if (moduleish > 0) {
      const root = originOf(input.sourceUrl);
      if (root !== '') {
        builder.addIntermediate({
          url: `${root}/.vite/manifest.json`,
          type: 'json',
          fromUrl: input.sourceUrl,
        });
      }
    }

    return builder.build();
  }

  private analyzeJs(input: AnalyzeInput): PluginResult {
    const builder = new ResultBuilder(input.sourceUrl);
    const text = textOf(input);

    for (const fragment of findAllFirst(this.vitePreload, text)) {
      builder.add(fragment);
    }

    // `__vite__mapDeps` holds a plain array of artifact paths.
    forEachMatch(this.mapDepsFunc, text, (groups) => {
      const body = groups[0];
      if (body === undefined) {
        return;
      }
      for (const jsPath of findAllFirst(this.mapDepsJs, body)) {
        if (!jsPath.endsWith('.css')) {
          builder.add(jsPath);
        }
      }
    });

    return builder.build();
  }
}

/** Nuxt: `/_nuxt/` asset paths, however they are quoted or concatenated. */
export class NuxtPlugin implements Plugin {
  readonly name = 'NuxtJSPlugin';
  private readonly nuxtPath = /(?:https?:\/\/[^"' ]+)?\/_nuxt\/[^"'\\\s<>()\],]+\.js/g;

  precheck(input: AnalyzeInput): boolean {
    const text = textOf(input);
    if (input.contentType === 'html') {
      return containsAny(text, ['__NUXT__', '__NUXT_DATA__', '/_nuxt/']);
    }
    if (input.contentType === 'js') {
      return containsAny(text, ['buildAssetsDir', '"buildId"', 'process.env.NUXT']);
    }
    return false;
  }

  analyze(input: AnalyzeInput): PluginResult {
    const builder = new ResultBuilder(input.sourceUrl);
    // The whole match is the path, not a capture group.
    for (const match of textOf(input).matchAll(new RegExp(this.nuxtPath.source, 'g'))) {
      builder.add(match[0]);
    }
    return builder.build();
  }
}

/**
 * SvelteKit: relative `../nodes/` and `../chunks/` references.
 *
 * The relative form is what appears in the generated client, and the `/_app/
 * immutable/` prefix is reconstructed because that is where the assets live.
 */
export class SvelteKitPlugin implements Plugin {
  readonly name = 'SvelteKitPlugin';
  private readonly nodes = /["']\.\.?\/nodes\/([0-9a-zA-Z_-]+\.js)["']/g;
  private readonly chunks = /["']\.\.?\/chunks\/([0-9a-zA-Z_-]+\.js)["']/g;

  precheck(input: AnalyzeInput): boolean {
    const text = textOf(input);
    if (input.contentType === 'html') {
      return containsAny(text, ['_app/immutable', '__svelte', 'sveltekit']);
    }
    if (input.contentType === 'js') {
      return containsAny(text, ['_app/immutable', '__sveltekit', '.svelte']);
    }
    return false;
  }

  analyze(input: AnalyzeInput): PluginResult {
    const builder = new ResultBuilder(input.sourceUrl);
    const text = textOf(input);

    for (const filename of findAllFirst(this.nodes, text)) {
      builder.add(`/_app/immutable/nodes/${filename}`);
    }
    for (const filename of findAllFirst(this.chunks, text)) {
      builder.add(`/_app/immutable/chunks/${filename}`);
    }

    return builder.build();
  }
}

/** RequireJS: `data-main`, `require([...])`, `define([...])`. */
export class RequireJsPlugin implements Plugin {
  readonly name = 'RequireJSPlugin';
  private readonly scriptSrc =
    /<script[^>]*src=["']([^"']*require(?:\.min)?\.js[^"']*)["']/g;
  private readonly dataMain = /data-main=["']([^"']+)["']/g;
  private readonly require = /require\s*\(\s*\[([^\]]+)\]/g;
  private readonly define = /define\s*\(\s*\[([^\]]+)\]/g;
  private readonly quoted = /["']([^"']+)["']/g;

  precheck(input: AnalyzeInput): boolean {
    const text = textOf(input);
    if (input.contentType === 'html') {
      return containsAny(text, [
        'require.min.js',
        'require.js',
        'data-main=',
        'require.config',
      ]);
    }
    if (input.contentType === 'js') {
      return containsAny(text, ['require([', 'define([', 'require.config']);
    }
    return false;
  }

  analyze(input: AnalyzeInput): PluginResult {
    const builder = new ResultBuilder(input.sourceUrl);
    const text = textOf(input);

    if (input.contentType === 'html') {
      for (const url of findAllFirst(this.scriptSrc, text)) {
        builder.add(url);
      }
      for (const raw of findAllFirst(this.dataMain, text)) {
        // `data-main` omits the extension by convention.
        builder.add(raw.endsWith('.js') ? raw : `${raw}.js`);
      }
      return builder.build();
    }

    for (const pattern of [this.require, this.define]) {
      forEachMatch(pattern, text, (groups) => {
        const depsBody = groups[0];
        if (depsBody === undefined) {
          return;
        }
        for (const dep of findAllFirst(this.quoted, depsBody)) {
          if (dep.startsWith('http://') || dep.startsWith('https://')) {
            builder.addAbsolute(dep);
          } else {
            builder.add(dep.endsWith('.js') ? dep : `${dep}.js`);
          }
        }
      });
    }

    return builder.build();
  }
}

/**
 * Modern.js (ByteDance) route manifest.
 *
 * The manifest is an inline `window._MODERNJS_ROUTE_MANIFEST = {...}` assignment,
 * so the JSON object has to be located by brace counting rather than by a regex —
 * nested route objects make a non-recursive pattern impossible.
 */
export class ModernJsPlugin implements Plugin {
  readonly name = 'ModernJSPlugin';
  private readonly publicPath =
    /(?:b\.p|__webpack_public_path__)\s*=\s*["']([^"']+)["']/;
  private readonly jsPath = /"((?:static|\/static)\/[^"]+\.js)"/g;

  precheck(input: AnalyzeInput): boolean {
    return (
      input.contentType === 'html' &&
      textOf(input).includes('_MODERNJS_ROUTE_MANIFEST')
    );
  }

  analyze(input: AnalyzeInput): PluginResult {
    const builder = new ResultBuilder(input.sourceUrl);
    const text = textOf(input);

    const manifest = extractBraceBalancedJson(text, 'window._MODERNJS_ROUTE_MANIFEST');
    if (manifest === '') {
      return {};
    }

    // The manifest holds artifact paths; `b.p` names the CDN they are served from.
    const cdnBase = this.extractCdnBase(text);
    if (cdnBase !== '') {
      builder.addPrependUrl(cdnBase);
    }

    for (const jsPath of findAllFirst(this.jsPath, manifest)) {
      if (cdnBase !== '') {
        // Artifact paths are root-relative; the CDN base already ends in `/`.
        builder.addAbsolute(cdnBase + jsPath.replace(/^\/+/, ''));
      } else {
        builder.add(jsPath);
      }
    }

    return builder.build();
  }

  private extractCdnBase(content: string): string {
    const match = this.publicPath.exec(content);
    const value = match?.[1];
    if (value === undefined || value === '') {
      return '';
    }
    const absolute = value.startsWith('//') ? `https:${value}` : value;
    return absolute.replace(/\/+$/, '') + '/';
  }
}

/**
 * Trunk (Rust wasm-bindgen bundler): `sitemap.json`.
 *
 * A Trunk SPA fetches its route and worker manifest at runtime, so the static
 * output contains no literal chunk references. The manifest is a JSON
 * intermediate:
 *
 * ```json
 * {"routes":[{"name":"home","file":"js/lazy-home.js"}],
 *  "chunks":{"w-0":"x1y2z3w4"},
 *  "workers":["js/worker.js"]}
 * ```
 */
export class TrunkPlugin implements Plugin {
  readonly name = 'TrunkPlugin';
  private readonly sitemap = /["']([^"']*sitemap\.json)["']/g;
  private readonly fetchJson = /fetch\s*\(\s*["']([^"']+\.json)["']/g;

  precheck(input: AnalyzeInput): boolean {
    const text = textOf(input);
    if (input.contentType === 'js' || input.contentType === 'html') {
      return text.includes('sitemap.json') || text.includes('trunk_app');
    }
    if (input.contentType === 'json') {
      // A bare JSON body only qualifies when it looks like a Trunk sitemap.
      return text.includes('"routes"') || text.includes('"workers"');
    }
    return false;
  }

  analyze(input: AnalyzeInput): PluginResult {
    if (input.contentType === 'json') {
      return this.parseSitemap(input);
    }

    const builder = new ResultBuilder(input.sourceUrl);
    const decoded = decodeContent(textOf(input));
    if (decoded === '') {
      return {};
    }

    let sitemapPath = '';
    const direct = firstMatch(this.sitemap, decoded);
    if (direct !== '') {
      sitemapPath = direct;
    } else {
      const fetched = firstMatch(this.fetchJson, decoded);
      if (fetched !== '') {
        sitemapPath = fetched;
      }
    }

    if (sitemapPath === '') {
      return {};
    }

    builder.addIntermediate({
      url: sitemapPath,
      type: 'json',
      fromUrl: input.sourceUrl,
    });
    return builder.build();
  }

  /**
   * Turn a sitemap into chunk URLs.
   *
   * Three sources, and the `chunks` map is the interesting one: it records a
   * name-to-hash mapping, so the artifact is `js/<name>.<hash>.js`. Paths resolve
   * relative to the sitemap's own directory.
   */
  private parseSitemap(input: AnalyzeInput): PluginResult {
    const builder = new ResultBuilder(input.sourceUrl);

    interface Sitemap {
      routes?: Array<{ name?: string; file?: string }>;
      chunks?: Record<string, string>;
      workers?: string[];
    }

    let sitemap: Sitemap;
    try {
      sitemap = JSON.parse(textOf(input)) as Sitemap;
    } catch {
      return {};
    }

    for (const route of sitemap.routes ?? []) {
      if (route.file) {
        builder.add(route.file);
      }
    }
    for (const [name, hash] of Object.entries(sitemap.chunks ?? {})) {
      builder.add(`js/${name}.${hash}.js`);
    }
    for (const worker of sitemap.workers ?? []) {
      builder.add(worker);
    }

    return builder.build();
  }
}

// ===== shared helpers =====

/** `scheme://host` for a URL, or `''`. */
function originOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
}

/** First capture of the first match, or `''`. */
function firstMatch(pattern: RegExp, text: string): string {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const match = new RegExp(pattern.source, flags).exec(text);
  return match?.[1] ?? '';
}

/**
 * Extract the JSON object that follows `marker = `, using brace counting.
 *
 * Brace counting is required because the manifest nests route objects, which no
 * single regular expression can match. String literals are tracked so that a `}`
 * inside a string value does not close the object early. Returns the object's
 * *contents* — braces excluded — because the caller immediately re-wraps
 * or re-parse.
 */
export function extractBraceBalancedJson(content: string, marker: string): string {
  const markerIdx = content.indexOf(marker);
  if (markerIdx < 0) {
    return '';
  }

  const equalsIdx = content.indexOf('=', markerIdx);
  if (equalsIdx < 0) {
    return '';
  }

  // Find the opening brace, allowing whitespace between `=` and `{`.
  let braceStart = -1;
  for (let i = equalsIdx + 1; i < content.length; i++) {
    const ch = content[i]!;
    if (ch === '{') {
      braceStart = i;
      break;
    }
    if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') {
      break;
    }
  }
  if (braceStart < 0) {
    return '';
  }

  let depth = 1;
  let inString: string | null = null;
  for (let i = braceStart + 1; i < content.length; i++) {
    const ch = content[i]!;

    if (inString !== null) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === inString) {
        inString = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }
    if (ch === '{') {
      depth++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        return content.slice(braceStart + 1, i);
      }
    }
  }

  return '';
}

export { firstPresent, containsAny };