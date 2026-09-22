# Example: injecting your own HTTP transport

jsdj never talks to the network except through an `HttpClient` you can replace. This
is the escape hatch for a TLS-fingerprinting stack, a proxy client, a corporate
egress gateway, a service-mesh sidecar — or a recorder in a test.

Two ways to inject, and five scripts showing them.

## Setup

```bash
npm install
node ../fixture-site/serve.mjs      # in another terminal
```

## Run

```bash
node 01-fetch-function.mjs      # inject a plain fetch function
node 02-http-client.mjs         # implement the full HttpClient interface
node 03-record-replay.mjs       # record a scan, then replay it with no network
node 04-cookies-and-headers.mjs # see and change what jsdj sends
node 05-tls-fingerprint.mjs     # TLS fingerprinting and its fallback
```

## The two injection forms

### A fetch function

The minimum: one async function taking `{ url, method, headers }` and returning
`{ status, headers, body }`.

```js
await scan({
  url: 'https://example.com',
  transport: {
    async fetch(req) {
      const res = await myTlsStack(req.url, {
        method: req.method,     // 'GET' or 'HEAD'
        headers: req.headers,   // browser set + your cookies, already composed
      });
      return {
        status: res.status,
        headers: res.headers,
        body: res.body,         // Uint8Array, or a string
        finalUrl: res.finalUrl, // optional
      };
    },
  },
});
```

`method` is `GET` **or** `HEAD` — jsdj probes for source maps with `HEAD`, so a
function that ignores the method still works but downloads every map's body twice.

`req.headers` arrives already composed: the browser default set, then any `headers`
you passed, then any cookies you configured. A transport does not need to
reconstruct request shape — only produce bytes.

### A full `HttpClient`

Implement three methods when you want control over connection lifetime, or need
`HEAD` handled differently:

```js
const client = {
  async request(req) { /* GET */ },
  async head(req) { /* HEAD */ },
  async close() { /* release sockets; called at the end of a scan */ },
};

await scan({ url: '...', transport: { client } });
```

`close()` is only called for a client jsdj created — never for one you injected, so
you keep ownership of its lifetime.

## Failure semantics, which matter more than they look

- **A transport failure must reject**, not resolve. jsdj retries rejections with
  backoff; it treats a resolved response as final. Swallowing an error and returning
  a fake `404` turns a transient failure into a permanent "not found".
- **A non-2xx status resolves normally.** `{ status: 404 }` is a result, not an
  error. This is how the pipeline distinguishes "the server said no" from "the
  network broke".
- **Pass the real response headers through.** `content-type` is what classifies each
  fetched resource, and every plugin's applicability depends on that classification.
  Synthesising headers changes which plugins run.

## What each script shows

**`01-fetch-function.mjs`** — a logging transport, plus a dump of exactly what jsdj
sends. Worth reading once: the header set is a full Chrome navigation, not a minimal
request, and that is what stops a request looking scripted.

**`02-http-client.mjs`** — a client built on `node:http`/`node:https` directly, with
per-scheme keep-alive agents. Shows why someone would go below `fetch`: socket reuse
across the thousand-plus requests a scan issues.

**`03-record-replay.mjs`** — records every response to `recording.json`, then
replays with the network off and asserts the URL set is identical. Commit the
recording and it becomes a regression fixture: if a plugin change alters discovery,
the comparison fails. This is also how to test jsdj in CI without internet access.

**`04-cookies-and-headers.mjs`** — the request-shaping options: the default ensemble,
overriding individual headers and the User-Agent, `CookieJar` semantics (path
scoping, expiry, `Set-Cookie` ingestion), and proxy resolution precedence.

**`05-tls-fingerprint.mjs`** — how to request a fingerprint, how to detect whether
you got one, and what the fallback does. Short version: `tlsFingerprint` is always
accepted; when no TLS-capable transport is installed it is silently inert, so the
same code runs everywhere.

## Notes

**Why the header set is browser-shaped.** Several anti-bot systems reject a request
whose headers are internally inconsistent — a Chrome User-Agent with no `Sec-Fetch-*`
group, or `Sec-Ch-Ua-Platform` claiming Windows while the UA says macOS. Sending the
whole group is what makes the request ordinary. Pass `browserHeaders: false` to get a
minimal set instead.

**Your headers win.** Anything in `headers` overrides the default of the same name,
including `User-Agent` and `Accept`. That is the supported way to impersonate
something else.

**Cookies reach an injected transport.** A cookie string you pass as `cookie` arrives
as a `Cookie` header on requests to that origin, scoped the way a browser scopes it.
An explicit `Cookie` header in `headers` overrides the jar.