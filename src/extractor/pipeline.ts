/**
 * The extraction pipeline.
 *
 * The discovery engine. The Go original was ~2300 lines of
 * goroutines coordinated through shared slices and `sync.WaitGroup`. The
 * observable behaviour is preserved; the control flow is not.
 *
 * ## What changed from the Go original, and why
 *
 * The original main loop drained a global task slice, spawned a goroutine per URL, waited
 * on a `WaitGroup`, and — when the queue looked empty — slept 500ms and looked
 * again, on the theory that in-flight goroutines might still enqueue work.
 * Source map probing was fired off in a bare `go` call that no WaitGroup tracked,
 * so the loop could exit while probes were still running. The result was correct
 * but timing-dependent: the set of chunks discovered could differ between runs
 * because fragment probing raced against cache hits.
 *
 * This version keeps concurrency (a semaphore bounds in-flight requests, as
 * `-c/--concurrency` controls) but replaces the sleep-and-recheck with an
 * **awaitable work queue**: every unit of work is a promise the loop awaits, so
 * the loop finishes exactly when there is nothing left to do. No sleeps, no
 * race, and the discovery order is deterministic. Source map probing is folded
 * into the same awaited flow.
 *
 * One consequence worth stating plainly: because discovery is no longer racing,
 * this implementation may find *more* chunks than the original did (it could exit
 * before a late probe enqueued its find) and does not reproduce the original's
 * run-to-run variance. That is the intended trade.
 */

import type {
  AnalyzeInput,
  CacheDirs,
  ContentKind,
  DiscoveredResource,
  HtmlEntry,
  InlineScript,
  IntermediateResource,
  JsEntry,
  Plugin,
  PluginContext,
  PluginResult,
  ProbeRequest,
  RestoredSource,
  ScanResult,
  SiteMetadata,
  JsMetadata,
} from './types.js';
import { KnowledgeBase } from './knowledge.js';
import { PluginRegistry } from './registry.js';
import { detectContentKind } from './decode.js';
import { restoreFiles, parse as parseSourceMap } from '../sourcemap/index.js';
import {
  buildSourceMapUrl,
  expandComboLoader,
  getBaseUrl,
  getDirFromUrl,
  isAbsoluteUrl,
  isLikelyStaticResource,
  isSourceMapUrl,
  joinUrlPath,
  normalizeUrl,
  rebaseLoopbackOrigin,
  unique,
} from './url.js';
import {
  scopeFromUrl,
  safeSourcePath,
  type Storage,
} from '../fetcher/storage.js';
import type { Fetcher } from '../fetcher/fetcher.js';
import { setSourceMapRecorder as installSourceMapRecorder } from '../plugins/patterns.js';
import { nullLogger, type Logger } from './logger.js';

/**
 * Raised when the scan's starting URL cannot be fetched.
 *
 * A distinct type so a caller can tell "the target was unreachable" from a bug
 * inside the scanner — and so a service can map it to an appropriate status rather
 * than returning an empty result.
 */
export class EntryFetchError extends Error {
  readonly url: string;
  override readonly cause?: unknown;

  constructor(message: string, url: string, cause?: unknown) {
    super(message);
    this.name = 'EntryFetchError';
    this.url = url;
    this.cause = cause;
  }
}

/** Global budget for recursive HTML entry points (multi-page, iframes). */
const MAX_HTML_PIVOTS = 64;

/** Ceiling on restored source content kept in memory across a scan. */
const DEFAULT_MAX_INLINE_SOURCES = 2000;

/** A URL queued for processing, with its provenance. */
interface QueuedUrl {
  url: string;
  fromUrl?: string;
  fromPlugin?: string;
  isInline?: boolean;
}

export interface PipelineOptions {
  /** Plugins to run. */
  registry: PluginRegistry;
  /** Request engine. */
  fetcher: Fetcher;
  /** Artifact store. A `NullStorage` disables caching entirely. */
  storage: Storage;
  /** Emit debug lines. */
  debug?: boolean;
  /** Destination for debug and warning output. Defaults to discarding. */
  logger?: Logger;
  /** Cap on restored source content retained in the result. */
  maxInlineSources?: number;
}

/**
 * Orchestrates discovery, download, dispatch, source map probing and
 * restoration for one site.
 *
 * One instance is not reusable across scans: it accumulates per-site state
 * (the knowledge base, the queue, the result lists) throughout a run.
 */
export class Pipeline {
  private readonly knowledge = new KnowledgeBase();
  private readonly registry: PluginRegistry;
  private readonly fetcher: Fetcher;
  private readonly storage: Storage;

  readonly debug: boolean;
  private readonly logger: Logger;
  private readonly maxInlineSources: number;

  /** The scan's starting URL; the anchor for cache scoping and loopback rebasing. */
  private baseUrl = '';
  /** Cache scope derived from `baseUrl`. */
  private scope = '';

  /** URLs awaiting processing. Drained by the main loop. */
  private queue: QueuedUrl[] = [];
  /** Provenance for each queued URL, keyed by normalised URL. */
  private urlContext = new Map<string, QueuedUrl>();

  /** Fragments awaiting resolution against known paths. */
  private fragments: DiscoveredResource[] = [];
  /** URLs already attempted, used to dedupe `found` notification. */
  private readonly emitted = new Set<string>();

  /** Discovered JS, in discovery order. */
  private readonly jsEntries: JsEntry[] = [];
  /** Separate HTML documents entered. */
  private readonly htmlEntries: HtmlEntry[] = [];

  /** Restored source files, including content. */
  private readonly restoredSources: RestoredSource[] = [];
  /** Restored count per JS URL, for metadata. */
  private readonly restoredCountByJs = new Map<string, number>();
  /** Restored source paths per JS URL, for metadata. */
  private readonly restoredPathsByJs = new Map<string, string[]>();
  /** Source map URL per JS URL. */
  private readonly sourceMapByJs = new Map<string, string>();
  /** Total restored files, including any dropped from the inline cap. */
  private restoredTotal = 0;

  private htmlPivotCount = 0;
  private empFallbackFired = false;
  /** Guards the one-time "no dynamic JS found" fallback. */
  private fallbackChecked = false;

  constructor(options: PipelineOptions) {
    this.registry = options.registry;
    this.fetcher = options.fetcher;
    this.storage = options.storage;
    this.debug = options.debug ?? false;
    this.logger = options.logger ?? nullLogger();
    this.maxInlineSources = options.maxInlineSources ?? DEFAULT_MAX_INLINE_SOURCES;
  }

  /** The scan's knowledge base, exposed for inspection after a run. */
  getKnowledge(): KnowledgeBase {
    return this.knowledge;
  }

  /** The site URL this pipeline is scanning. */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  // ===== Entry point =====

  /**
   * Run a scan from `startUrl`.
   *
   * Returns the URLs identified as JS. Call {@link getResult} afterwards for the
   * full structured result, which is assembled once at the end rather than
   * incrementally, since it needs the filesystem to report cache statistics.
   */
  async run(
    startUrl: string,
    signal?: AbortSignal,
  ): Promise<{ jsUrls: string[]; result: ScanResult }> {
    this.baseUrl = startUrl;
    this.scope = scopeFromUrl(startUrl);

    const origin = getBaseUrl(startUrl);
    if (origin !== '') {
      this.knowledge.addPrependUrl(origin);
    }

    // Fetch the entry page once so it lands in the cache, and so a cache hit can
    // skip the network on a second run.
    await this.primeEntryPage(startUrl, signal);

    // Fast path: a previous complete run recorded its findings in metadata. Reuse
    // them wholesale instead of rediscovering, which is both faster and immune to
    // any discovery-order differences.
    if (await this.tryRestoreFromMetadata(signal)) {
      this.debugLog('Run: restored from metadata, skipping discovery');
      return {
        jsUrls: this.knowledge.getKnownPaths(),
        result: await this.getResult(),
      };
    }

    this.enqueue(startUrl, { url: startUrl, fromPlugin: 'CLI' });

    await this.discoveryLoop(signal);

    await this.saveSiteMetadata();

    return {
      jsUrls: this.knowledge.getKnownPaths(),
      result: await this.getResult(),
    };
  }

  /**
   * Fetch the entry page and store it.
   *
   * Deliberately discards the content: the page is analysed later, when the
   * `startUrl` task is processed and reads it back from the cache. Priming here
   * only guarantees the cache is populated.
   */
  private async primeEntryPage(startUrl: string, signal?: AbortSignal): Promise<void> {
    if (!this.storage.writable && !this.storage.readable) {
      return;
    }

    if (this.storage.readable) {
      const cached = await this.storage.read({
        scope: this.scope,
        subdir: 'html',
        path: 'web.html',
      });
      if (cached) {
        this.debugLog('Run: entry page cache hit, skipping network fetch');
        return;
      }
    }

    // `fetchWithStatus` rather than `fetch`, because the response's final URL is
    // needed: a redirect on the entry page moves the site's origin, and every
    // subsequently discovered URL must be reported on the new origin. Fetching here
    // and then reading from the cache in the queued task means the cache path carries
    // no redirect information, so it has to be captured now.
    let result;
    try {
      result = await this.fetcher.fetchWithStatus(startUrl, signal);
    } catch (err) {
      // An abort is the caller's own doing, so it is rethrown unchanged rather than
      // wrapped: reporting a cancellation as an entry-fetch failure would misattribute
      // the cause, and a service needs to tell "the client gave up" from "the target
      // was unreachable".
      if (signal?.aborted === true || isAbortLike(err)) {
        throw err;
      }

      // Any other transport failure on the entry page is fatal, and rethrown so the
      // caller sees it. Every subsequent URL is discovered *from* this page, so if it
      // cannot be fetched there is nothing to scan — and returning an empty result
      // would be indistinguishable from "this site has no JavaScript". That ambiguity
      // is worse than an error: it is how a CORS block, a DNS failure or a dead host
      // all get mistaken for a site with nothing to find.
      throw new EntryFetchError(
        `could not fetch ${startUrl}: ${err instanceof Error ? err.message : String(err)}`,
        startUrl,
        err,
      );
    }

    // A non-2xx entry page is also fatal, for the same reason: dropping it
    // silently; reporting it is the difference between "nothing found" and "the
    // target refused us".
    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new EntryFetchError(
        `could not fetch ${startUrl}: HTTP ${result.statusCode}`,
        startUrl,
      );
    }

    if (result.finalUrl !== '' && normalizeUrl(result.finalUrl) !== normalizeUrl(startUrl)) {
      this.handleRedirect(startUrl, result.finalUrl);
    }

    await this.storage.write(
      { scope: this.scope, subdir: 'html', path: 'web.html' },
      result.content,
    );
  }

  // ===== Discovery loop =====

  /**
   * Drive discovery until the queue and fragment list are both empty.
   *
   * Unlike a sleep-and-recheck loop, there is no sleep and no re-check: every queued URL is
   * awaited (with a concurrency bound inside the fetcher), and every `await`
   * here can enqueue more work, which the next iteration picks up.
   */
  private async discoveryLoop(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) {
        this.debugLog('discovery loop aborted');
        return;
      }

      const batch = this.queue;
      this.queue = [];

      if (batch.length === 0) {
        if (this.fragments.length === 0) {
          // Nothing in flight and nothing pending. Before giving up, run the
          // conventional-manifest fallback once: if no plugin found anything
          // beyond inline HTML scripts, a framework manifest may still exist at a
          // well-known path.
          if (!this.fallbackChecked) {
            this.fallbackChecked = true;
            if (this.tryConventionalFallback()) {
              continue;
            }
          }
          this.debugLog('discovery loop complete');
          return;
        }

        // Resolve pending fragments, which may enqueue new URLs.
        await this.processFragments(signal);
        continue;
      }

      this.debugLog(
        `discovery loop: processing ${batch.length} queued urls (${this.fragments.length} fragments pending)`,
      );

      // Concurrency is bounded by the fetcher's semaphore, so dispatching the
      // whole batch at once is safe: requests queue rather than all firing.
      await Promise.all(
        batch.map((item) => this.processUrl(item, signal).catch(() => undefined)),
      );
    }
  }

  /**
   * The last-resort probe for EMP federation manifests.
   *
   * Only fires when every discovery so far came from the HTML script tag plugin,
   * meaning no framework-specific pattern matched and the site may be an EMP
   * app whose manifest is the only way in. Fires at most once per scan.
   */
  private tryConventionalFallback(): boolean {
    if (this.empFallbackFired) {
      return false;
    }

    const dynamic = this.jsEntries.filter(
      (e) => e.fromPlugin !== undefined && e.fromPlugin !== 'HTMLScriptPlugin',
    ).length;
    if (dynamic > 0) {
      return false;
    }

    this.empFallbackFired = true;
    const origin = getBaseUrl(this.baseUrl);
    if (origin === '') {
      return false;
    }

    let enqueued = false;
    for (const name of ['emp.json', 'emp-stats.json']) {
      const target = `${origin}/${name}`;
      if (!this.knowledge.claimUrl(target)) {
        continue;
      }
      this.enqueue(target, { url: target, fromPlugin: 'FallbackEmp' });
      enqueued = true;
      this.debugLog(`FallbackEmp: probing ${target}`);
    }
    return enqueued;
  }

  // ===== Queueing =====

  /**
   * Queue a URL unless it has been seen.
   *
   * Applies the loopback rebase first — a build artifact's baked-in
   * `127.0.0.1:PORT` address is rewritten onto the scanned origin, anchored on
   * the scan's start URL rather than on the discovering document, because the
   * discovering document may itself be a stale-port artifact.
   */
  private enqueue(url: string, context: QueuedUrl): boolean {
    let target = url;
    if (this.baseUrl !== '') {
      target = rebaseLoopbackOrigin(target, this.baseUrl);
    }

    target = normalizeUrl(target);

    if (!this.knowledge.claimUrl(target)) {
      return false;
    }

    const stored: QueuedUrl = { ...context, url: target };
    this.urlContext.set(target, stored);
    this.queue.push(stored);
    this.debugLog(`enqueue: ${target}`);
    return true;
  }

  /** Background enqueue used while another task's result is being handled. */
  private enqueueNow(url: string, context: QueuedUrl): boolean {
    const added = this.enqueue(url, context);
    // The discovery loop re-reads `this.queue` at the top of every iteration and
    // waits for all in-flight work before doing so, so anything added here is
    // guaranteed to be picked up. No wake-up signal is needed.
    return added;
  }

  /** Record a JS URL in the result set and mark it known. */
  private recordJs(entry: JsEntry): void {
    const normalized = normalizeUrl(entry.url);

    this.knowledge.addKnownPath(normalized);

    if (this.emitted.has(normalized)) {
      return;
    }
    this.emitted.add(normalized);
    this.jsEntries.push({ ...entry, url: normalized });
    this.debugLog(`found JS: ${normalized}`);
  }

  // ===== Per-URL processing =====

  /** Fetch and analyse one queued URL. */
  private async processUrl(item: QueuedUrl, signal?: AbortSignal): Promise<void> {
    // Rebase once more: every enqueue path converges here, so this catches any
    // URL that entered the queue by a route that skipped the rebase.
    const url =
      this.baseUrl === ''
        ? item.url
        : normalizeUrl(rebaseLoopbackOrigin(item.url, this.baseUrl));

    const context = this.urlContext.get(url) ?? { url, fromPlugin: 'Unknown' };

    let content: Uint8Array | null = null;
    let kind: ContentKind;
    let headers: Record<string, string> | undefined;
    /**
     * Final URL when this response redirected, so the resource is recorded under
     * the address it was served from rather than the one that was requested.
     */
    let redirectedTo: string | null = null;

    // A cache hit substitutes for the download only; analysis still runs, so
    // plugin behaviour is identical whether or not the cache was warm.
    const cached = await this.loadFromCache(url);
    if (cached) {
      content = cached.content;
      kind = cached.kind;
      this.debugLog(`cache hit: ${url}`);
    } else {
      const fetched = await this.download(url, signal);
      if (!fetched) {
        return;
      }
      content = fetched.content;
      kind = fetched.kind;
      headers = fetched.headers;

      // Any redirect is followed to its target: `normalizedURL` becomes
      // the final URL, so the resource is recorded under the address it was actually
      // served from. For a CDN that resolves an unpinned reference
      // (`.../standalone/babel.min.js`) to a pinned one
      // (`.../standalone@7.29.9/babel.min.js`), the reported URL is therefore the
      // versioned form rather than the page's literal.
      //
      // When the redirect is on the entry page, `handleRedirect` additionally moves
      // the scan's base origin, which changes how relative paths resolve for
      // everything discovered afterwards.
      if (fetched.finalUrl !== '' && fetched.finalUrl !== url) {
        this.handleRedirect(url, fetched.finalUrl);
        redirectedTo = normalizeUrl(fetched.finalUrl);
      }
    }

    const effectiveUrl = redirectedTo ?? this.effectiveUrlFor(url);

    // A `.js`-suffixed URL that returned HTML is a soft 404 or a WAF block page.
    // It stays in the output when the body is empty (a real but empty
    // endpoint) and dropped it otherwise.
    if (kind === 'html' && isLikelyStaticResource(effectiveUrl)) {
      if (content.byteLength === 0) {
        this.recordJs({
          url: effectiveUrl,
          fromUrl: context.fromUrl,
          fromPlugin: context.fromPlugin,
          isInline: context.isInline,
        });
      }
      return;
    }

    // A source map encountered as its own URL: parse and restore, then stop.
    // Falling through to plugin dispatch would mine the `sources` array for
    // paths like `node_modules/lodash/isObjectLike.js` and queue them as URLs.
    if (isSourceMapUrl(effectiveUrl)) {
      await this.handleSourceMapUrl(effectiveUrl, context, content, signal);
      return;
    }

    const text = decodeUtf8(content);
    const input: AnalyzeInput = {
      sourceUrl: effectiveUrl,
      contentType: kind,
      content,
      headers,
      text,
    };

    const results = await this.dispatchPlugins(input);
    await this.processResults(results, effectiveUrl, signal);

    if (kind === 'js') {
      await this.storage.write(
        { scope: this.scope, subdir: 'js', path: this.jsCacheFilename(effectiveUrl) },
        content,
      );

      this.recordJs({
        url: effectiveUrl,
        fromUrl: context.fromUrl,
        fromPlugin: context.fromPlugin,
        isInline: context.isInline,
      });

      // Probe for a sibling `.map`. Awaiting it here (rather than firing and
      // forgetting) is what makes the run deterministic.
      if (!this.knowledge.jsHasSourceMapUrl(effectiveUrl)) {
        await this.probeSourceMap(effectiveUrl, signal);
      }
    }
  }

  /** The URL to attribute work to, accounting for an entry-page redirect. */
  private effectiveUrlFor(url: string): string {
    if (this.redirectedBase === null) {
      return url;
    }
    const normalized = normalizeUrl(url);
    return normalized === this.redirectedBase.from
      ? this.redirectedBase.to
      : normalized;
  }

  /** Tracks an entry-page redirect so later work uses the final URL. */
  private redirectedBase: { from: string; to: string } | null = null;

  private handleRedirect(from: string, to: string): void {
    // Both sides are normalised before comparing. The caller may pass either form
    // — `download` has already normalised its URL, while `primeEntryPage` holds
    // the raw start URL — and the comparison would silently fail on a mismatch
    // like `https://a.test` versus `https://a.test/`, leaving the whole site
    // reported on the pre-redirect origin.
    const fromUrl = normalizeUrl(from);
    const finalUrl = normalizeUrl(to);
    if (finalUrl === fromUrl) {
      return;
    }
    this.debugLog(`redirect: ${fromUrl} -> ${finalUrl}`);

    if (fromUrl === normalizeUrl(this.baseUrl)) {
      this.baseUrl = finalUrl;
      this.scope = scopeFromUrl(finalUrl);
      const newOrigin = getBaseUrl(finalUrl);
      if (newOrigin !== '') {
        this.knowledge.addPrependUrl(newOrigin);
      }
      this.redirectedBase = { from: fromUrl, to: finalUrl };
    }
  }

  /** Download a URL, returning `null` for anything unusable. */
  private async download(
    url: string,
    signal?: AbortSignal,
  ): Promise<{
    content: Uint8Array;
    kind: ContentKind;
    headers: Record<string, string>;
    finalUrl: string;
  } | null> {
    let result;
    try {
      // `fetchWithStatus` retries transport failures internally.
      result = await this.fetcher.fetchWithStatus(url, signal);
    } catch (err) {
      this.debugLog(
        `fetch failed: ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }

    // 429 and 5xx are the statuses worth a second look; `fetchWithStatus` does
    // not retry these because they are valid responses, not transport failures.
    if (result.statusCode === 429 || result.statusCode >= 500) {
      try {
        result = await this.fetcher.fetchWithStatus(url, signal);
      } catch {
        // Keep the first response.
      }
    }

    if (result.statusCode < 200 || result.statusCode >= 300) {
      this.debugLog(`non-2xx ${result.statusCode}: ${url}`);
      // Dropped silently. Note that there is a
      // `recordUnreachableJS` helper that would report these URLs, but it is
      // never called from anywhere — so a chunk the server refuses with a 403 or
      // 418 does not appear in the output. That is intended, and this
      // reproduces it rather than "fixing" it, since callers may depend on the
      // URL set.
      return null;
    }

    return {
      content: result.content,
      kind: detectContentKind(result.contentType, result.content, url),
      headers: result.headers,
      finalUrl: result.finalUrl,
    };
  }

  /** Read a URL from cache, distinguishing the entry page from ordinary JS. */
  private async loadFromCache(
    url: string,
  ): Promise<{ content: Uint8Array; kind: ContentKind } | null> {
    if (!this.storage.readable) {
      return null;
    }

    if (url === this.baseUrl) {
      const cached = await this.storage.read({
        scope: this.scope,
        subdir: 'html',
        path: 'web.html',
      });
      // The cache carries no headers, so the kind is inferred from which cache
      // slot the content came out of.
      return cached ? { content: cached, kind: 'html' } : null;
    }

    const cached = await this.storage.read({
      scope: this.scope,
      subdir: 'js',
      path: this.jsCacheFilename(url),
    });
    return cached ? { content: cached, kind: 'js' } : null;
  }

  /**
   * Cache filename for a JS URL: `<host>-<path with slashes as dashes>`.
   *
   * Cross-origin chunks include their own host so two hosts serving the same
   * path do not collide. Extensionless URLs get `.js` appended.
   */
  private jsCacheFilename(url: string): string {
    const withoutScheme = url.replace(/^https?:\/\//, '');
    const slash = withoutScheme.indexOf('/');
    const rawHost = slash >= 0 ? withoutScheme.slice(0, slash) : withoutScheme;
    const host = rawHost.replace(/:/g, '_');
    const path = slash >= 0 ? withoutScheme.slice(slash + 1) : '';

    let filename = `${host}-${path.split('/').join('-')}`;
    const knownExtensions = ['.js', '.mjs', '.css', '.ts', '.tsx', '.vue'];
    if (!knownExtensions.some((ext) => filename.endsWith(ext))) {
      filename += '.js';
    }
    return filename;
  }

  // ===== Plugin dispatch =====

  /**
   * Run every applicable plugin over `input`, in parallel.
   *
   * Results come back ordered by plugin name. The plugins are independent and
   * each stamps its own provenance, but the order affects which URLs are queued
   * first, and queue order decides which HTML entries claim the pivot budget.
   * Sorting makes the admission sequence a function of the input rather than of
   * which plugin happened to finish first.
   */
  private async dispatchPlugins(input: AnalyzeInput): Promise<PluginResult[]> {
    const ctx: PluginContext = {
      publicPaths: this.knowledge.getPublicPaths(),
      prependUrls: this.knowledge.getPrependUrls(),
      knownPaths: this.knowledge.getKnownPaths(),
    };

    // Registration order, used to sort the results below. Built once per dispatch from
    // the registry's own ordering.
    const registrationOrder = this.registry.getAll();
    const registrationIndex = new Map<string, number>();
    for (let i = 0; i < registrationOrder.length; i++) {
      registrationIndex.set(registrationOrder[i]!.name, i);
    }

    const applicable: Plugin[] = [];
    for (const plugin of this.registry.getAll()) {
      try {
        if (plugin.precheck(input, ctx)) {
          applicable.push(plugin);
        }
      } catch (err) {
        this.debugLog(
          `plugin ${plugin.name} precheck threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // The source map plugin needs to report "this JS has a map" into the
    // knowledge base. Publishing a recorder for the dispatch window keeps that
    // write out of the plugin's imports while still being explicit about where
    // the state lives.
    installSourceMapRecorder((jsUrl, has) => {
      this.knowledge.setJsHasSourceMap(jsUrl, has);
    });

    let settled;
    try {
      settled = await Promise.allSettled(
        applicable.map(async (plugin) => {
          const result = await plugin.analyze(input, ctx);
          return { plugin: plugin.name, result };
        }),
      );
    } finally {
      installSourceMapRecorder(null);
    }

    const results: PluginResult[] = [];
    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        this.debugLog(
          `plugin failed: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
        );
        continue;
      }
      const { plugin, result } = outcome.value;
      // Provenance is stamped centrally so a plugin cannot misreport itself.
      results.push({ ...result, fromPlugin: plugin });
    }

    // Registration order, not alphabetical name order.
    //
    // The sequence matters because it decides the order URLs and candidate pages are
    // queued, and with a bounded page budget it decides *which* pages get crawled.
    // Sorting by plugin name put the plugins in an arbitrary order relative to the
    // registry — `HTMLPivotPlugin` sorts near the front by name but is registered near
    // the end — which reordered the crawl candidates enough that a whole directory of
    // pages fell outside the budget and the scripts they reference were missed.
    // Registration order is the order the registry was composed in, which is stable
    // across runs and reflects the intended priority.
    results.sort((a, b) => {
      const ia = registrationIndex.get(a.fromPlugin ?? '') ?? Number.MAX_SAFE_INTEGER;
      const ib = registrationIndex.get(b.fromPlugin ?? '') ?? Number.MAX_SAFE_INTEGER;
      return ia - ib;
    });

    return results;
  }

  /** Fold plugin results into the knowledge base and the work queues. */
  private async processResults(
    results: readonly PluginResult[],
    sourceUrl: string,
    signal?: AbortSignal,
  ): Promise<void> {
    // Collect every HTML intermediate across the whole batch and admit them in
    // sorted URL order. Admitting as they were encountered would let whichever
    // plugin result happened to sort first claim the scarce pivot budget slots,
    // which — combined with concurrent page processing — makes the admitted set
    // depend on network timing. Sorting first makes it a function of the input.
    for (const result of results) {
      const fromPlugin = result.fromPlugin ?? 'Unknown';

      this.knowledge.addPublicPath(...(result.publicPaths ?? []));
      this.knowledge.addPrependUrl(...(result.prependUrls ?? []));

      for (const discovered of result.urls ?? []) {
        const normalized = normalizeUrl(discovered.url);

        // A combo-loader URL holds several files behind one request; queue the
        // members rather than the bundle.
        for (const expanded of expandComboLoader(normalized)) {
          if (expanded.startsWith('data:')) {
            await this.handleDataUri(sourceUrl, expanded, signal);
            continue;
          }
          this.enqueueNow(expanded, {
            url: expanded,
            fromUrl: discovered.fromUrl ?? sourceUrl,
            fromPlugin,
            isInline: discovered.isInline,
          });
        }
      }

      for (const target of result.probeTargets ?? []) {
        await this.dispatchProbeTarget(
          { ...target, fromUrl: target.fromUrl ?? sourceUrl },
          fromPlugin,
          false,
          signal,
        );
      }

      // Admitted immediately. Batching them until the end of the round
      // and sorting before admission was meant to make the crawl deterministic, but
      // it changed *which* pages fit inside the budget: a page whose links were
      // discovered on an early round lost every slot to a page that merely had more
      // links, so its own children were never crawled and the scripts they reference
      // were missed. Determinism comes from the plugin results already being sorted
      // and from this loop being ordered; it does not require batching.
      for (const intermediate of result.intermediates ?? []) {
        this.enqueueIntermediate(intermediate, fromPlugin);
      }

      for (const script of result.inlineScripts ?? []) {
        await this.processInlineScript(script, signal);
      }

      for (const probe of result.probeRequests ?? []) {
        await this.processProbeRequest(probe, signal);
      }
    }


  }

  /** Queue an intermediate manifest, subject to the HTML pivot budget. */
  private enqueueIntermediate(
    intermediate: IntermediateResource,
    fromPlugin: string,
  ): void {
    const normalized = normalizeUrl(intermediate.url);

    // The seen-check comes before the budget check. The order matters:
    // the budget is consumed by *distinct* pages, so checking the budget first
    // would let repeated sightings of the same page burn slots and exhaust the
    // budget long before 64 different pages had been reached.
    if (this.knowledge.isSeenUrl(normalized)) {
      return;
    }

    if (intermediate.type === 'html') {
      if (this.htmlPivotCount >= MAX_HTML_PIVOTS) {
        this.debugLog(`HTML pivot budget exhausted, skipping ${normalized}`);
        return;
      }
      this.htmlPivotCount++;
      this.htmlEntries.push({
        url: normalized,
        fromUrl: intermediate.fromUrl,
        fromPlugin,
      });
    }

    this.enqueueNow(normalized, {
      url: normalized,
      fromUrl: intermediate.fromUrl,
      fromPlugin,
    });
  }

  /**
   * Analyse an inline script body.
   *
   * The base URL is the enclosing HTML document, not the script, so relative
   * imports inside the script resolve correctly. Inline scripts are analysed one
   * level deep only: recursing into scripts found inside scripts was an
   * unbounded-iteration hazard.
   */
  private async processInlineScript(
    script: InlineScript,
    signal?: AbortSignal,
  ): Promise<void> {
    if (script.content.length === 0) {
      return;
    }

    // Dedupe on document plus position.
    const key = `${script.sourceUrl}#inline#${script.index}`;
    if (!this.knowledge.claimUrl(key)) {
      return;
    }

    const input: AnalyzeInput = {
      sourceUrl: script.sourceUrl,
      contentType: 'js',
      content: new TextEncoder().encode(script.content),
      text: script.content,
    };

    const results = await this.dispatchPlugins(input);

    // Handle only URLs and probe targets: nested inline scripts are ignored on
    // purpose.
    for (const result of results) {
      const fromPlugin = result.fromPlugin ?? 'Unknown';
      this.knowledge.addPublicPath(...(result.publicPaths ?? []));
      this.knowledge.addPrependUrl(...(result.prependUrls ?? []));

      for (const discovered of result.urls ?? []) {
        this.enqueueNow(normalizeUrl(discovered.url), {
          url: normalizeUrl(discovered.url),
          fromUrl: script.sourceUrl,
          fromPlugin,
          isInline: true,
        });
      }

      for (const target of result.probeTargets ?? []) {
        await this.dispatchProbeTarget(
          { ...target, fromUrl: target.fromUrl ?? script.sourceUrl },
          fromPlugin,
          // `inline: true` resolves asynchronous fragments synchronously, which
          // also avoids unbounded iteration.
          true,
          signal,
        );
      }

      for (const intermediate of result.intermediates ?? []) {
        this.enqueueIntermediate(intermediate, fromPlugin);
      }
    }
  }

  /** Issue a plugin-requested probe and dispatch the response. */
  private async processProbeRequest(
    probe: ProbeRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    const key = `probe:${probe.url}`;
    if (!this.knowledge.claimUrl(key)) {
      return;
    }

    let result;
    try {
      result = await this.fetcher.fetchWithHeaders(probe.url, probe.headers, signal);
    } catch (err) {
      this.debugLog(
        `probe failed: ${probe.url}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    if (result.statusCode < 200 || result.statusCode >= 300) {
      return;
    }

    const kind = detectContentKind(result.contentType, result.content, probe.url);

    // A flight payload sometimes arrives with an HTML content type; the `I[`
    // marker distinguishes real flight data from an error page.
    const head = new TextDecoder('utf-8', { fatal: false })
      .decode(result.content.subarray(0, 200))
      .trim();
    if (kind === 'html' && !head.includes('I[')) {
      return;
    }

    const input: AnalyzeInput = {
      sourceUrl: probe.url,
      contentType: kind === 'html' ? 'flight' : 'flight',
      content: result.content,
      headers: result.headers,
      text: decodeUtf8(result.content),
    };

    const results = await this.dispatchPlugins(input);
    await this.processResults(results, probe.url, signal);
  }

  /**
   * Resolve a probe target into concrete URLs.
   *
   * Three shapes, in order of handling:
   *
   * 1. Absolute URL — queue directly.
   * 2. Bare filename (`chunk.js`) — join onto the discovering document's
   *    directory, then onto every known prepend prefix.
   * 3. Path fragment (`static/js/async/chunk.js`) — defer to
   *    {@link resolveFragment}, which matches against known-good URLs.
   */
  private async dispatchProbeTarget(
    target: DiscoveredResource,
    fromPlugin: string,
    inline: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.knowledge.claimFragment(target.url)) {
      return;
    }

    if (target.url.includes('://')) {
      this.enqueueNow(normalizeUrl(target.url), {
        url: target.url,
        fromUrl: target.fromUrl,
        fromPlugin,
      });
      return;
    }

    if (!target.url.includes('/')) {
      // Bare filename.
      const fromUrl = target.fromUrl ?? '';
      const dir = fromUrl === '' ? '' : getDirFromUrl(fromUrl);
      if (dir !== '') {
        this.enqueueNow(normalizeUrl(dir + target.url), {
          url: dir + target.url,
          fromUrl,
          fromPlugin,
        });
      }
      for (const prefix of this.knowledge.getPrependUrls()) {
        const withSlash = prefix.endsWith('/') ? prefix : `${prefix}/`;
        this.enqueueNow(normalizeUrl(withSlash + target.url), {
          url: withSlash + target.url,
          fromUrl,
          fromPlugin,
        });
      }
      return;
    }

    // A path fragment. Inline-script fragments resolve immediately; ordinary ones
    // go through the fragment queue so they can be matched against as many known
    // URLs as possible.
    if (inline) {
      for (const candidate of this.resolveFragment(target.url, target.fromUrl ?? '')) {
        this.enqueueNow(normalizeUrl(candidate), {
          url: candidate,
          fromUrl: target.fromUrl,
          fromPlugin,
        });
      }
      return;
    }

    this.fragments.push({ ...target, fromPlugin });
    void signal;
  }

  /** Resolve every pending fragment. */
  private async processFragments(signal?: AbortSignal): Promise<void> {
    const batch = this.fragments;
    this.fragments = [];
    if (batch.length === 0) {
      return;
    }

    this.debugLog(`resolving ${batch.length} fragments`);

    for (const fragment of batch) {
      if (signal?.aborted) {
        return;
      }
      const candidates = this.resolveFragment(
        fragment.url,
        fragment.fromUrl ?? '',
      );
      for (const candidate of candidates) {
        this.enqueueNow(normalizeUrl(candidate), {
          url: candidate,
          fromUrl: fragment.fromUrl,
          fromPlugin: fragment.fromPlugin,
        });
      }
    }
  }

  /**
   * Expand a path fragment into candidate URLs.
   *
   * A webpack runtime may reference `static/js/async/chunk-abc.js` with no host.
   * The fragment is matched against URLs already confirmed to exist: if a known
   * URL's directory ends with the fragment's directory, the fragment's filename
   * is appended to that directory. Several additional strategies run
   * unconditionally because a single known-path match can pick the wrong
   * directory — module-federation hosts and remotes commonly have byte-identical
   * `async/` trees, and matching only the first would miss the host's chunks.
   *
   * Chunk-id patterns like `209-*.js` carry a hash that only exists inside the
   * runtime, so they are skipped: there is nothing to probe.
   */
  resolveFragment(fragment: string, sourceUrl: string): string[] {
    const hasPath = fragment.includes('/');
    const lastSlash = hasPath ? fragment.lastIndexOf('/') : -1;
    const fragmentPath = hasPath ? fragment.slice(0, lastSlash + 1) : '';
    const fragmentFile = hasPath ? fragment.slice(lastSlash + 1) : fragment;

    if (fragmentFile.endsWith('-*.js') || fragmentFile.endsWith('-*.css')) {
      return [];
    }

    const candidates: string[] = [];

    // Strategy 1: match the fragment's directory against known-good URLs.
    if (hasPath && fragmentFile !== '') {
      const trimmedFragmentPath = fragmentPath.replace(/\/$/, '');
      for (const knownPath of this.knowledge.getKnownPaths()) {
        const knownDir = getDirFromUrl(knownPath);
        if (knownDir === '') {
          continue;
        }
        const trimmedKnownDir = knownDir.replace(/\/$/, '');
        if (
          trimmedFragmentPath !== '' &&
          trimmedKnownDir.endsWith(trimmedFragmentPath)
        ) {
          candidates.push(joinUrlPath(knownDir, fragmentFile));
        }
      }
    }

    // Strategy 2: bare filename against the discovering document's directory.
    if (!hasPath && fragmentFile !== '') {
      const dir = sourceUrl === '' ? '' : getDirFromUrl(sourceUrl);
      if (dir !== '') {
        candidates.push(joinUrlPath(dir, fragmentFile));
      }
      for (const prefix of this.knowledge.getPrependUrls()) {
        const withSlash = prefix.endsWith('/') ? prefix : `${prefix}/`;
        candidates.push(withSlash + fragmentFile);
      }
    }

    // Strategy 3: for path fragments, try the fragment path against every origin
    // we know about. This is what recovers the host side when a remote's
    // identically-named directory matched first in strategy 1.
    if (hasPath) {
      const fullPath = fragmentPath + fragmentFile;

      for (const prefix of this.knowledge.getPrependUrls()) {
        candidates.push(joinUrlPath(prefix, fullPath));
      }

      const sourceOrigin = sourceUrl === '' ? '' : getBaseUrl(sourceUrl);
      let originForPublicPaths = sourceOrigin;

      for (const publicPath of this.knowledge.getPublicPaths()) {
        let pathToUse = publicPath;
        if (isAbsoluteUrl(publicPath)) {
          const parsed = safeUrl(publicPath);
          if (parsed) {
            pathToUse = parsed.pathname;
            originForPublicPaths = `${parsed.protocol}//${parsed.host}`;
          }
        }
        candidates.push(joinUrlPath(originForPublicPaths + pathToUse, fullPath));
      }

      // Only the scan origin participates here. Joining the fragment
      // onto every known origin, but that is what produced unrelated third-party
      // URLs: a documentation bundle contains literals like `"/App.js"` (a key in
      // an interactive playground's virtual filesystem), and joining that onto a
      // CDN origin yields `https://unpkg.com/App.js`, which resolves to the `app`
      // npm package. Restricting the cross-origin expansion to the scan origin
      // gives the intended output, where those URLs never appear.
      const scanOrigin = getBaseUrl(this.baseUrl);
      if (scanOrigin !== '') {
        candidates.push(joinUrlPath(scanOrigin, fullPath));
      }

      // A root-relative fragment joins straight onto the document's origin, which
      // is the cross-origin case.
      if (fragment.startsWith('/') && sourceOrigin !== '') {
        candidates.push(sourceOrigin + fragment);
      }
    }

    return unique(candidates);
  }

  // ===== Source maps =====

  /**
   * Probe for a `.map` beside a JS file and restore sources if found.
   *
   * `HEAD` first because a `.map` is frequently absent and a full `GET` per
   * bundle is wasteful. The content type is checked because a WAF that blocks
   * `.map` requests answers with an HTML error page and a 200.
   */
  private async probeSourceMap(jsUrl: string, signal?: AbortSignal): Promise<void> {
    if (this.knowledge.jsHasSourceMapUrl(jsUrl)) {
      return;
    }

    const mapUrl = buildSourceMapUrl(jsUrl);
    if (!this.knowledge.claimUrl(mapUrl)) {
      return;
    }

    // A cached map means the whole network round trip can be skipped.
    const cachedMap = await this.loadSourceMapFromCache(jsUrl);
    if (cachedMap) {
      this.debugLog(`source map cache hit: ${mapUrl}`);
      this.knowledge.setJsHasSourceMap(jsUrl, true);
      this.sourceMapByJs.set(jsUrl, mapUrl);
      await this.restoreSources(jsUrl, mapUrl, cachedMap, signal);
      return;
    }

    let head;
    try {
      head = await this.fetcher.fetchWithStatusHead(mapUrl, signal);
    } catch (err) {
      this.debugLog(
        `source map HEAD failed: ${mapUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    if (head.statusCode < 200 || head.statusCode >= 300) {
      return;
    }

    const contentType = head.contentType.toLowerCase();
    // An HTML content type here is an error page, not a map.
    if (contentType.includes('text/html')) {
      return;
    }
    if (
      contentType.startsWith('image/') ||
      contentType.startsWith('text/css') ||
      contentType.startsWith('font/') ||
      contentType.startsWith('text/plain')
    ) {
      return;
    }

    let mapContent: Uint8Array;
    try {
      mapContent = await this.fetcher.fetch(mapUrl, signal);
    } catch (err) {
      this.debugLog(
        `source map GET failed: ${mapUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    if (!isValidSourceMap(mapContent)) {
      this.debugLog(`not a valid source map, skipping: ${mapUrl}`);
      return;
    }

    this.debugLog(`found source map: ${mapUrl}`);
    this.knowledge.setJsHasSourceMap(jsUrl, true);
    this.sourceMapByJs.set(jsUrl, mapUrl);

    await this.storage.write(
      { scope: this.scope, subdir: 'source_map', path: `${this.relativePath(jsUrl)}.map` },
      mapContent,
    );

    await this.restoreSources(jsUrl, mapUrl, mapContent, signal);
  }

  /** Handle a `.map` URL that was discovered and queued directly. */
  private async handleSourceMapUrl(
    url: string,
    context: QueuedUrl,
    content: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    const fromUrl = context.fromUrl ?? '';

    let mapContent = content;
    if (!this.knowledge.isSeenUrl(`map-loaded:${url}`)) {
      this.knowledge.markSeenUrl(`map-loaded:${url}`);
      const cached = await this.loadSourceMapFromCache(fromUrl);
      if (cached) {
        mapContent = cached;
      }
    }

    if (!isValidSourceMap(mapContent)) {
      this.debugLog(`not a valid source map, skipping: ${url}`);
      return;
    }

    if (fromUrl !== '') {
      this.sourceMapByJs.set(fromUrl, url);
      await this.storage.write(
        { scope: this.scope, subdir: 'source_map', path: `${this.relativePath(fromUrl)}.map` },
        mapContent,
      );
    }

    await this.restoreSources(fromUrl, url, mapContent, signal);
  }

  /** Handle an inline `data:` source map. */
  private async handleDataUri(
    sourceJsUrl: string,
    dataUri: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const decoded = decodeDataUri(dataUri);
    if (!decoded) {
      return;
    }

    const relPath = this.relativePath(sourceJsUrl);
    if (relPath !== '') {
      await this.storage.write(
        { scope: this.scope, subdir: 'source_map', path: `${relPath}.map` },
        decoded,
      );
    }

    if (isValidSourceMap(decoded)) {
      this.sourceMapByJs.set(sourceJsUrl, dataUri);
      await this.restoreSources(sourceJsUrl, dataUri, decoded, signal);
    }
  }

  /**
   * Parse a source map and write out the sources it contains.
   *
   * `sourcesContent` is used where present. Where it is missing the minified JS
   * is needed to reconstruct fragments from `mappings`, so it is fetched (or read
   * from cache) only in that case.
   */
  private async restoreSources(
    jsUrl: string,
    mapUrl: string,
    mapContent: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    let map;
    try {
      map = parseSourceMap(mapContent);
    } catch (err) {
      this.debugLog(
        `source map parse failed for ${mapUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    // Only needed for the mappings fallback.
    let minified: Uint8Array | null = null;
    const hasContent = (map.sourcesContent ?? []).some(
      (c) => c !== null && c !== undefined && c !== '',
    );
    if (!hasContent && jsUrl !== '') {
      const cached = await this.storage.read({
        scope: this.scope,
        subdir: 'js',
        path: this.jsCacheFilename(jsUrl),
      });
      if (cached) {
        minified = cached;
      } else {
        try {
          minified = await this.fetcher.fetch(jsUrl, signal);
        } catch {
          // Without it, the mappings fallback cannot run; sourcesContent still can.
        }
      }
    }

    let files;
    try {
      files = restoreFiles(map, minified);
    } catch (err) {
      this.debugLog(
        `source restore failed for ${mapUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    if (files.length === 0) {
      return;
    }

    // Two chunks restoring the same path would collide; the map's own name is
    // used as a directory prefix to keep them apart.
    const mapPrefix = mapFilenamePrefix(mapUrl);
    const written = new Set<string>();
    const restoredPaths: string[] = [];
    let saved = 0;

    for (const file of files) {
      let targetPath = file.path;
      if (written.has(targetPath)) {
        targetPath = `${mapPrefix}/${file.path}`;
      }

      const safe = safeSourcePath(targetPath);
      if (safe === null) {
        this.debugLog(`refusing unsafe source path: ${targetPath}`);
        continue;
      }

      await this.storage.write(
        { scope: this.scope, subdir: 'sources', path: safe },
        new TextEncoder().encode(file.content),
      );

      written.add(targetPath);
      saved++;
      this.restoredTotal++;
      restoredPaths.push(`sources/${safe}`);

      // The content is also returned, so a library caller need not touch disk.
      // The cap keeps a large app's worth of source text out of memory.
      if (this.restoredSources.length < this.maxInlineSources) {
        this.restoredSources.push({
          path: safe,
          content: file.content,
          mode: file.mode === 'sourcesContent' ? 'sourcesContent' : 'mappings',
          fromJs: jsUrl === '' ? undefined : jsUrl,
        });
      }
    }

    if (saved > 0 && jsUrl !== '') {
      this.restoredCountByJs.set(jsUrl, (this.restoredCountByJs.get(jsUrl) ?? 0) + saved);
      const existing = this.restoredPathsByJs.get(jsUrl) ?? [];
      this.restoredPathsByJs.set(jsUrl, [...existing, ...restoredPaths]);
      this.debugLog(`restored ${saved} sources from ${mapUrl}`);
    }
  }

  /** Read a source map from cache, keyed by the JS URL it belongs to. */
  private async loadSourceMapFromCache(jsUrl: string): Promise<Uint8Array | null> {
    if (!this.storage.readable || jsUrl === '') {
      return null;
    }
    const relPath = this.relativePath(jsUrl);
    if (relPath === '') {
      return null;
    }
    return this.storage.read({ scope: this.scope, subdir: 'source_map', path: `${relPath}.map` });
  }

  /** Path of a URL relative to the scan origin, e.g. `/static/js/app.js`. */
  private relativePath(url: string): string {
    const origin = getBaseUrl(this.baseUrl);
    if (origin === '' || !url.startsWith(origin)) {
      return '';
    }
    return url.slice(origin.length);
  }

  /**
   * As {@link relativePath}, but without the leading slash.
   *
   * Metadata records paths relative to the cache root, and the storage layer
   * flattens a leading slash away when it writes. Concatenating the raw form into
   * a `subdir/path` string would therefore produce `source_map//static/x.js.map`,
   * which does not match the file on disk. Avoided here by deriving metadata
   * paths from the already-resolved absolute path; stripping here is the
   * equivalent.
   */
  private relativePathNoLeadingSlash(url: string): string {
    return this.relativePath(url).replace(/^\/+/, '');
  }

  // ===== Metadata =====

  /** Persist `meta.json` so a later run can skip discovery entirely. */
  private async saveSiteMetadata(): Promise<void> {
    if (!this.storage.writable) {
      return;
    }

    const urls: JsMetadata[] = this.jsEntries.map((entry) => {
      // The slash-stripped form, because metadata paths are relative to the cache
      // root and must match what the storage layer actually wrote.
      const relPath = this.relativePathNoLeadingSlash(entry.url);
      const restoredCount = this.restoredCountByJs.get(entry.url) ?? 0;

      const meta: JsMetadata = {
        url: entry.url,
        localPath: `js/${this.jsCacheFilename(entry.url)}`,
        sourceUrl: entry.fromUrl ?? '',
        isInline: entry.isInline ?? false,
        fromPlugin: entry.fromPlugin,
        discoveredAt: Math.floor(Date.now() / 1000),
      };

      if (
        (this.knowledge.jsHasSourceMapUrl(entry.url) || restoredCount > 0) &&
        relPath !== ''
      ) {
        meta.sourceMapUrl = buildSourceMapUrl(entry.url);
        meta.sourceMapPath = `source_map/${relPath}.map`;
      }

      if (restoredCount > 0) {
        meta.sourcesRestored = true;
        meta.restoredSourceCount = restoredCount;
        const paths = this.restoredPathsByJs.get(entry.url);
        if (paths && paths.length > 0) {
          meta.restoredSources = paths;
        }
      }

      return meta;
    });

    // Directory prefixes derived from discovered URLs become prepend candidates
    // for the next run's fragment resolution.
    const prependUrls = [...this.knowledge.getPrependUrls()];
    const origin = getBaseUrl(this.baseUrl);
    const seenPrefixes = new Set<string>();
    for (const knownPath of this.knowledge.getKnownPaths()) {
      if (origin === '' || !knownPath.startsWith(origin)) {
        continue;
      }
      const relative = knownPath.slice(origin.length);
      const lastSlash = relative.lastIndexOf('/');
      if (lastSlash > 0) {
        const prefix = relative.slice(0, lastSlash + 1);
        if (!seenPrefixes.has(prefix)) {
          seenPrefixes.add(prefix);
          prependUrls.push(origin + prefix);
        }
      }
    }

    const cacheDirs: SiteMetadata['cacheDirs'] = {
      html: 'html/web.html',
      js: 'js',
    };
    const sourceMapCount = await this.storage.listSources(this.scope);
    if (this.sourceMapByJs.size > 0 || sourceMapCount.length > 0) {
      cacheDirs.sourceMap = 'source_map';
    }
    const sources = await this.storage.listSources(this.scope);
    if (sources.length > 0) {
      cacheDirs.sources = 'sources';
    }

    const metadata: SiteMetadata = {
      urls,
      prependUrls: unique(prependUrls),
      publicPaths: this.knowledge.getPublicPaths(),
      cacheDirs,
      discoveredAt: Math.floor(Date.now() / 1000),
    };

    await this.storage.writeMetadata(
      this.scope,
      new TextEncoder().encode(JSON.stringify(metadata, null, 2)),
    );
  }

  /**
   * Restore a previous run's findings from `meta.json`.
   *
   * Why bypass rediscovery rather than just warming the cache: discovery order
   * depends on fragment resolution, and a partially-warm cache produces a
   * different traversal than a cold one. Replaying the recorded list guarantees
   * the same result as the run that wrote it.
   */
  private async tryRestoreFromMetadata(signal?: AbortSignal): Promise<boolean> {
    if (!this.storage.readable) {
      return false;
    }

    const raw = await this.storage.readMetadata(this.scope);
    if (!raw) {
      return false;
    }

    let metadata: SiteMetadata;
    try {
      metadata = JSON.parse(new TextDecoder().decode(raw)) as SiteMetadata;
    } catch (err) {
      this.debugLog(
        `meta.json parse failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }

    if (!Array.isArray(metadata.urls) || metadata.urls.length === 0) {
      return false;
    }

    this.knowledge.addPrependUrl(...(metadata.prependUrls ?? []));
    this.knowledge.addPublicPath(...(metadata.publicPaths ?? []));

    for (const entry of metadata.urls) {
      if (entry.url === '') {
        continue;
      }
      const normalized = normalizeUrl(entry.url);
      this.knowledge.markSeenUrl(normalized);
      this.knowledge.addKnownPath(normalized);

      const jsEntry: JsEntry = {
        url: normalized,
        fromUrl: entry.sourceUrl,
        fromPlugin: entry.fromPlugin,
        isInline: entry.isInline,
      };
      if (!this.emitted.has(normalized)) {
        this.emitted.add(normalized);
        this.jsEntries.push(jsEntry);
      }

      if (entry.sourceMapUrl === undefined || entry.sourceMapUrl === '') {
        continue;
      }

      this.knowledge.setJsHasSourceMap(normalized, true);
      this.sourceMapByJs.set(normalized, entry.sourceMapUrl);

      // When the restored files are still on disk, the source map does not need
      // re-parsing. The content is read back rather than skipped: it could be skipped
      // because it only ever reported counts, but this port returns the restored
      // content, so a cache-warm run that skipped the read would report a source
      // count with an empty `sources` array.
      const stillOnDisk =
        entry.sourcesRestored === true &&
        (entry.restoredSources?.length ?? 0) > 0 &&
        (await this.sourcesPresent(entry.restoredSources ?? []));
      if (stillOnDisk) {
        const paths = entry.restoredSources ?? [];
        this.restoredTotal += paths.length;
        this.restoredCountByJs.set(normalized, paths.length);
        this.restoredPathsByJs.set(normalized, paths);

        let loaded = 0;
        for (const rel of paths) {
          const safe = sourceKeyFromRelPath(rel);
          if (safe === null) {
            continue;
          }
          const content = await this.storage.read({
            scope: this.scope,
            subdir: 'sources',
            path: safe,
          });
          if (!content) {
            continue;
          }
          loaded++;
          if (this.restoredSources.length < this.maxInlineSources) {
            this.restoredSources.push({
              path: safe,
              content: new TextDecoder('utf-8', { fatal: false }).decode(content),
              // The restore mode is not persisted in metadata, so a file read back
              // from disk is reported as `sourcesContent`. Mapping-derived files
              // carry their provenance in a header comment in the content itself.
              mode: 'sourcesContent',
              fromJs: normalized,
            });
          }
        }

        this.debugLog(
          `metadata: loaded ${loaded}/${paths.length} restored sources from disk for ${normalized}`,
        );
        continue;
      }

      const cachedMap = await this.loadSourceMapFromCache(normalized);
      if (cachedMap) {
        await this.restoreSources(normalized, entry.sourceMapUrl, cachedMap, signal);
      }
    }

    return this.jsEntries.length > 0;
  }

  /** Whether every listed restored source is still present on disk. */
  private async sourcesPresent(relPaths: readonly string[]): Promise<boolean> {
    for (const rel of relPaths) {
      const withoutPrefix = rel.startsWith('sources/') ? rel.slice('sources/'.length) : rel;
      const safe = safeSourcePath(withoutPrefix);
      if (safe === null) {
        return false;
      }
      const present = await this.storage.exists({
        scope: this.scope,
        subdir: 'sources',
        path: safe,
      });
      if (!present) {
        return false;
      }
    }
    return true;
  }

  // ===== Result assembly =====

  /** Assemble the structured result, including cache statistics. */
  async getResult(): Promise<ScanResult> {
    const jsUrls = this.jsEntries.map((e) => e.url);

    const result: ScanResult = {
      summary: {
        jsCount: this.jsEntries.length,
        sourceMapCount: 0,
        sourceCount: this.restoredTotal,
      },
      jsUrls,
      jsDetails: this.jsEntries.map((e) => ({ ...e })),
      htmlEntries: this.htmlEntries.map((e) => ({ ...e })),
      sources: this.restoredSources,
      sourcesOmitted: Math.max(0, this.restoredTotal - this.restoredSources.length),
    };

    if (this.sourceMapByJs.size > 0) {
      result.sourceMaps = Object.fromEntries(this.sourceMapByJs);
    }

    // Cache statistics need a real filesystem, so only the on-disk store reports
    // them. A `NullStorage` leaves these fields unset, and the Markdown renderer
    // prints "cache disabled".
    const fsStorage = this.storage as Storage & {
      baseDir?: string;
      countFiles?: (scope: string, subdir: string) => Promise<number>;
      listSources?: (scope: string) => Promise<string[]>;
      sourcesDir?: (scope: string) => Promise<string>;
    };

    if (
      this.storage.writable &&
      typeof fsStorage.baseDir === 'string' &&
      fsStorage.baseDir !== '' &&
      typeof fsStorage.countFiles === 'function'
    ) {
      const cacheBase = joinFsPath(fsStorage.baseDir, this.scope);
      result.cacheBase = cacheBase;

      const sourceMapCount = await fsStorage.countFiles(this.scope, 'source_map');
      result.summary.sourceMapCount = sourceMapCount;

      const dirs: CacheDirs = {
        js: joinFsPath(cacheBase, 'js'),
        html: joinFsPath(cacheBase, 'html', 'web.html'),
      };
      if (sourceMapCount > 0) {
        dirs.sourceMap = joinFsPath(cacheBase, 'source_map');
      }
      if (typeof fsStorage.sourcesDir === 'function') {
        const sourcesDir = await fsStorage.sourcesDir(this.scope);
        if (this.restoredTotal > 0) {
          dirs.source = sourcesDir;
        }
      }
      result.cacheDirs = dirs;
    } else if (this.restoredTotal > 0 || this.sourceMapByJs.size > 0) {
      // A non-filesystem store can still report counts, just not paths.
      result.summary.sourceMapCount = this.sourceMapByJs.size;
    }

    return result;
  }

  // ===== Diagnostics =====

  private debugLog(message: string): void {
    if (this.debug) {
      this.logger.debug(message);
    }
  }
}

// ===== Module helpers =====

/**
 * Convert a `sources/<path>` metadata entry into a storage key path.
 *
 * Returns `null` when the entry cannot be made safe, which is the signal to skip
 * it rather than risk writing outside the store.
 */
function sourceKeyFromRelPath(relPath: string): string | null {
  const withoutPrefix = relPath.startsWith('sources/')
    ? relPath.slice('sources/'.length)
    : relPath;
  return safeSourcePath(withoutPrefix);
}

/** Whether an error represents a cancellation rather than a transport failure. */
function isAbortLike(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.message.includes('aborted'))
  );
}

/** Decode bytes as UTF-8, replacing malformed sequences rather than throwing. */
function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/** Parse a URL, returning `null` instead of throwing. */
function safeUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Whether content is a usable source map.
 *
 * Guards against a WAF answering a `.map` request with a 200 and an HTML error
 * page. A leading `<` rules that out immediately; otherwise the JSON must parse
 * and carry a `sources` array.
 */
export function isValidSourceMap(content: Uint8Array): boolean {
  if (content.byteLength === 0) {
    return false;
  }

  const head = decodeUtf8(content.subarray(0, Math.min(content.byteLength, 200))).trim();

  if (head.startsWith('<!DOCTYPE') || head.startsWith('<html') || head.startsWith('<')) {
    return false;
  }
  if (!head.startsWith('{')) {
    return false;
  }

  try {
    parseSourceMap(content);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prefix used to disambiguate same-named sources restored from different chunks.
 * Derived from the map's filename with `.map` stripped.
 */
function mapFilenamePrefix(mapUrl: string): string {
  let name = mapUrl;
  const cut = name.search(/[?#]/);
  if (cut > 0) {
    name = name.slice(0, cut);
  }
  const lastSlash = name.lastIndexOf('/');
  if (lastSlash >= 0) {
    name = name.slice(lastSlash + 1);
  }
  if (name.endsWith('.map')) {
    name = name.slice(0, -'.map'.length);
  }

  let out = '';
  for (const ch of name) {
    const code = ch.codePointAt(0)!;
    if (
      ch === '/' ||
      ch === '\\' ||
      ch === ':' ||
      ch === '*' ||
      ch === '?' ||
      ch === '"' ||
      ch === '<' ||
      ch === '>' ||
      ch === '|' ||
      code < 0x20
    ) {
      out += '_';
    } else {
      out += ch;
    }
  }
  return out === '' ? 'map' : out;
}

/**
 * Decode a `data:` URI payload.
 *
 * Returns `null` for anything that is not a data URI or fails to decode.
 * Base64 is detected from the media-type parameters.
 */
export function decodeDataUri(dataUri: string): Uint8Array | null {
  if (!dataUri.startsWith('data:')) {
    return null;
  }

  const rest = dataUri.slice('data:'.length);
  const comma = rest.indexOf(',');
  if (comma < 0) {
    return null;
  }

  const meta = rest.slice(0, comma);
  const payload = rest.slice(comma + 1);

  if (meta.includes('base64')) {
    try {
      const binary = atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    } catch {
      return null;
    }
  }

  try {
    return new TextEncoder().encode(decodeURIComponent(payload));
  } catch {
    return null;
  }
}

/** Join path segments using `/`, independent of the host OS. */
function joinFsPath(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, '') : p.replace(/^\/+|\/+$/g, '')))
    .filter((p) => p !== '')
    .join('/');
}