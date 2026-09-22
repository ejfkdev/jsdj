/**
 * TLS fingerprinting, and what happens without it.
 *
 * jsdj cannot forge a TLS ClientHello from JavaScript — the handshake happens inside
 * the runtime. It therefore ships that capability as an optional native dependency,
 * `@jsdj/tls-sidecar`, and degrades quietly when it is absent.
 *
 * This example shows three things: how to ask for a fingerprint, how to detect
 * whether you actually got one, and what the fallback does. The last part matters
 * most, because a request that looks scripted is the usual reason a scan of a
 * protected site returns nothing.
 */

import { scan, MemoryStorage, Fetcher, loadTlsSidecar, SIDECAR_PACKAGE, TLS_FINGERPRINT_PROFILES } from 'jsdj';

const target = process.argv[2] ?? 'http://127.0.0.1:18080/';

// ===== Is a fingerprint actually available? =====

console.log('TLS fingerprint availability');
console.log('─'.repeat(66));

// `loadTlsSidecar` resolves to null when the package is absent, and never throws.
// That is the documented contract: a missing optional dependency is not an error.
const sidecar = await loadTlsSidecar();
console.log(`  optional package : ${SIDECAR_PACKAGE}`);
console.log(`  installed        : ${sidecar === null ? 'no' : 'yes'}`);
console.log();

if (sidecar === null) {
  console.log('  Without it, a scan still runs. The `tlsFingerprint` option is');
  console.log('  accepted and ignored — no error, no warning, no thrown exception.');
  console.log('  That is deliberate: the feature is optional, not required.');
} else {
  console.log(`  profiles: ${sidecar.supportedProfiles.join(', ')}`);
}
console.log();

// `Fetcher.hasTlsFingerprint()` is the capability probe, for diagnostics.
const fetcher = new Fetcher({ tlsFingerprint: 'chrome' });
console.log(`  Fetcher.hasTlsFingerprint() -> ${await fetcher.hasTlsFingerprint()}`);
console.log();

// ===== Requesting a fingerprint anyway =====

console.log('Requesting fingerprints');
console.log('─'.repeat(66));

// Every value is accepted regardless of availability. `off` is the explicit
// "do not attempt it" setting.
for (const mode of ['random', 'chrome', 'off']) {
  let outcome;
  try {
    const result = await scan({
      url: target,
      storage: new MemoryStorage(),
      tlsFingerprint: mode,
      // A transport answering with an empty page, so this loop stays fast. The point
      // is that none of these calls *throws* over the TLS option — the option itself
      // is never a failure, whatever the platform can do with it.
      transport: {
        async fetch() {
          return { status: 200, headers: { 'content-type': 'text/html' }, body: '<html></html>' };
        },
      },
    });
    outcome = `scanned, ${result.summary.jsCount} files`;
  } catch (err) {
    outcome = `threw: ${err.name}`;
  }
  console.log(`  tlsFingerprint: ${mode.padEnd(7)} -> ${outcome}`);
}
console.log();

console.log('  All three succeeded. Where TLS fingerprinting is unavailable the');
console.log('  option is a no-op, so code that sets it works on any platform.');
console.log();

// ===== What a fingerprint changes =====

console.log('What the option actually does');
console.log('─'.repeat(66));
console.log('  With a TLS-capable transport, each connection\'s ClientHello — the');
console.log('  JA3/JA4 fingerprint — is made to match a real browser:');
console.log();
console.log(`    'random'  pick a real-browser profile per connection (default)`);
console.log(`    'chrome'  pin the Chrome profile`);
console.log(`    'off'     no fingerprinting; plain runtime TLS`);
console.log();
console.log(`  Known profiles: ${TLS_FINGERPRINT_PROFILES.join(', ')}`);
console.log();
console.log('  This matters because some sites reject the handshake itself, before');
console.log('  any HTTP header is read. No header trickery helps there; only a');
console.log('  matching ClientHello does.');
console.log();

// ===== Supplying your own TLS stack =====

console.log('Using your own TLS stack instead');
console.log('─'.repeat(66));
console.log('  If you already have a fingerprinting client — a Go sidecar, a native');
console.log('  binding, a proxy that terminates TLS for you — inject it and jsdj');
console.log('  will not attempt its own:');
console.log();
console.log('    await scan({');
console.log(`      url: '${target}',`);
console.log('      transport: {');
console.log('        async fetch(req) {');
console.log('          const res = await myTlsStack(req.url, {');
console.log('            method: req.method,');
console.log('            headers: req.headers,   // browser set, already composed');
console.log('          });');
console.log('          return { status: res.status, headers: res.headers, body: res.body };');
console.log('        },');
console.log('      },');
console.log('    });');
console.log();
console.log('  The injected function receives the full browser header set and any');
console.log('  cookies you configured, so a custom transport does not have to');
console.log('  reconstruct request shape — only the bytes.');
console.log();

console.log('Browser note');
console.log('─'.repeat(66));
console.log('  In a browser this capability does not exist and never will: the page');
console.log('  cannot control its own TLS handshake. The option stays accepted and');
console.log('  inert, so the same code runs there. Requests are also subject to');
console.log('  CORS, so scanning an arbitrary third-party site from a page needs a');
console.log('  transport that routes through an origin you control.');