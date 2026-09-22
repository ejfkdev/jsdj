/**
 * Next.js chunk discovery.
 *
 * Next.js needs more machinery than most frameworks because its asset inventory
 * is not in the page:
 *
 * - Artifact names embed a per-build `buildId` that is only discoverable at
 *   runtime, so the `_buildManifest.js` / `_ssgManifest.js` probes are derived
 *   from it rather than hard-coded.
 * - App Router ships route payloads as React Server Components "flight" data,
 *   reachable only by re-requesting a route with an `RSC: 1` header. The plugin
 *   therefore issues probes (`probeRequests`) rather than URLs, and the pipeline
 *   fetches and re-dispatches them as `flight` content.
 * - Turbopack emits a different set of shapes than webpack (`otherChunks`,
 *   `sortedPages`), so both are handled.
 */

import type {
  AnalyzeInput,
  Plugin,
  PluginResult,
  ProbeRequest,
} from '../extractor/types.js';
import { decodeContent } from '../extractor/decode.js';
import {
  ResultBuilder,
  containsAny,
  findAllFirst,
  forEachMatch,
} from './helpers.js';

function textOf(input: AnalyzeInput): string {
  return input.text ?? new TextDecoder('utf-8', { fatal: false }).decode(input.content);
}

/** `scheme://host` for a URL, or `''`. */
function originOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
}

export class NextJsPlugin implements Plugin {
  readonly name = 'NextJSPlugin';

  private readonly otherChunks = /otherChunks\s*:\s*\[([^\]]+)\]/g;
  private readonly sortedPages = /sortedPages\s*:\s*\[([^\]]+)\]/;
  private readonly sortedPageItem = /"([^"]+)"/g;
  private readonly buildId = /"buildId"\s*:\s*"([^"]+)"/g;
  private readonly assetPrefix = /https?:\/\/[^"' ]+\/_next/g;
  /** Next.js's own chunk URL builder: `s.u = e => "static/chunks/" + e + "-" + {id:hash}[e] + ".js"`. */
  private readonly sType =
    /s\.u\s*=\s*e\s*=>\s*["']([^"']*)["']\s*\+\s*e\s*\+\s*["']-["']\s*\+\s*(\{[^}]+\})\s*\[\s*e\s*\]\s*\+\s*["']([^"']*)["']/g;
  private readonly numChunkId = /\{(\d+)\s*:\s*"([a-f0-9]+)"\}/g;
  private readonly numHashMap = /"(\d+)"\s*:\s*"([a-f0-9]+)"/g;
  private readonly flightChunk = /I\[\d+,\[([^\]]+)\]/g;
  private readonly flightHl = /:HL\["([^"]+\.js)","script"\]/g;
  private readonly flightBuild = /"b":"([^"]+)"/g;
  private readonly flightRoute = /"c":\[([^\]]+)\]/g;
  private readonly chunkPath =
    /\\?"?(\/?(?:_next\/)?static\/(?:immutable\/)?(?:chunks|css)\/[^"'\s,\]\\]+\.(?:js|css))\\?"?/g;
  private readonly aHref = /<a\s[^>]*href=["']([^"']+)["']/g;
  private readonly manifestPage = /"(\/[^"]+)":\s*\[([^\]]+)\]/g;
  private readonly quotedJs = /["']([^"']+\.js)["']/g;
  /** Root-relative Turbopack chunk references, which resolve under `/_next/`. */
  private readonly flightChunkRel =
    /(?:^|[^A-Za-z0-9_])(static\/(?:immutable\/)?chunks\/[^"'\\\s<>()\],]+\.js)/g;
  private readonly webpackRequireE = /__webpack_require__\.e\s*\(\s*["']([^"']+)["']\s*\)/g;
  private readonly manifestChunk = /"([^"]+\.js)"/g;

  precheck(input: AnalyzeInput): boolean {
    // Flight payloads are this plugin's own output, always worth re-analysing.
    if (input.contentType === 'flight') {
      return true;
    }
    const text = textOf(input);
    if (input.contentType === 'html') {
      return containsAny(text, ['__NEXT_DATA__', '/_next/']);
    }
    if (input.contentType === 'js') {
      return containsAny(text, [
        '__NEXT_DATA__',
        '_next/static',
        'next/dist',
        's.u=',
        'turbopack',
        '__BUILD_MANIFEST',
        '__SSG_MANIFEST',
      ]);
    }
    return false;
  }

  analyze(input: AnalyzeInput): PluginResult {
    if (input.contentType === 'flight') {
      return this.analyzeFlight(input);
    }
    if (input.contentType === 'html') {
      return this.analyzeHtml(input);
    }
    return this.analyzeJs(input);
  }

  // ===== HTML =====

  private analyzeHtml(input: AnalyzeInput): PluginResult {
    const builder = new ResultBuilder(input.sourceUrl);
    const text = textOf(input);
    const probeRequests: ProbeRequest[] = [];

    // Statically exported HTML has its inline `__next_f` data JSON-escaped, so
    // the `buildId` appears as `"b":"3He7..."` until the escapes are reversed.
    const decoded = decodeContent(text);
    let buildId = '';
    for (const pattern of [this.buildId, this.flightBuild]) {
      const found = findAllFirst(pattern, decoded)[0];
      if (found !== undefined && found !== '') {
        buildId = found;
        builder.addPublicPath(buildId);
        break;
      }
    }

    // The asset prefix is a CDN origin, used when the deployment serves static
    // assets from somewhere other than the app origin.
    for (const match of text.matchAll(new RegExp(this.assetPrefix.source, 'g'))) {
      const prefix = match[0].replace(/\/_next$/, '');
      // A templated prefix is a build placeholder, not a real origin.
      if (prefix !== '' && !prefix.includes('{{')) {
        builder.addPrependUrl(prefix);
      }
    }

    // With the build id known, the manifests are at fixed paths. Both a
    // root-relative and an origin-qualified form are queued: the relative one
    // goes through fragment resolution, the absolute one is fetched directly,
    // and whichever the server accepts wins.
    if (buildId !== '') {
      const origin = originOf(input.sourceUrl);
      const manifests = [
        `/_next/static/${buildId}/_buildManifest.js`,
        `/_next/static/${buildId}/_ssgManifest.js`,
        `/_next/static/${buildId}/_appManifest.js`,
      ];
      for (const path of manifests) {
        builder.addProbe(path);
      }
      for (const path of manifests) {
        if (origin !== '') {
          builder.addAbsolute(origin + path);
        }
      }
    }

    // Inline flight data (`__next_f.push`) may span several script tags, so the
    // whole document is scanned rather than each script body.
    this.extractFlightChunksFromContent(input, builder, text);

    // Re-requesting the current page with `RSC: 1` yields its flight payload.
    probeRequests.push({
      url: input.sourceUrl,
      headers: { RSC: '1' },
    });

    const basePath = this.inferBasePath(input.sourceUrl, text);
    this.extractRoutesForRsc(input, builder, probeRequests, text, basePath);
    this.extractHtmlLinksForRsc(input, builder, probeRequests, text);

    const result = builder.build();
    if (probeRequests.length > 0) {
      result.probeRequests = dedupeProbes(probeRequests);
    }
    return result;
  }

  // ===== Flight =====

  private analyzeFlight(input: AnalyzeInput): PluginResult {
    const builder = new ResultBuilder(input.sourceUrl);
    const text = textOf(input);

    this.extractFlightChunksFromContent(input, builder, text);

    // `:HL["...","script"]` are the server's preload hints: direct JS paths.
    for (const path of findAllFirst(this.flightHl, text)) {
      builder.add(path);
    }

    const buildId = findAllFirst(this.flightBuild, text)[0];
    if (buildId !== undefined && buildId !== '') {
      builder.addPublicPath(buildId);
    }

    const probeRequests: ProbeRequest[] = [];
    const basePath = this.inferBasePath(input.sourceUrl, text);
    this.extractRoutesForRsc(input, builder, probeRequests, text, basePath);

    const result = builder.build();
    if (probeRequests.length > 0) {
      result.probeRequests = dedupeProbes(probeRequests);
    }
    return result;
  }

  /** Pull chunk paths out of `I[<id>,[...]]` flight entries. */
  private extractFlightChunksFromContent(
    input: AnalyzeInput,
    builder: ResultBuilder,
    content: string,
  ): void {
    forEachMatch(this.flightChunk, content, (groups) => {
      const chunkList = groups[0];
      if (chunkList === undefined) {
        return;
      }
      for (const path of findAllFirst(this.chunkPath, chunkList)) {
        builder.add(path);
      }
    });
  }

  // ===== JS =====

  private analyzeJs(input: AnalyzeInput): PluginResult {
    const builder = new ResultBuilder(input.sourceUrl);
    const text = textOf(input);

    this.extractNextChunks(input, builder, text);
    this.extractNumericChunkIds(input, builder, text);

    for (const path of findAllFirst(this.flightChunkRel, text)) {
      builder.add(path);
    }

    // The `__webpack_require__.e("<id>")` shape is recorded as a distinguishable
    // marker rather than a guess at a URL: there is no way to know the artifact
    // layout here, and emitted a placeholder for later resolution.
    const seenChunkIds = new Set<string>();
    for (const chunkId of findAllFirst(this.webpackRequireE, text)) {
      const trimmed = chunkId.replace(/^["']|["']$/g, '');
      if (seenChunkIds.has(trimmed)) {
        continue;
      }
      seenChunkIds.add(trimmed);
      builder.addProbe(`__webpack_require_e__${trimmed}`);
    }

    if (text.includes('__BUILD_MANIFEST')) {
      this.extractBuildManifest(input, builder, text);
    }

    if (text.includes('otherChunks')) {
      this.extractTurbopackOtherChunks(input, builder, text);
    }

    return builder.build();
  }

  /** `s.u = e => "static/chunks/" + e + "-" + {id:hash}[e] + ".js"`. */
  private extractNextChunks(
    input: AnalyzeInput,
    builder: ResultBuilder,
    content: string,
  ): void {
    forEachMatch(this.sType, content, (groups) => {
      const prefix = groups[0] ?? '';
      const hashMapBody = groups[1] ?? '';
      const suffix = groups[2] ?? '';

      forEachMatch(this.numHashMap, hashMapBody, (inner) => {
        const chunkId = inner[0];
        const hash = inner[1];
        if (chunkId !== undefined && hash !== undefined) {
          builder.add(`${prefix}${chunkId}-${hash}${suffix}`);
        }
      });
    });
  }

  /**
   * `{123:"abc123"}` numeric-id hash maps, expanded into four layout guesses.
   *
   * Next.js has moved these artifacts between `static/chunks/`, `static/` and
   * `chunks/` across versions, and a legacy build emits
   * `<id>.<hash>.function.chunk.js`. All four are probed because the manifest
   * does not say which layout applies.
   */
  private extractNumericChunkIds(
    input: AnalyzeInput,
    builder: ResultBuilder,
    content: string,
  ): void {
    const seen = new Set<string>();
    forEachMatch(this.numChunkId, content, (groups) => {
      const chunkId = groups[0];
      const hash = groups[1];
      if (chunkId === undefined || hash === undefined) {
        return;
      }
      const key = `${chunkId}:${hash}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);

      for (const variant of [
        `static/chunks/${chunkId}.${hash}.js`,
        `static/${chunkId}.${hash}.js`,
        `chunks/${chunkId}.${hash}.js`,
        `${chunkId}.${hash}.function.chunk.js`,
      ]) {
        builder.add(variant);
      }
    });
  }

  /**
   * Parse `_buildManifest.js`: `self.__BUILD_MANIFEST = {"/page":["static/chunks/x.js"]}`.
   *
   * Each page entry yields an RSC probe (to pull that route's flight payload) and
   * its chunk paths. Manifest chunk paths are root-relative but are served under
   * `/_next/`, so that prefix is added as the primary candidate with a
   * directly-resolved path as fallback.
   */
  private extractBuildManifest(
    input: AnalyzeInput,
    builder: ResultBuilder,
    content: string,
  ): void {
    const origin = originOf(input.sourceUrl);

    forEachMatch(this.manifestPage, content, (groups) => {
      const pagePath = groups[0];
      const chunkList = groups[1];
      if (pagePath === undefined || chunkList === undefined) {
        return;
      }
      // Internal manifest fields (`__rewrites` and friends) are not routes.
      // `/`-prefixed entries include `/_app` and `/_error`, which are real pages
      // even in a statically exported build that has only those two.
      if (!pagePath.startsWith('/')) {
        return;
      }

      if (origin !== '') {
        builder.addProbeRequest({
          url: origin + pagePath,
          headers: { RSC: '1' },
        });
      }

      for (const chunk of findAllFirst(this.manifestChunk, chunkList)) {
        const trimmed = chunk.replace(/^\/+/, '');
        if (origin !== '') {
          builder.addProbe(`${origin}/_next/${trimmed}`);
        }
        builder.add(chunk);
      }
    });
  }

  /**
   * Turbopack: `otherChunks:["static/chunks/xyz.js"]` and `sortedPages:[...]`.
   *
   * `otherChunks` is a direct dependency list between chunks — the closest thing
   * Turbopack has to webpack's chunk map. `sortedPages` enumerates page routes,
   * and each gets both an RSC probe and a plain HTML fetch: a static export has no
   * provider references in the markup, but an SSR deployment injects them, so the
   * HTML fetch is what surfaces that chain.
   */
  private extractTurbopackOtherChunks(
    input: AnalyzeInput,
    builder: ResultBuilder,
    content: string,
  ): void {
    forEachMatch(this.otherChunks, content, (groups) => {
      const body = groups[0];
      if (body === undefined) {
        return;
      }
      for (const raw of findAllFirst(this.quotedJs, body)) {
        const relative = raw.replace(/^\/+/, '');
        if (!relative.startsWith('static/')) {
          continue;
        }
        const origin = originOf(input.sourceUrl);
        if (origin !== '') {
          builder.addProbe(`${origin}/_next/${relative}`);
        }
      }
    });

    const origin = originOf(input.sourceUrl);
    const sortedMatch = this.sortedPages.exec(content);
    const sortedBody = sortedMatch?.[1];
    if (sortedBody === undefined) {
      return;
    }

    for (const page of findAllFirst(this.sortedPageItem, sortedBody)) {
      if (origin === '') {
        continue;
      }
      builder.addProbeRequest({ url: origin + page, headers: { RSC: '1' } });
      builder.addIntermediate({
        url: origin + page,
        type: 'html',
        fromUrl: input.sourceUrl,
      });
    }
  }

  // ===== Routes and links =====

  /** Build RSC probes from the route tree embedded in flight data. */
  private extractRoutesForRsc(
    input: AnalyzeInput,
    builder: ResultBuilder,
    probeRequests: ProbeRequest[],
    content: string,
    basePath: string,
  ): void {
    const origin = originOf(input.sourceUrl);
    if (origin === '') {
      return;
    }

    const seen = new Set<string>();
    forEachMatch(this.flightRoute, content, (groups) => {
      const segments = groups[0];
      if (segments === undefined) {
        return;
      }

      const parts = segments
        .split(',')
        .map((part) => part.replace(/^[\s"]+|[\s"]+$/g, ''))
        .filter(
          (part) =>
            part !== '' &&
            part !== '$undefined' &&
            part !== '__PAGE__' &&
            !part.startsWith('$'),
        );

      if (parts.length === 0) {
        return;
      }

      const routePath = `${basePath}/${parts.join('/')}`;
      if (seen.has(routePath)) {
        return;
      }
      seen.add(routePath);

      probeRequests.push({ url: origin + routePath, headers: { RSC: '1' } });
    });

    void builder;
  }

  /**
   * Infer the deployment's `basePath` by locating the route path inside the
   * request URL.
   *
   * A site served at `/f/matchmaker/pay` with a route tree of
   * `["", "matchmaker", "pay"]` has a basePath of `/f`. Without this the probes
   * would be built at the site root and 404.
   */
  private inferBasePath(sourceUrl: string, content: string): string {
    let urlPath: string;
    try {
      urlPath = new URL(sourceUrl).pathname;
    } catch {
      return '';
    }

    let firstRoute = true;
    let result = '';
    forEachMatch(this.flightRoute, content, (groups) => {
      if (!firstRoute || result !== '') {
        return;
      }
      const segments = groups[0];
      if (segments === undefined) {
        return;
      }

      const parts = segments
        .split(',')
        .map((part) => part.replace(/^[\s"]+|[\s"]+$/g, ''))
        .filter(
          (part) =>
            part !== '' &&
            part !== '$undefined' &&
            part !== '__PAGE__' &&
            !part.startsWith('$'),
        );
      if (parts.length === 0) {
        return;
      }

      const routePath = `/${parts.join('/')}`;
      const idx = urlPath.indexOf(routePath);
      if (idx >= 0) {
        result = urlPath.slice(0, idx);
        firstRoute = false;
        return;
      }

      // Exact match failed: fall back to the last segment and verify the rest.
      const lastSegment = parts[parts.length - 1]!;
      const lastIdx = urlPath.indexOf(`/${lastSegment}`);
      if (lastIdx > 0) {
        const candidate = urlPath.slice(0, lastIdx);
        const allPresent = parts.every((seg) => urlPath.includes(`/${seg}`));
        if (allPresent) {
          result = candidate;
        }
      }
      // Only the first route is informative.
      firstRoute = false;
    });

    return result;
  }

  /** Build RSC probes from same-origin `<a href>` links. */
  private extractHtmlLinksForRsc(
    input: AnalyzeInput,
    _builder: ResultBuilder,
    probeRequests: ProbeRequest[],
    content: string,
  ): void {
    let baseHost: string;
    try {
      baseHost = new URL(input.sourceUrl).host;
    } catch {
      return;
    }

    const seen = new Set<string>(probeRequests.map((p) => p.url));

    for (const href of findAllFirst(this.aHref, content)) {
      if (
        href === '' ||
        href.startsWith('#') ||
        href.startsWith('javascript:') ||
        href.startsWith('mailto:') ||
        href.startsWith('tel:')
      ) {
        continue;
      }

      let parsed: URL;
      try {
        parsed = new URL(href, input.sourceUrl);
      } catch {
        continue;
      }

      if (parsed.host !== baseHost) {
        continue;
      }

      const path = parsed.pathname.toLowerCase();
      if (
        path.endsWith('.js') ||
        path.endsWith('.css') ||
        path.endsWith('.png') ||
        path.endsWith('.jpg') ||
        path.endsWith('.svg') ||
        path.endsWith('.ico') ||
        path.endsWith('.woff') ||
        path.endsWith('.woff2') ||
        path.endsWith('.ttf') ||
        path.endsWith('.eot')
      ) {
        continue;
      }
      if (parsed.pathname.includes('/_next/static')) {
        continue;
      }

      parsed.search = '';
      parsed.hash = '';
      const clean = parsed.toString();
      if (seen.has(clean)) {
        continue;
      }
      seen.add(clean);

      probeRequests.push({ url: clean, headers: { RSC: '1' } });
    }
  }
}

/** Deduplicate probe requests by URL, preserving order. */
function dedupeProbes(probes: readonly ProbeRequest[]): ProbeRequest[] {
  const seen = new Set<string>();
  const out: ProbeRequest[] = [];
  for (const probe of probes) {
    if (seen.has(probe.url)) {
      continue;
    }
    seen.add(probe.url);
    out.push(probe);
  }
  return out;
}