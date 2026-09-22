#!/usr/bin/env node
/**
 * A dependency-free static server for the fixture site.
 *
 * Every example needs a real HTTP origin to scan — `file://` URLs and injected
 * transports are covered elsewhere, but the point of these examples is to exercise
 * the ordinary network path. Rather than have each example declare a server
 * dependency, this one script serves all of them.
 *
 * Usage:
 *   node serve.mjs [port]        # defaults to 18080
 *
 * Routes are resolved as `<dir>/<path>`, then `<dir>/<path>.html`, then
 * `<dir>/<path>/index.html`, which mirrors how a static host with extension
 * fallback behaves. A missing path returns a real 404 with an HTML body, which is
 * what a static host does and what jsdj's content-type handling expects.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)));
const ROOT = HERE;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

/** Resolve a request path to a file on disk, trying the extension fallbacks. */
async function resolveFile(urlPath) {
  // Strip the query and fragment, then decode, then refuse anything that escapes
  // the root. The last step matters: a scan of a real site can discover `..`
  // segments, and a server that followed them would be a path-traversal hole even
  // in a fixture.
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const target = normalize(clean).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  const base = join(ROOT, target);

  if (!base.startsWith(ROOT)) {
    return null;
  }

  const candidates = target === '' || target.endsWith('/')
    ? [join(base, 'index.html')]
    : [base, `${base}.html`, join(base, 'index.html')];

  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

const port = Number(process.argv[2] ?? 18080);

const server = createServer(async (req, res) => {
  const file = await resolveFile(req.url ?? '/');

  if (file === null) {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><body>404 not found</body></html>');
    return;
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
      'content-length': body.byteLength,
    });
    // A HEAD request must not carry a body.
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('read error');
  }
});

server.listen(port, () => {
  console.log(`fixture site on http://127.0.0.1:${port}/`);
  console.log('press Ctrl+C to stop');
});