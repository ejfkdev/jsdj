#!/usr/bin/env node
/**
 * Serves the example page, and provides the CORS proxy it needs.
 *
 * The proxy is the point: a browser cannot read a cross-origin response the target
 * did not opt into, so a page that wants to scan an arbitrary site must route the
 * request through an origin it controls. `/proxy?url=` is a minimal version of that,
 * and it is what the page's injected transport talks to.
 *
 * It forwards `GET` and `HEAD` only. A scanning proxy should not be a general-purpose
 * request forwarder — that is an open proxy, and this is an example, not a service.
 *
 * Run:  node serve.mjs [port]
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.argv[2] ?? 3001);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Forward a request and stream the response back.
 *
 * Only the status, `content-type` and body are relayed. Relaying every response
 * header would copy `set-cookie` and others into this origin, which is both a
 * security problem and unnecessary — jsdj's content classification needs only the
 * content type.
 */
async function proxy(req, res) {
  const requestUrl = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const target = requestUrl.searchParams.get('url');

  if (target === null || target === '') {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing url parameter' }));
    return;
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'url is not absolute' }));
    return;
  }

  // http/https only. Without this check a caller could aim the proxy at `file:` or
  // another scheme.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `unsupported scheme: ${parsed.protocol}` }));
    return;
  }

  // Only the methods a scan uses.
  const method = req.method === 'HEAD' ? 'HEAD' : 'GET';

  try {
    const upstream = await fetch(parsed, {
      method,
      redirect: 'follow',
      // The default fetch User-Agent identifies as undici, which some sites block.
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
        accept: '*/*',
      },
    });

    const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
    const body = method === 'HEAD' ? null : Buffer.from(await upstream.arrayBuffer());

    res.writeHead(upstream.status, {
      'content-type': contentType,
      // The headers that let this page read the response at all. Without them the
      // browser blocks it and the transport sees a network error.
      'access-control-allow-origin': '*',
      ...(body === null ? {} : { 'content-length': body.byteLength }),
    });
    res.end(body ?? undefined);
  } catch (err) {
    // Report the failure as a status rather than dropping the connection, so the
    // scan sees a response and can continue with the other URLs.
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `upstream fetch failed: ${err.message}` }));
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);

  if (url.pathname === '/proxy') {
    return proxy(req, res);
  }

  // The page's own files.
  let path = url.pathname === '/' ? '/index.html' : url.pathname;

  // Serve the bundled app under a predictable name. `dist/app.js` is what
  // `bun build` writes, and index.html references exactly that.
  if (path === '/dist/app.js') {
    try {
      const body = await readFile(join(HERE, 'dist', 'app.js'));
      res.writeHead(200, {
        'content-type': CONTENT_TYPES['.js'],
        'content-length': body.byteLength,
      });
      return res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('dist/app.js not found — run `npm run build` first');
    }
  }

  // Refuse traversal: the page only needs files from this directory.
  if (path.includes('..')) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    return res.end('bad path');
  }

  try {
    const body = await readFile(join(HERE, path.replace(/^\/+/, '')));
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(path)] ?? 'application/octet-stream',
      'content-length': body.byteLength,
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
});

server.listen(PORT, () => {
  console.log(`browser example on http://127.0.0.1:${PORT}/`);
  console.log();
  console.log('  the page needs dist/app.js — run `npm run build` if it 404s');
  console.log('  the /proxy endpoint is what makes cross-origin scanning possible');
});