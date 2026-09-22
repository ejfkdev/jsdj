/**
 * The scan entry point.
 *
 * This is the one high-level function: assemble a transport, a store, a plugin
 * set, run the pipeline, and hand back a structured result. Everything it does is
 * also reachable directly — {@link discover} for the narrow "just give me the JS
 * URLs" case, or the pipeline and plugins individually for full control.
 */

import { Fetcher } from './fetcher/fetcher.js';
import { NullStorage } from './fetcher/memory-storage.js';
import type { HttpClient, HttpRequest, HttpResponse } from './fetcher/types.js';
import type { Storage } from './fetcher/storage.js';
import { Pipeline } from './extractor/pipeline.js';
import { PluginRegistry } from './extractor/registry.js';
import { nullLogger } from './extractor/logger.js';
import { isAbsoluteUrl } from './extractor/url.js';
import { createDefaultRegistry } from './plugins/index.js';
import type { FetchInjection, ScanOptions, ScanResult } from './scan-options.js';

// Re-exported so the entry point can surface them from one module.
export type { FetchInjection, ScanOptions, ScanResult };

/** Thrown for invalid scan input or configuration. */
export class ScanInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScanInputError';
  }
}

/**
 * Run a scan and return the full result.
 *
 * ```ts
 * const result = await scan({ url: 'https://example.com' });
 * console.log(result.jsUrls);
 * const appSource = result.sources.find((s) => s.path === 'src/App.tsx');
 * ```
 */
export async function scan(options: ScanOptions): Promise<ScanResult> {
  const prepared = await prepare(options);

  try {
    const { result } = await prepared.pipeline.run(options.url, options.signal);
    return result;
  } finally {
    // Only tear down what this function created; a caller-supplied client or
    // storage stays open for reuse.
    if (prepared.ownsFetcher) {
      await prepared.fetcher.close();
    }
  }
}

/**
 * Run a scan and return only the discovered JS URLs.
 *
 * Avoids materialising the rest of the result, so it is cheaper when the source
 * content is not wanted. Note that source restoration still happens — the files
 * are written to storage either way; only the in-memory copy is skipped.
 */
export async function discover(options: ScanOptions): Promise<string[]> {
  const { jsUrls } = await scanWithPipeline({
    ...options,
    maxInlineSources: 0,
  });
  return jsUrls;
}

/** Run a scan, returning both the URL list and the full result. */
export async function scanWithPipeline(options: ScanOptions): Promise<{
  jsUrls: string[];
  result: ScanResult;
}> {
  const prepared = await prepare(options);
  try {
    return await prepared.pipeline.run(options.url, options.signal);
  } finally {
    if (prepared.ownsFetcher) {
      await prepared.fetcher.close();
    }
  }
}

/** The assembled pieces a scan runs with. */
interface Prepared {
  pipeline: Pipeline;
  fetcher: Fetcher;
  /** Whether the fetcher was created here and should be closed afterwards. */
  ownsFetcher: boolean;
}

/** Validate options and assemble the pipeline. Exported for advanced callers. */
export async function prepare(options: ScanOptions): Promise<Prepared> {
  if (typeof options.url !== 'string' || options.url === '') {
    throw new ScanInputError('url is required');
  }
  if (!isAbsoluteUrl(options.url)) {
    throw new ScanInputError(
      `invalid url ${JSON.stringify(options.url)} (expected http:// or https://)`,
    );
  }

  const registry = buildRegistry(options);
  const fetcher = createFetcher(options);
  const storage = await createStorageFor(options);

  const pipeline = new Pipeline({
    registry,
    fetcher,
    storage,
    debug: options.debug ?? false,
    logger: options.logger ?? nullLogger(),
    maxInlineSources: options.maxInlineSources,
  });

  return {
    pipeline,
    fetcher,
    ownsFetcher: options.transport === undefined,
  };
}

/** Choose the plugin registry for a scan. */
function buildRegistry(options: ScanOptions): PluginRegistry {
  if (options.plugins) {
    return options.plugins;
  }

  const base = createDefaultRegistry();

  if (options.onlyPlugins && options.onlyPlugins.length > 0) {
    return base.select(options.onlyPlugins);
  }
  if (options.excludePlugins && options.excludePlugins.length > 0) {
    return base.exclude(options.excludePlugins);
  }
  return base;
}

/** Build the request engine, honouring any injected transport. */
function createFetcher(options: ScanOptions): Fetcher {
  const client = options.transport ? clientFrom(options.transport) : undefined;

  const fetcher = new Fetcher({
    proxy: options.proxy,
    userAgent: options.userAgent,
    tlsFingerprint: options.tlsFingerprint,
    timeoutMs: options.timeoutMs,
    concurrency: options.concurrency,
    maxBodySize: options.maxBodySize,
    client,
  });

  if (options.headers) {
    fetcher.setExtraHeaders(options.headers);
  }
  if (options.cookie) {
    // Injected cookies are scoped to the scan target, as a browser would.
    fetcher.setCookieString(options.url, options.cookie);
  }

  return fetcher;
}

/**
 * Adapt an injected transport into an {@link HttpClient}.
 *
 * The `fetch`-function form is deliberately thin: it hands the caller exactly the
 * request fields a custom transport needs and nothing else, so a caller doing
 * their own TLS work is not forced to implement a full client interface.
 */
function clientFrom(injection: FetchInjection): HttpClient {
  if ('client' in injection) {
    return injection.client;
  }

  const { fetch } = injection;

  const run = async (req: HttpRequest): Promise<HttpResponse> => {
    const response = await fetch({
      url: req.url,
      method: req.method ?? 'GET',
      headers: req.headers,
    });

    const body =
      typeof response.body === 'string'
        ? new TextEncoder().encode(response.body)
        : response.body;

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.headers ?? {})) {
      headers[key.toLowerCase()] = value;
    }

    return {
      status: response.status,
      headers,
      body,
      finalUrl: response.finalUrl ?? req.url,
    };
  };

  return {
    request: run,
    head: (req: HttpRequest) => run({ ...req, method: 'HEAD' }),
  };
}

/**
 * Build the artifact store.
 *
 * An explicit store is always used — a caller who supplies one has decided where
 * artifacts live. But the read/write options still apply to it, by wrapping rather
 * than replacing: `noCache` and `cache: false` suppress *reads* while leaving writes
 * alone, which is the `--no-cache` behaviour. Returning the explicit store unchanged
 * would silently ignore those options, and a caller who owns their storage and wants
 * a forced rescan is precisely the case that needs them.
 *
 * Without an explicit store: `noCache` gives a no-op store, and otherwise a file
 * store is created where there is a filesystem and a no-op store where there is not.
 * That last branch is what makes the browser case work with no configuration.
 */
async function createStorageFor(options: ScanOptions): Promise<Storage> {
  // `noCache` and `cache: false` both suppress reads only. Writes continue, because
  // the run goes to the network, but the
  // artifacts it downloaded are still saved for next time. `writeCache: false` is
  // the option for suppressing writes.
  const readable = !options.noCache && options.cache !== false;
  const writable = options.writeCache !== false;

  if (options.storage) {
    return applyAccess(options.storage, readable, writable);
  }


  // A platform with no filesystem gets the no-op store, which is the specified
  // browser behaviour: no caching, with the developer supplying a store if they
  // want it.
  const { hasFilesystem } = await import('./fetcher/runtime.js');
  if (!hasFilesystem()) {
    return new NullStorage();
  }

  // Imported dynamically so the browser bundle never contains a reference to
  // `node:fs`, `node:os` or `node:path`. A static import here would be pulled in
  // by `browser.js`, because it re-exports `scan`.
  const { FsStorage } = await import('./fetcher/fs-storage.js');
  return FsStorage.create({
    baseDir: options.cacheDir,
    readable,
    writable,
    outputDir: options.outputDir,
  });
}

/**
 * Restrict an existing store's read and write access.
 *
 * Wrapping rather than replacing keeps the caller's storage in place — its scope
 * layout, its location, and any writes already made all stay — while honouring the
 * per-scan read/write options. Returning the store untouched would make `noCache`
 * a no-op whenever a store was supplied, which is the combination a long-running
 * service uses when it needs a forced refresh.
 */
function applyAccess(store: Storage, readable: boolean, writable: boolean): Storage {
  if (readable && writable) {
    return store;
  }
  return {
    readable: store.readable && readable,
    writable: store.writable && writable,
    baseDir: store.baseDir,
    read: (key) => (readable ? store.read(key) : Promise.resolve(null)),
    write: (key, content) =>
      writable ? store.write(key, content) : Promise.resolve(),
    exists: (key) => (readable ? store.exists(key) : Promise.resolve(false)),
    readMetadata: (scope) =>
      readable ? store.readMetadata(scope) : Promise.resolve(null),
    writeMetadata: (scope, content) =>
      writable ? store.writeMetadata(scope, content) : Promise.resolve(),
    listSources: (scope) =>
      readable ? store.listSources(scope) : Promise.resolve([]),
    close: store.close ? () => store.close!() : undefined,
  };
}
