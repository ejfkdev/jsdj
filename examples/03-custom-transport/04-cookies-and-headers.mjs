/**
 * Headers, cookies, and proxy — the request-shaping options.
 *
 * These are the parts of a request a site's anti-bot layer actually inspects. The
 * point of this example is to show what jsdj sends and how to change it, since
 * getting it wrong is the usual reason a scan comes back empty.
 */

import { scan, MemoryStorage, CookieJar, parseCookieString, DEFAULT_USER_AGENT } from 'jsdj';

const target = process.argv[2] ?? 'http://127.0.0.1:18080/';

// ===== See exactly what goes out =====

// A transport that records requests and answers with a minimal page. It cannot
// answer 404 to everything: the *entry page* failing is fatal, because there is
// nothing to discover from a page that was never received.
const observed = [];
const probeTransport = {
  async fetch(req) {
    observed.push({ url: req.url, method: req.method, headers: req.headers ?? {} });
    const isEntry = new URL(req.url).pathname === '/';
    return {
      status: 200,
      headers: { 'content-type': isEntry ? 'text/html' : 'application/javascript' },
      body: isEntry ? '<html></html>' : '',
    };
  },
};

await scan({
  url: target,
  storage: new MemoryStorage(),
  cookie: 'cf_clearance=demo-token; session=abc123',
  headers: { Referer: `${target}`, 'X-Custom': 'value' },
  transport: probeTransport,
});

const first = observed[0];
console.log('The default header ensemble');
console.log('─'.repeat(66));
for (const [name, value] of Object.entries(first.headers)) {
  // Truncate long values, since the Accept header alone is most of a screen.
  const shown = value.length > 68 ? `${value.slice(0, 68)}…` : value;
  console.log(`  ${name.padEnd(26)} ${shown}`);
}
console.log();

console.log('Why these particular headers');
console.log('─'.repeat(66));
console.log('  The set is a Chrome navigation, not a minimal request. Several');
console.log('  anti-bot systems reject a request whose headers are internally');
console.log('  inconsistent — a Chrome User-Agent with no Sec-Fetch-* group,');
console.log('  or Sec-Ch-Ua-Platform claiming Windows while the UA says macOS.');
console.log('  Sending the whole group is what makes the request look ordinary.');
console.log();

// ===== Overriding =====

// Anything passed as `headers` wins over the default. Common overrides:
//   - Referer: sites that hotlink-protect serve chunks only with a same-site referer
//   - User-Agent: when a site blocks the stock Chrome string
//   - Accept: to request a specific representation
const overriden = [];
observed.length = 0;
await scan({
  url: target,
  storage: new MemoryStorage(),
  // An empty string disables the UA entirely; a custom one impersonates something else.
  userAgent: 'Mozilla/5.0 (compatible; my-crawler/1.0)',
  headers: {
    Referer: `${target}app/`,
    Accept: 'application/javascript',
    'Sec-Fetch-Mode': 'cors',
  },
  transport: {
    async fetch(req) {
      overriden.push(req.headers ?? {});
      const isEntry = new URL(req.url).pathname === '/';
      return {
        status: 200,
        headers: { 'content-type': isEntry ? 'text/html' : 'application/javascript' },
        body: isEntry ? '<html></html>' : '',
      };
    },
  },
});

console.log('After overriding userAgent and three headers');
console.log('─'.repeat(66));
for (const key of ['User-Agent', 'Referer', 'Accept', 'Sec-Fetch-Mode', 'Sec-Fetch-Dest']) {
  const value = overriden[0][key];
  console.log(`  ${key.padEnd(18)} ${value === undefined ? '(removed)' : JSON.stringify(value)}`);
}
console.log();
console.log('  The four overridden keys changed; every other default survived.');
console.log();

// ===== Cookies =====

// The `cookie` option is a `name=value; name2=value2` string, injected for the scan
// target's origin. Its main use is a Cloudflare clearance cookie, which is what
// makes a Cloudflare-protected site return real content instead of a challenge page.
console.log('Cookie handling');
console.log('─'.repeat(66));

const jar = new CookieJar();
jar.setFromUrl('https://a.test/app/page', [
  { name: 'host_only', value: '1' },
  { name: 'scoped', value: '2', path: '/app' },
  { name: 'expired', value: '3', expires: Date.now() - 1000 },
]);

console.log('  A jar built by hand:');
console.log(`    /app/page  -> ${JSON.stringify(jar.getCookieHeader('https://a.test/app/page'))}`);
console.log(`    /other     -> ${JSON.stringify(jar.getCookieHeader('https://a.test/other'))}`);
console.log(`    (expired cookies are dropped on read)`);
console.log();

// Ingesting what a server sent back, which is how a session survives a redirect.
jar.setFromResponseHeaders('https://a.test/app/', [
  'sid=xyz; Path=/app; Max-Age=3600; HttpOnly; Secure',
]);
console.log('  After ingesting a Set-Cookie:');
console.log(`    /app/x     -> ${JSON.stringify(jar.getCookieHeader('https://a.test/app/x'))}`);
console.log();

// Parsing a browser-copied cookie string, which is what you paste from DevTools.
console.log('  Parsing a string copied from a browser:');
console.log(`    ${JSON.stringify(parseCookieString('cf_clearance=abc; _ga=GA1.1; empty='))}`);
console.log();

// ===== Proxy =====

// The `proxy` option takes an http, https or socks5 URL. When set, it overrides the
// environment; when unset, HTTPS_PROXY / HTTP_PROXY / ALL_PROXY apply with NO_PROXY
// honoured.
console.log('Proxy resolution');
console.log('─'.repeat(66));
console.log('  Precedence: explicit option > HTTPS_PROXY > HTTP_PROXY > ALL_PROXY');
console.log('  NO_PROXY can veto an environment proxy, but never the explicit one —');
console.log('  a flag is an instruction, not a default.');
console.log();

// The resolution helpers are exported, so you can see what a scan would choose.
const { resolveProxy, parseProxyUrl, shouldBypassProxy } = await import('jsdj');

const fakeEnv = (vars) => (name) => vars[name];
console.log('  resolveProxy with a fake environment:');
console.log(`    explicit + HTTPS_PROXY set -> ${resolveProxy('http://explicit:8080', 'https://a.test', fakeEnv({ HTTPS_PROXY: 'http://env:3128' }))}`);
console.log(`    env only                   -> ${resolveProxy(undefined, 'https://a.test', fakeEnv({ HTTPS_PROXY: 'http://env:3128' }))}`);
console.log(`    env + NO_PROXY match       -> ${resolveProxy(undefined, 'https://a.test', fakeEnv({ HTTPS_PROXY: 'http://env:3128', NO_PROXY: 'a.test' }))}`);
console.log();
console.log(`  parseProxyUrl('127.0.0.1:8080') -> ${parseProxyUrl('127.0.0.1:8080')}  (scheme defaulted)`);
console.log(`  shouldBypassProxy('sub.a.test', '.a.test') -> ${shouldBypassProxy('sub.a.test', '.a.test')}`);
console.log();

console.log(`Stock User-Agent in use: ${DEFAULT_USER_AGENT.slice(0, 50)}…`);