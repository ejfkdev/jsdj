/**
 * Injecting a plain fetch function.
 *
 * This is the minimum a custom transport needs to be: one async function taking
 * `{ url, method, headers }` and returning `{ status, headers, body }`. The scan
 * supplies the request headers and cookies; your function is responsible for the
 * bytes.
 *
 * Use it when you want to own the network layer — a TLS-fingerprinting stack, a
 * proxy client, a corporate egress gateway, a service mesh sidecar — without
 * implementing jsdj's `HttpClient` interface.
 */

import { scan, MemoryStorage } from 'jsdj';

const target = process.argv[2] ?? 'http://127.0.0.1:18080/';

// ===== A transport that logs and forwards =====

const seen = [];
let firstRequestHeaders;

const result = await scan({
  url: target,
  storage: new MemoryStorage(),
  headers: { 'X-Scanner': 'example' },
  cookie: 'session=demo',
  transport: {
    async fetch(req) {
      // Both GET and HEAD arrive here, so `method` must be honoured. jsdj probes
      // for source maps with HEAD, and a transport that always sent GET would still
      // work but would download every map's body twice.
      firstRequestHeaders ??= req.headers ?? {};
      seen.push({ method: req.method, url: req.url });

      // `headers` is what jsdj wants sent: browser defaults plus anything you passed
      // as `headers`, with your own values winning. Forward them as-is.
      const response = await fetch(req.url, {
        method: req.method ?? 'GET',
        headers: req.headers,
        redirect: 'follow',
      });

      // The body must be bytes. `Uint8Array` is what the built-in clients produce;
      // a string is accepted too and encoded as UTF-8, which is convenient when a
      // transport returns text from somewhere that does not speak bytes.
      const body = new Uint8Array(await response.arrayBuffer());

      return {
        status: response.status,
        // A plain object of response headers. Keys are lower-cased by jsdj, so
        // casing here does not matter. `content-type` is the one that matters most:
        // it drives content classification for every fetched resource.
        headers: Object.fromEntries(response.headers),
        body,
        // Optional. When present, jsdj treats it as the post-redirect URL, which is
        // how a resource gets reported under the address it was served from.
        finalUrl: response.url,
      };
    },
  },
});

console.log(`discovered ${result.summary.jsCount} JS files\n`);

console.log('Requests made through the injected transport');
const get = seen.filter((r) => r.method === 'GET');
const head = seen.filter((r) => r.method === 'HEAD');
console.log(`  ${seen.length} total — ${get.length} GET, ${head.length} HEAD`);
console.log();
console.log('First 12:');
for (const req of seen.slice(0, 12)) {
  console.log(`  ${(req.method ?? 'GET').padEnd(5)} ${req.url}`);
}
console.log();

// The headers jsdj supplies are worth seeing: they are a full Chrome navigation
// header set, because several anti-bot systems reject a request whose headers are
// internally inconsistent. Collected from the scan above, which used a real
// transport.
console.log('Headers jsdj sent on the first request');
console.log('─'.repeat(66));
for (const [key, value] of Object.entries(firstRequestHeaders ?? {})) {
  const shown = value.length > 62 ? `${value.slice(0, 62)}…` : value;
  console.log(`  ${key.padEnd(26)} ${shown}`);
}
console.log();

// ===== When the target is unreachable =====

// Worth knowing, because the failure is easy to misread: a scan whose entry page
// cannot be fetched **rejects**. It does not resolve with zero URLs.
//
// The distinction matters. A CORS block, a DNS failure, an unreachable host and a
// site with no JavaScript all produce zero discovered URLs, so a resolved empty
// result would be indistinguishable between them. The scan raises instead, with the
// cause attached.
console.log('An unreachable target rejects, it does not return empty');
console.log('─'.repeat(66));

try {
  await scan({
    url: target,
    storage: new MemoryStorage(),
    transport: {
      async fetch() {
        // A transport failure: reject, do not resolve with a fake response.
        throw new Error('ECONNREFUSED');
      },
    },
  });
  console.log('  (unexpectedly resolved)');
} catch (err) {
  console.log(`  ${err.name}: ${err.message}`);
}
console.log();

try {
  await scan({
    url: target,
    storage: new MemoryStorage(),
    transport: {
      async fetch() {
        // Resolving with a non-2xx is also fatal for the *entry page*, for the same
        // reason: there is nothing to discover from a page we did not receive.
        return { status: 403, body: '<html>blocked</html>' };
      },
    },
  });
  console.log('  (unexpectedly resolved)');
} catch (err) {
  console.log(`  ${err.name}: ${err.message}`);
}
console.log();
console.log('  Both are `EntryFetchError`. A failure on a *discovered* URL is not');
console.log('  fatal — one dead chunk must not end the scan — only the entry page is.');
console.log();
console.log('  And a transport failure must reject rather than resolve with a fake 404:');
console.log('  jsdj retries rejections with backoff, but treats a resolved response as');
console.log('  final, so swallowing an error turns a transient failure permanent.');