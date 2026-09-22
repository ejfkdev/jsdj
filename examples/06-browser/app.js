/**
 * Using jsdj in a browser.
 *
 * Three platform realities shape this example, and the code is written around them
 * rather than pretending they do not exist:
 *
 *  1. **No filesystem.** Browser caching needs a store you write — OPFS,
 *     IndexedDB, Cache API. One is implemented below on OPFS, with an in-memory
 *     fallback for browsers that lack it.
 *  2. **No TLS fingerprinting, ever.** The page cannot control its own handshake.
 *     The option is accepted and inert, so the same options object works.
 *  3. **CORS.** A cross-origin fetch succeeds only if the target allows it. Scanning
 *     an arbitrary site from a page will usually fail, so a real deployment routes
 *     requests through its own origin. Both paths are shown.
 */

import {
  scan,
  MemoryStorage,
  formatMarkdown,
  detectRuntime,
  isAbsoluteUrl,
} from 'jsdj/browser';

// ===== A storage backend =====

/**
 * An OPFS-backed store.
 *
 * `Storage` is five methods and they are all async, because a real browser store
 * cannot be synchronous. Keys map to a directory tree: `<scope>/<subdir>/<path>`.
 *
 * OPFS is available in all current browsers and is the right choice over
 * IndexedDB for file-shaped data: it is a real filesystem inside the origin's
 * sandbox, so the layout mirrors the Node cache and the code that walks a
 * `sources/` tree is identical.
 */
class OpfsStorage {
  /**
   * @param {FileSystemDirectoryHandle} root
   */
  constructor(root) {
    this.root = root;
    this.readable = true;
    this.writable = true;
  }

  /** Resolve a key into a directory handle plus the leaf name. */
  async #resolve(key) {
    const segments = [key.scope, key.subdir, ...key.path.split('/')].filter(
      (s) => s !== '' && s !== '.',
    );
    const leaf = segments.pop();
    if (leaf === undefined) {
      return null;
    }

    let dir = this.root;
    for (const segment of segments) {
      // `..` is refused rather than followed: source paths come from a remote
      // source map, so they are untrusted input.
      if (segment === '..') {
        return null;
      }
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }
    return { dir, leaf };
  }

  async read(key) {
    const target = await this.#resolve(key);
    if (target === null) {
      return null;
    }
    try {
      const handle = await target.dir.getFileHandle(target.leaf);
      const file = await handle.getFile();
      const buffer = await file.arrayBuffer();
      // A zero-byte entry counts as a miss, matching the Node store: an empty
      // download is never useful, so re-fetching beats trusting it.
      return buffer.byteLength === 0 ? null : new Uint8Array(buffer);
    } catch {
      return null;
    }
  }

  async write(key, content) {
    const target = await this.#resolve(key);
    if (target === null) {
      return;
    }
    const handle = await target.dir.getFileHandle(target.leaf, { create: true });
    const stream = await handle.createWritable();
    await stream.write(content);
    await stream.close();
  }

  async exists(key) {
    const target = await this.#resolve(key);
    if (target === null) {
      return false;
    }
    try {
      const handle = await target.dir.getFileHandle(target.leaf);
      const file = await handle.getFile();
      return file.size > 0;
    } catch {
      return false;
    }
  }

  async readMetadata(scope) {
    return this.read({ scope, subdir: '', path: 'meta.json' });
  }

  async writeMetadata(scope, content) {
    return this.write({ scope, subdir: '', path: 'meta.json' }, content);
  }

  async listSources(scope) {
    const out = [];
    let sourcesDir;
    try {
      sourcesDir = await this.root
        .getDirectoryHandle(scope)
        .then((d) => d.getDirectoryHandle('sources'));
    } catch {
      return out;
    }

    const walk = async (dir, prefix) => {
      for await (const [name, handle] of dir.entries()) {
        const path = prefix === '' ? name : `${prefix}/${name}`;
        if (handle.kind === 'directory') {
          await walk(handle, path);
        } else {
          out.push(path);
        }
      }
    };

    await walk(sourcesDir, '');
    return out.sort();
  }
}

/** Build the best store the browser offers. */
async function createBrowserStorage() {
  try {
    if (navigator.storage?.getDirectory) {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('jsdj', { create: true });
      return { storage: new OpfsStorage(dir), kind: 'OPFS (persistent)' };
    }
  } catch (err) {
    // Private browsing and some embedded webviews refuse OPFS. Falling back is
    // better than failing: the scan works, it just does not persist.
    console.warn('OPFS unavailable, falling back to memory:', err.message);
  }
  return { storage: new MemoryStorage(), kind: 'memory (not persistent)' };
}

// ===== An injected transport =====

/**
 * Route requests through our own origin.
 *
 * A browser cannot fetch an arbitrary third-party site: the target would have to
 * send permissive CORS headers, which real sites do not. The usual answer is a
 * backend that fetches server-side and re-serves with CORS, and that is what
 * `/proxy?url=` in `serve.mjs` does.
 *
 * This is exactly what the injectable transport exists for — the scan supplies the
 * request shape, the transport decides how bytes are obtained.
 */
function proxyTransport(proxyBase) {
  const calls = [];

  return {
    calls,
    async fetch(req) {
      // A missing or relative URL should not reach the proxy; the scan only passes
      // absolute URLs, but a transport is a public boundary.
      if (!isAbsoluteUrl(req.url)) {
        return { status: 400, headers: {}, body: '' };
      }

      calls.push({ method: req.method, url: req.url });

      const target = `${proxyBase}/proxy?url=${encodeURIComponent(req.url)}`;
      const response = await fetch(target, { method: req.method ?? 'GET' });

      // `content-type` is passed through because it is what classifies each
      // resource, and every plugin's applicability depends on it.
      const contentType = response.headers.get('content-type') ?? '';

      return {
        status: response.status,
        headers: contentType === '' ? {} : { 'content-type': contentType },
        body: new Uint8Array(await response.arrayBuffer()),
      };
    },
  };
}

/** A transport that answers from a fixed map, for demonstrating the CORS failure. */
function offlineTransport() {
  const site = {
    '/': '<html><script src="/a.js"></script></html>',
    '/a.js': 'import("./b.js");',
    '/b.js': 'export const b = 1;',
  };
  return {
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = site[path];
      return {
        status: body === undefined ? 404 : 200,
        headers: {
          'content-type': path === '/' ? 'text/html' : 'application/javascript',
        },
        body: body ?? '<html>404</html>',
      };
    },
  };
}

// ===== The page =====

const $ = (id) => document.getElementById(id);

function log(message, kind = 'info') {
  const line = document.createElement('div');
  line.className = `line ${kind}`;
  line.textContent = message;
  $('log').appendChild(line);
}

function clear() {
  $('log').replaceChildren();
}

async function runOfflineScan() {
  clear();
  const { storage, kind } = await createBrowserStorage();
  log(`storage: ${kind}`);
  log(`runtime detected as: ${detectRuntime()}`);
  log('');

  const started = performance.now();
  const result = await scan({
    url: 'http://example.test/',
    app: 'example',
    storage,
    // Answering from a fixed map, which is how this works without a server.
    transport: offlineTransport(),
    // Accepted and inert here. A browser cannot fingerprint TLS, and the option
    // never throws for that.
    tlsFingerprint: 'chrome',
  });
  const elapsed = performance.now() - started;

  log(`scan completed in ${elapsed.toFixed(0)}ms`, 'ok');
  log(`  JS files      : ${result.summary.jsCount}`);
  log(`  source maps   : ${result.summary.sourceMapCount}`);
  log(`  cache dirs    : ${result.cacheDirs === undefined ? 'none (no filesystem)' : 'present'}`);
  log('');

  for (const detail of result.jsDetails) {
    log(`  ${detail.fromPlugin ?? '?'}  ->  ${detail.url}`);
  }
  log('');
  log('The injected transport answered every request, so no CORS was involved.');

  // The restored content is available without a filesystem, which is the reason the
  // result carries content rather than only paths.
  if (result.sources.length > 0) {
    log('');
    log(`restored ${result.sources.length} source(s), with content:`);
    for (const file of result.sources) {
      log(`  ${file.path}  [${file.mode}, ${file.content.length} bytes]`);
    }
  }

  $('report').textContent = formatMarkdown(result);
}

async function runProxiedScan() {
  clear();
  const url = $('target').value.trim();
  if (!isAbsoluteUrl(url)) {
    log('Enter an absolute http:// or https:// URL.', 'err');
    return;
  }

  const { storage, kind } = await createBrowserStorage();
  log(`storage: ${kind}`);
  log(`target : ${url}`);
  log('');

  const transport = proxyTransport(window.location.origin);
  const started = performance.now();

  try {
    const result = await scan({
      url,
      storage,
      transport,
      // The service caps what it returns; keep the page's copy small too.
      maxInlineSources: 50,
    });
    const elapsed = performance.now() - started;

    log(`scan completed in ${(elapsed / 1000).toFixed(1)}s`, 'ok');
    log(`  requests through the proxy: ${transport.calls.length}`);
    log(`  JS files : ${result.summary.jsCount}`);
    log(`  sources  : ${result.summary.sourceCount}`);
    log('');

    for (const jsUrl of result.jsUrls.slice(0, 25)) {
      log(`  ${jsUrl}`);
    }
    if (result.jsUrls.length > 25) {
      log(`  … and ${result.jsUrls.length - 25} more`);
    }

    $('report').textContent = formatMarkdown(result);
  } catch (err) {
    log(`scan failed: ${err.message}`, 'err');
    log('');
    log('A cross-origin scan without a proxy fails on CORS. That is expected:');
    log('the browser will not let this page read a response from a site that');
    log('does not opt in. Use the proxied path.');
  }
}

/** Show the CORS failure on purpose, so it is not a surprise later. */
async function runDirectScan() {
  clear();
  const url = $('target').value.trim();
  log(`Attempting a direct cross-origin scan of ${url}`, 'warn');
  log('No transport injected, so the browser makes the request itself.');

  try {
    const result = await scan({ url, storage: new MemoryStorage() });
    log(`scan succeeded — ${result.summary.jsCount} JS files`, 'ok');
    log('This target sends permissive CORS headers, which is uncommon for a');
    log('third-party site. Do not rely on it.');
  } catch (err) {
    log(`${err.name}: ${err.message}`, 'err');
    log('');
    log('This is the expected outcome, and note the error type: the entry page');
    log('could not be fetched, so the scan failed rather than resolving with an');
    log('empty result. Without that distinction a CORS block, a DNS failure and a');
    log('site with no JavaScript would all look identical — zero URLs found.');
    log('');
    log('Check the browser console: it will show the CORS rejection from every');
    log('request the scan attempted.');
    log('');
    log('Use "Scan via proxy" to reach the target through this page\'s own origin.');
  }
}

$('run-offline').addEventListener('click', runOfflineScan);
$('run-proxied').addEventListener('click', runProxiedScan);
$('run-direct').addEventListener('click', runDirectScan);

log('Ready. "Offline demo" needs no server and shows the whole pipeline.');
log('"Scan via proxy" reaches a real site through this page\'s own origin.');
log('"Scan directly" demonstrates the CORS failure you would hit otherwise.');