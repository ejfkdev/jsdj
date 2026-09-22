/**
 * Cache option semantics.
 *
 * These four options have overlapping names and subtly different meanings, and the
 * distinction is easy to get wrong in a way that is invisible until it matters:
 *
 * | option            | reads | writes |
 * |-------------------|-------|--------|
 * | (default)         | yes   | yes    |
 * | `noCache: true`   | no    | yes    |
 * | `cache: false`    | no    | yes    |
 * | `writeCache: false`| yes  | no     |
 *
 * `noCache` reads as "disable the cache", but the reference implementation's
 * `--no-cache` means "go to the network, and still save what you downloaded". A
 * disabled cache that also refuses writes discards the artifacts a forced rescan
 * just fetched, which is the opposite of useful.
 *
 * All four must also apply when the caller supplies their own storage. A caller who
 * owns their storage and wants a forced rescan is precisely the case that needs
 * these options, so returning their store unchanged would make them inert.
 */

import { describe, expect, test } from 'bun:test';

import { scan } from '../src/scan.js';
import { MemoryStorage } from '../src/fetcher/memory-storage.js';
import type { StorageKey } from '../src/fetcher/storage.js';
import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
} from '../src/fetcher/types.js';

/** A storage that counts reads and writes. */
class SpyStorage extends MemoryStorage {
  reads = 0;
  writes = 0;
  metadataReads = 0;
  metadataWrites = 0;

  override async read(key: StorageKey): Promise<Uint8Array | null> {
    this.reads++;
    return super.read(key);
  }

  override async write(key: StorageKey, content: Uint8Array): Promise<void> {
    this.writes++;
    return super.write(key, content);
  }

  override async readMetadata(scope: string): Promise<Uint8Array | null> {
    this.metadataReads++;
    return super.readMetadata(scope);
  }

  override async writeMetadata(scope: string, content: Uint8Array): Promise<void> {
    this.metadataWrites++;
    return super.writeMetadata(scope, content);
  }
}

/** The fixture site, served from memory. */
const SITE: Record<string, { body: string; contentType?: string }> = {
  '/': {
    contentType: 'text/html',
    body: '<html><script src="/entry.js"></script></html>',
  },
  '/entry.js': { body: 'import("./lazy.js");' },
  '/lazy.js': { body: 'export const lazy = 1;' },
};

function transport(): { client: HttpClient; calls: number } {
  const state = { calls: 0 };
  const client: HttpClient = {
    async request(req: HttpRequest): Promise<HttpResponse> {
      state.calls++;
      const path = new URL(req.url).pathname;
      const entry = SITE[path];
      return {
        status: entry ? 200 : 404,
        headers: {
          'content-type': entry?.contentType ?? (entry ? 'application/javascript' : 'text/html'),
        },
        body: new TextEncoder().encode(entry?.body ?? '<html>404</html>'),
        finalUrl: req.url,
      };
    },
    async head(req: HttpRequest): Promise<HttpResponse> {
      return this.request({ ...req, method: 'HEAD' });
    },
  };
  return { client, get calls() { return state.calls; } } as { client: HttpClient; calls: number };
}

const TARGET = 'https://example.test/';

describe('cache options', () => {
  test('the default reads and writes', async () => {
    const storage = new SpyStorage();
    const t = transport();
    await scan({ url: TARGET, storage, transport: { client: t.client } });

    expect(storage.reads).toBeGreaterThan(0);
    expect(storage.writes).toBeGreaterThan(0);
  });

  test('noCache suppresses reads but keeps writes', async () => {
    const storage = new SpyStorage();
    const t = transport();
    const result = await scan({
      url: TARGET,
      storage,
      transport: { client: t.client },
      noCache: true,
    });

    expect(result.summary.jsCount).toBe(2);
    expect(storage.reads).toBe(0);
    expect(storage.metadataReads).toBe(0);
    // The artifacts from this run are kept, so the next scan can replay them.
    expect(storage.writes).toBeGreaterThan(0);
    expect(storage.metadataWrites).toBeGreaterThan(0);
  });

  test('cache: false behaves like noCache', async () => {
    const storage = new SpyStorage();
    const t = transport();
    await scan({
      url: TARGET,
      storage,
      transport: { client: t.client },
      cache: false,
    });

    expect(storage.reads).toBe(0);
    expect(storage.writes).toBeGreaterThan(0);
  });

  test('writeCache: false suppresses writes but keeps reads', async () => {
    const storage = new SpyStorage();
    const t = transport();
    await scan({
      url: TARGET,
      storage,
      transport: { client: t.client },
      writeCache: false,
    });

    expect(storage.reads).toBeGreaterThan(0);
    expect(storage.writes).toBe(0);
  });

  test('the options apply when storage is supplied by the caller', async () => {
    // The combination a service uses: it owns its storage and asks for a forced
    // refresh. Passing the store through untouched would ignore the option.
    const storage = new SpyStorage();
    const t = transport();
    await scan({
      url: TARGET,
      storage,
      transport: { client: t.client },
      noCache: true,
    });

    expect(storage.reads).toBe(0);
    expect(storage.writes).toBeGreaterThan(0);
  });

  test('a warm store is replayed without touching the network', async () => {
    const storage = new MemoryStorage();

    const first = transport();
    const cold = await scan({
      url: TARGET,
      storage,
      transport: { client: first.client },
    });
    const callsAfterCold = first.calls;
    expect(callsAfterCold).toBeGreaterThan(0);

    const second = transport();
    const warm = await scan({
      url: TARGET,
      storage,
      transport: { client: second.client },
    });

    // Identical result, and the second scan issued no requests at all.
    expect([...warm.jsUrls].sort()).toEqual([...cold.jsUrls].sort());
    expect(second.calls).toBe(0);
  });

  test('noCache on a warm store goes back to the network', async () => {
    const storage = new MemoryStorage();

    const first = transport();
    await scan({ url: TARGET, storage, transport: { client: first.client } });

    const second = transport();
    await scan({
      url: TARGET,
      storage,
      transport: { client: second.client },
      noCache: true,
    });

    expect(second.calls).toBeGreaterThan(0);
  });
});