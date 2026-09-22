/**
 * The knowledge base: shared state accumulated across a scan.
 *
 * Shared knowledge accumulated across a scan.
 *
 * Every field would need a mutex if plugins ran in goroutines. Here
 * plugins are still dispatched concurrently, so the same care applies — but the
 * locking is simpler (a plain object with explicit read snapshots) since
 * JavaScript has no data races on primitive writes, only on read-modify-write
 * sequences.
 */

/** Accumulated discovery state for a scan. */
export class KnowledgeBase {
  /** `publicPath` values discovered, used as prefixes for fragment resolution. */
  private publicPaths: string[] = [];
  /** URL prefixes to prepend when resolving bare filenames. */
  private prependUrls: string[] = [];
  /** Every URL attempted, whether it succeeded or 404'd. */
  private seenUrls = new Set<string>();
  /** Every probe fragment attempted. */
  private seenFragments = new Set<string>();
  /** URLs confirmed to exist, used as anchors when resolving fragments. */
  private knownPaths: string[] = [];
  /** JS URLs known to have a source map. */
  private jsHasSourceMap = new Set<string>();

  /** Snapshot of `publicPaths`. */
  getPublicPaths(): string[] {
    return [...this.publicPaths];
  }

  /** Record `publicPath` values. Duplicates and empties are ignored. */
  addPublicPath(...paths: string[]): void {
    for (const p of paths) {
      if (p !== '' && !this.publicPaths.includes(p)) {
        this.publicPaths.push(p);
      }
    }
  }

  /** Snapshot of `prependUrls`. */
  getPrependUrls(): string[] {
    return [...this.prependUrls];
  }

  /** Record URL prefixes to prepend to bare filenames. */
  addPrependUrl(...urls: string[]): void {
    for (const u of urls) {
      if (u !== '' && !this.prependUrls.includes(u)) {
        this.prependUrls.push(u);
      }
    }
  }

  /** Record that a URL has been attempted. */
  markSeenUrl(url: string): void {
    this.seenUrls.add(url);
  }

  /** Whether a URL has already been attempted. */
  isSeenUrl(url: string): boolean {
    return this.seenUrls.has(url);
  }

  /**
   * Test and record in one step.
   *
   * Returns `true` when the URL was new, i.e. the caller should proceed. Doing
   * this atomically under a single lock is what prevented two concurrent
   * discoveries of the same URL from both queueing it.
   */
  claimUrl(url: string): boolean {
    if (this.seenUrls.has(url)) {
      return false;
    }
    this.seenUrls.add(url);
    return true;
  }

  /** Record that a fragment has been probed. */
  markSeenFragment(fragment: string): void {
    this.seenFragments.add(fragment);
  }

  /** Whether a fragment has already been probed. */
  isSeenFragment(fragment: string): boolean {
    return this.seenFragments.has(fragment);
  }

  /** Test and record a fragment in one step. */
  claimFragment(fragment: string): boolean {
    if (this.seenFragments.has(fragment)) {
      return false;
    }
    this.seenFragments.add(fragment);
    return true;
  }

  /** Snapshot of `knownPaths`. */
  getKnownPaths(): string[] {
    return [...this.knownPaths];
  }

  /** Record URLs that are known to exist. */
  addKnownPath(...paths: string[]): void {
    for (const p of paths) {
      if (p !== '' && !this.knownPaths.includes(p)) {
        this.knownPaths.push(p);
      }
    }
  }

  /** Record whether a JS URL has a source map. */
  setJsHasSourceMap(url: string, has: boolean): void {
    if (has) {
      this.jsHasSourceMap.add(url);
    } else {
      this.jsHasSourceMap.delete(url);
    }
  }

  /** Whether a JS URL is known to have a source map. */
  jsHasSourceMapUrl(url: string): boolean {
    return this.jsHasSourceMap.has(url);
  }

  /** Reset all state, for reuse of a pipeline instance. */
  clear(): void {
    this.publicPaths = [];
    this.prependUrls = [];
    this.seenUrls.clear();
    this.seenFragments.clear();
    this.knownPaths = [];
    this.jsHasSourceMap.clear();
  }
}