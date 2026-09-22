/**
 * Determinism tests.
 *
 * Discovery is deterministic: an awaitable
 * work queue, so a scan over the same site must produce the same URL set every
 * time. That property is easy to lose: any place where work is admitted in
 * completion order rather than in a fixed order reintroduces the variance, and the
 * symptom (a URL occasionally missing) is easy to mistake for a plugin bug.
 *
 * These tests build a site large enough to exhaust the HTML pivot budget, which is
 * where ordering matters most, and assert that repeated runs agree exactly.
 */

import { describe, expect, test } from 'bun:test';

import { Pipeline } from '../src/extractor/pipeline.js';
import { Fetcher } from '../src/fetcher/fetcher.js';
import { MemoryStorage } from '../src/fetcher/memory-storage.js';
import { nullLogger } from '../src/extractor/logger.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/fetcher/types.js';
import { createDefaultRegistry } from '../src/plugins/index.js';

/**
 * Build a site with many interlinked pages and per-page scripts.
 *
 * The page count deliberately exceeds the pipeline's HTML pivot budget (64) so
 * that admission order decides the outcome — the condition under which
 * non-determinism shows up.
 */
function buildLargeSite(): Record<string, { body: string; contentType?: string }> {
  const site: Record<string, { body: string; contentType?: string }> = {};

  // Depth matters: a single page's links are capped at `MAX_MICRO_APP_ENTRIES`, so
  // the budget is reached across rounds of the crawl rather than from one page. The
  // entry page links to 40 sections, and each section links to 40 pages, which puts
  // far more candidates in play than the 64-page budget allows.
  const sectionLinks = Array.from({ length: 40 }, (_, i) => `<a href="/s${i}">s${i}</a>`).join('');
  site['/'] = {
    contentType: 'text/html',
    body: `<html><head><script src="/entry.js"></script></head><body>${sectionLinks}</body></html>`,
  };
  site['/entry.js'] = { body: `import("./shared.js");` };
  site['/shared.js'] = { body: 'shared' };

  for (let s = 0; s < 40; s++) {
    const links = Array.from({ length: 40 }, (_, i) => `<a href="/s${s}/p${i}">p</a>`).join('');
    site[`/s${s}`] = {
      contentType: 'text/html',
      body: `<html><head><script src="/scripts/s${s}.js"></script></head><body>${links}</body></html>`,
    };
    site[`/scripts/s${s}.js`] = { body: `console.log(${s});` };

    for (let i = 0; i < 40; i++) {
      site[`/s${s}/p${i}`] = {
        contentType: 'text/html',
        body: `<html><head><script src="/scripts/s${s}p${i}.js"></script></head></html>`,
      };
      site[`/scripts/s${s}p${i}.js`] = { body: `console.log(${s}, ${i});` };
    }
    // The `.html` and `/index.html` variants are also probed; answering 404 for
    // them keeps the page count at exactly one candidate per route.
  }

  return site;
}

function clientFor(
  site: Record<string, { body: string; contentType?: string }>,
): HttpClient {
  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      let path: string;
      try {
        path = new URL(req.url).pathname;
      } catch {
        path = req.url;
      }
      const entry = site[path];
      return {
        status: entry ? 200 : 404,
        headers: {
          'content-type': entry?.contentType ?? (entry ? 'application/javascript' : 'text/html'),
        },
        body:
          (req.method ?? 'GET') === 'HEAD'
            ? new Uint8Array(0)
            : new TextEncoder().encode(entry?.body ?? '<html>not found</html>'),
        finalUrl: req.url,
      };
    },
    async head(req: HttpRequest): Promise<HttpResponse> {
      return this.request({ ...req, method: 'HEAD' });
    },
  };
}

async function runOnce(site: Record<string, { body: string; contentType?: string }>) {
  const pipeline = new Pipeline({
    registry: createDefaultRegistry(),
    fetcher: new Fetcher({ client: clientFor(site), concurrency: 8 }),
    storage: new MemoryStorage(),
    logger: nullLogger(),
  });
  const { result } = await pipeline.run('https://example.test/');
  return result;
}

describe('discovery determinism', () => {
  test('a site that exhausts the pivot budget produces an identical result every run', async () => {
    const site = buildLargeSite();

    // Sequential runs against fresh storage, so each does full discovery. Run
    // against a shared cache would trivially agree via meta.json replay and would
    // not exercise the ordering at all.
    const runs = [];
    for (let i = 0; i < 3; i++) {
      runs.push(await runOnce(site));
    }

    const baseline = [...runs[0]!.jsUrls].sort();
    for (const run of runs.slice(1)) {
      expect([...run.jsUrls].sort()).toEqual(baseline);
    }

    // The budget was actually reached, otherwise the test would pass without
    // exercising the ordering path it exists to protect.
    expect(runs[0]!.htmlEntries.length).toBe(64);
    expect(baseline.length).toBeGreaterThan(10);
  });

  test('the entry and script sets are stable, not merely equal in size', async () => {
    const site = buildLargeSite();
    const first = await runOnce(site);
    const second = await runOnce(site);

    expect([...second.jsUrls].sort()).toEqual([...first.jsUrls].sort());
    expect([...second.htmlEntries.map((h) => h.url)].sort()).toEqual(
      [...first.htmlEntries.map((h) => h.url)].sort(),
    );
  });

  test('concurrent runs over separate pipelines agree', async () => {
    // Interleaving three scans in one event loop exercises the scheduling more
    // aggressively than sequential runs.
    const site = buildLargeSite();
    const results = await Promise.all([runOnce(site), runOnce(site), runOnce(site)]);

    const baseline = [...results[0]!.jsUrls].sort();
    for (const result of results.slice(1)) {
      expect([...result.jsUrls].sort()).toEqual(baseline);
    }
  });

  test('the pivot budget is respected as an upper bound', async () => {
    const site = buildLargeSite();
    const result = await runOnce(site);
    // The budget bounds admitted entries; it is not a target to exceed.
    expect(result.htmlEntries.length).toBeLessThanOrEqual(64);
  });
});