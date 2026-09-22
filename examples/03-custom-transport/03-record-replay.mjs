/**
 * Record and replay a scan.
 *
 * Once a scan is recorded, it can be replayed with no network at all. That is how
 * you test scanner behaviour deterministically, reproduce a discovery bug on a site
 * that has since changed, or run a scan in CI without reaching the internet.
 *
 * The recording is a plain JSON of the responses that mattered. It doubles as a
 * readable artifact of what a site served.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { scan, MemoryStorage } from '@ejfkdev/jsdj';

const target = process.argv[2] ?? 'http://127.0.0.1:18080/';
const RECORDING = new URL('./recording.json', import.meta.url).pathname;

// ===== Record =====

/** Responses keyed by `METHOD url`, so HEAD is recorded separately from GET. */
const recorded = new Map();
let networkCalls = 0;

const result = await scan({
  url: target,
  storage: new MemoryStorage(),
  transport: {
    async fetch(req) {
      networkCalls++;

      const response = await fetch(req.url, { method: req.method ?? 'GET' });
      const body = new Uint8Array(await response.arrayBuffer());

      recorded.set(`${req.method ?? 'GET'} ${req.url}`, {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        // Base64 keeps the recording valid JSON. Bodies here are text, but a
        // transport cannot assume that, and a binary-safe format avoids a later
        // surprise.
        bodyBase64: Buffer.from(body).toString('base64'),
      });

      return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body,
        finalUrl: response.url,
      };
    },
  },
});

await writeFile(
  RECORDING,
  JSON.stringify({ url: target, responses: [...recorded] }, null, 2),
);

console.log(`Recorded ${recorded.size} responses (${networkCalls} requests, counting retries)`);
console.log(`  written to ${RECORDING}`);
console.log(`  discovered ${result.summary.jsCount} JS files, ${result.summary.sourceCount} sources`);
console.log();

// ===== Replay =====

const raw = JSON.parse(await readFile(RECORDING, 'utf8'));
const table = new Map(raw.responses);
let served = 0;
let missed = 0;

const replayResult = await scan({
  url: raw.url,
  storage: new MemoryStorage(),
  transport: {
    async fetch(req) {
      const key = `${req.method ?? 'GET'} ${req.url}`;
      const hit = table.get(key);

      if (hit === undefined) {
        // A miss is the interesting case. Returning 404 keeps the scan running so you
        // can see which requests the recording did not cover, rather than failing
        // with an exception that hides the rest.
        missed++;
        return { status: 404, headers: { 'content-type': 'text/html' }, body: '<html>not recorded</html>' };
      }

      served++;
      return {
        status: hit.status,
        headers: hit.headers,
        body: new Uint8Array(Buffer.from(hit.bodyBase64, 'base64')),
      };
    },
  },
});

console.log(`Replayed: ${served} served from the recording, ${missed} missed`);
console.log(`  discovered ${replayResult.summary.jsCount} JS files, ${replayResult.summary.sourceCount} sources`);
console.log();

// The replay must reproduce the original exactly, or the recording is not a
// trustworthy fixture.
const original = [...result.jsUrls].sort();
const replayed = [...replayResult.jsUrls].sort();
const identical = JSON.stringify(original) === JSON.stringify(replayed);

console.log(`Same URL set as the live scan: ${identical ? 'yes' : 'NO'}`);
if (!identical) {
  console.log('  only in live   :', original.filter((u) => !replayed.includes(u)));
  console.log('  only in replay :', replayed.filter((u) => !original.includes(u)));
}

// A recording is a snapshot of the site, so it can be committed and used as a
// regression fixture: if a change to a plugin alters which URLs are found, the
// replayed result changes and the comparison above fails.
console.log();
console.log('Commit recording.json to turn this into a regression fixture.');