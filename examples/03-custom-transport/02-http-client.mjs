/**
 * Injecting a full `HttpClient`.
 *
 * The fetch-function form covers most needs. Implement the interface when you want
 * control over connection lifetime, or when `HEAD` should be handled differently
 * from `GET` — for example a TLS-fingerprint stack that has to open its own socket
 * per request and benefits from pooling.
 *
 * The interface is three methods: `request`, `head`, and an optional `close`.
 */

import { scan, MemoryStorage, HttpError, getHeader } from '@ejfkdev/jsdj';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { request as httpRequest, Agent as HttpAgent } from 'node:http';

const target = process.argv[2] ?? 'http://127.0.0.1:18080/';

/**
 * A client built on `node:https` directly, rather than `fetch`.
 *
 * The point of going lower-level is the agent: `keepAlive` reuses sockets, which
 * matters when a scan issues over a thousand requests to one host. `undici` does
 * this by default; a hand-rolled client would not, unless the agent is configured
 * as below.
 */
class NodeHttpClient {
  constructor() {
    // One agent per scheme, each shared across requests and holding sockets open
    // between them. Pooling is the reason to write a client at this level: a scan
    // issues over a thousand requests to a single host, and without keep-alive each
    // one pays a fresh TCP and TLS handshake.
    const agentOptions = { keepAlive: true, maxSockets: 16, maxFreeSockets: 8 };
    this.httpsAgent = new HttpsAgent(agentOptions);
    this.httpAgent = new HttpAgent(agentOptions);
    this.requests = 0;
  }

  async request(req) {
    // The interface deliberately does not prescribe how a URL becomes a socket.
    // Here: one `https.request` per call, with the shared agent doing the pooling.
    return this.send(req, req.method ?? 'GET');
  }

  async head(req) {
    return this.send(req, 'HEAD');
  }

  async send(req, method) {
    this.requests++;

    return new Promise((resolve, reject) => {
      const parsed = new URL(req.url);

      // The scheme decides the module and the default port. A client that always
      // used `node:https` would fail outright against an `http://` target.
      const isTls = parsed.protocol === 'https:';
      const send = isTls ? httpsRequest : httpRequest;

      const httpReq = send(
        {
          method,
          hostname: parsed.hostname,
          port: parsed.port || (isTls ? 443 : 80),
          path: parsed.pathname + parsed.search,
          // `req.headers` arrives already composed: the browser defaults are merged
          // with whatever the caller configured, so forwarding it verbatim is
          // correct.
          headers: req.headers,
          agent: isTls ? this.httpsAgent : this.httpAgent,
          timeout: req.timeoutMs ?? 30_000,
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              // A `HEAD` response has no body by definition.
              body:
                method === 'HEAD'
                  ? new Uint8Array(0)
                  : new Uint8Array(Buffer.concat(chunks)),
              finalUrl: req.url,
            });
          });
        },
      );

      httpReq.on('timeout', () => {
        httpReq.destroy(new Error('timeout'));
      });

      // A transport failure must reject, not resolve. jsdj retries rejections but
      // treats a resolved response as final, so swallowing an error here would turn
      // a transient failure into a permanent "not found".
      httpReq.on('error', (err) => {
        reject(new HttpError(`https request failed: ${err.message}`, req.url, err));
      });

      httpReq.end();
    });
  }

  /** Called by jsdj at the end of a scan, but only for clients it created. */
  async close() {
    this.httpsAgent.destroy();
    this.httpAgent.destroy();
  }
}

const client = new NodeHttpClient();

const result = await scan({
  url: target,
  storage: new MemoryStorage(),
  transport: { client },
  concurrency: 16,
});

console.log(`discovered ${result.summary.jsCount} JS files`);
console.log(`transport handled ${client.requests} requests`);
console.log();

// The response headers the client returns are visible to plugins. `content-type` is
// the one that matters: it is what classifies each fetched resource, and it is why
// a transport must pass the real response headers through rather than synthesising
// them.
console.log('A client can read response headers it captured itself:');
console.log(`  content-type passthrough is what makes detection work`);
console.log();

await client.close();
console.log('client closed, sockets released');

// Header lookup is case-insensitive; the helper exists because a hand-rolled
// transport may return headers in any casing and plugins expect lower-cased keys.
const probe = await scan({
  url: target,
  storage: new MemoryStorage(),
  transport: {
    async fetch(req) {
      return {
        status: 200,
        // Deliberately odd casing, as a real server might send it.
        headers: { 'Content-Type': 'application/javascript', 'X-Probe': 'yes' },
        body: 'export const x = 1;',
      };
    },
  },
});
void probe;

// `getHeader` is exported for exactly this normalisation step.
const sampleHeaders = { 'Content-Type': 'text/html; charset=utf-8' };
console.log('getHeader normalises casing:');
console.log(`  getHeader(headers, 'content-type') = ${JSON.stringify(getHeader(sampleHeaders, 'content-type'))}`);