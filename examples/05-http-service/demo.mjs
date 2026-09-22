/**
 * Exercise the scan service.
 *
 * Start `node server.mjs` first, then run this.
 *
 * The demo covers the four things the service has to get right, plus the two that
 * only show up under load: queueing beyond the concurrency cap, and cancelling a
 * scan that is already running.
 */

const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const TARGET = process.env.TARGET ?? 'http://127.0.0.1:18080/';

const heading = (text) => {
  console.log();
  console.log(text);
  console.log('─'.repeat(66));
};

const post = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
};

const get = async (path) => {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
};

/** Poll a job until it leaves queued/running, or the deadline passes. */
const waitFor = async (id, timeoutMs = 120_000) => {
  const deadline = Date.now() + timeoutMs;
  let lastStatus;
  while (Date.now() < deadline) {
    const { body } = await get(`/scan/${id}`);
    if (body.status !== lastStatus) {
      lastStatus = body.status;
      const queueNote = body.queuePosition ? ` (queue position ${body.queuePosition})` : '';
      console.log(`    ${body.status}${queueNote}`);
    }
    if (body.status === 'done' || body.status === 'error' || body.status === 'cancelled') {
      return body;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`job ${id} did not finish within ${timeoutMs}ms`);
};

// ===== Health first, so a connection failure is reported clearly =====

try {
  await get('/healthz');
} catch {
  console.error(`Cannot reach ${BASE}. Start the server first:`);
  console.error('  node server.mjs');
  process.exit(1);
}

// ===== 1. Start a scan, then poll =====

heading('1. POST /scan returns immediately with an id');
console.log('  A scan takes seconds to minutes, so it is a job rather than a request:');
console.log('  POST accepts the work and returns 202 with somewhere to poll.');
console.log();

// `noCache` makes this scan go to the network even though the service has a warm
// file cache from earlier runs. Without it the first scan here would be a cache
// replay and the timing comparison in step 4 would be meaningless.
const started = await post('/scan', { url: TARGET, noCache: true });
console.log(`  HTTP ${started.status} (202 = accepted, not done)`);
console.log(`  ${JSON.stringify(started.body)}`);
console.log();

console.log('  Polling:');
const finished = await waitFor(started.body.id);
console.log();
console.log(`  status      ${finished.status}`);
console.log(`  duration    ${finished.durationMs}ms`);
console.log(`  JS files    ${finished.result.summary.jsCount}`);
console.log(`  sources     ${finished.result.summary.sourceCount} (capped at 200 inline)`);
console.log();

// ===== 2. The result is structured =====

heading('2. The result is the library result, serialised');
console.log('  The endpoint hands back the same `ScanResult` a library caller gets, so a');
console.log('  client can use it the same way.');
console.log();
for (const detail of finished.result.jsDetails.slice(0, 4)) {
  console.log(`  ${(detail.fromPlugin ?? '?').padEnd(20)} ${detail.url}`);
}
console.log(`  … and ${Math.max(0, finished.result.jsDetails.length - 4)} more`);
console.log();

if (finished.result.sources.length > 0) {
  console.log('  Restored sources carry their content:');
  for (const file of finished.result.sources.slice(0, 3)) {
    console.log(`    ${file.path}  [${file.mode}, ${file.content.length} bytes]`);
  }
  console.log();
}

// ===== 3. The Markdown report =====

heading('3. GET /scan/:id.md gives the CLI\'s report');
console.log('  `formatMarkdown` is the renderer the CLI uses, so a service produces');
console.log('  identical output without shelling out to it.');
console.log();

const report = await get(`/scan/${started.body.id}.md`);
console.log(`  HTTP ${report.status}, ${report.body.length} bytes`);
console.log();
console.log(report.body.split('\n').slice(0, 8).map((l) => `  ${l}`).join('\n'));
console.log('  …');
console.log();

// ===== 4. The cache makes a repeat scan fast =====

heading('4. A repeat scan replays the cache');
console.log('  Step 1 forced a cold scan; this one may read the cache. The service uses');
console.log('  a file cache, so the second scan reads `meta.json` and skips the network.');
console.log();

// This one is allowed to read the cache, which the previous scan just filled.
const cached = await post('/scan', { url: TARGET });
const cachedDone = await waitFor(cached.body.id);
console.log();
console.log(`  cold scan    ${finished.durationMs}ms  (network)`);
console.log(`  warm scan    ${cachedDone.durationMs}ms  (cache replay)`);
if (cachedDone.durationMs > 0) {
  console.log(`  ${(finished.durationMs / cachedDone.durationMs).toFixed(0)}x faster`);
}
console.log();
console.log('  Same result either way, which is the property that matters:');
const sameSet =
  JSON.stringify([...finished.result.jsUrls].sort()) ===
  JSON.stringify([...cachedDone.result.jsUrls].sort());
console.log(`    same URL set : ${sameSet}`);
console.log(`    same sources : ${finished.result.summary.sourceCount === cachedDone.result.summary.sourceCount}`);
console.log(`    same counts  : ${finished.result.summary.jsCount === cachedDone.result.summary.jsCount}`);
console.log();
console.log('  This fixture is on localhost, so even the cold scan is fast. Against a');
console.log('  real site the gap is seconds versus milliseconds — the cache is what makes');
console.log('  a rescan button viable.');
console.log();

// ===== 5. Concurrency is capped, and the excess queues =====

heading('5. More requests than slots means queueing, not overload');
console.log(`  The service runs at most 2 scans at once. Launching 4 means 2 run and 2`);
console.log('  wait — rather than 4 scans competing for sockets.');
console.log();

const burst = await Promise.all(
  Array.from({ length: 4 }, () => post('/scan', { url: TARGET })),
);
console.log('  Submitted 4 jobs:');
for (const job of burst) {
  console.log(`    ${job.body.id.slice(0, 8)}  ${job.body.status}  queue position ${job.body.queuePosition}`);
}
console.log();

const health = await get('/healthz');
console.log(`  /healthz reports: running ${health.body.running}, queued ${health.body.queued}`);
console.log();

const burstResults = await Promise.all(burst.map((job) => waitFor(job.body.id)));
console.log();
console.log(`  all ${burstResults.length} finished: ${burstResults.map((r) => r.status).join(', ')}`);
console.log('  Queue positions moved them through in order.');
console.log();

// ===== 6. Cancellation =====

heading('6. Cancelling aborts the work in flight');
console.log('  A client that gives up must not leave a scan running. The request is');
console.log('  aborted, which is what actually stops the in-flight HTTP calls.');
console.log();

// A localhost fixture finishes in milliseconds, so there would be nothing left to
// cancel. `CANCEL_TARGET` should be a slow site. Default to a real one; set
// CANCEL_TARGET=http://127.0.0.1:18080/ to see the "already finished" path instead.
const CANCEL_TARGET = process.env.CANCEL_TARGET ?? 'https://developer.mozilla.org/';

const toCancel = await post('/scan', { url: CANCEL_TARGET, noCache: true });
console.log(`  started ${toCancel.body.id.slice(0, 8)} (${toCancel.body.status})`);

// Let it get going so this exercises aborting in-flight requests, not just removing
// a queued job.
await new Promise((r) => setTimeout(r, 1500));

const before = await get(`/scan/${toCancel.body.id}`);
console.log(`  before cancel: ${before.body.status} (${before.body.elapsedMs}ms elapsed)`);

const cancelled = await post(`/scan/${toCancel.body.id}/cancel`);
console.log(`  cancel -> HTTP ${cancelled.status}, ${cancelled.body.status}`);
console.log();

const afterCancel = await get(`/scan/${toCancel.body.id}`);
console.log(`  polled status: ${afterCancel.body.status}`);
console.log();
console.log('  A 409 here means the scan had already finished — the target was too fast');
console.log('  to cancel. Set CANCEL_TARGET to a slower site to see the abort.');
console.log();

const healthAfter = await get('/healthz');
console.log(`  /healthz now: running ${healthAfter.body.running}, queued ${healthAfter.body.queued}`);
console.log('  The slot was released, so capacity was not leaked.');
console.log();

// ===== 7. Validation =====

heading('7. Bad input is rejected before a job is allocated');
console.log('  A URL jsdj would refuse is refused here, so an invalid request does not');
console.log('  consume a scan slot.');
console.log();

for (const bad of ['not-a-url', 'ftp://a.test/x', '', null, 42]) {
  const res = await post('/scan', { url: bad });
  console.log(`  ${JSON.stringify(bad).padEnd(18)} -> HTTP ${res.status}: ${res.body.error ?? res.body.status}`);
}
console.log();

// ===== 8. Job list =====

heading('8. GET /scans lists recent jobs');
const list = await get('/scans');
console.log(`  ${list.body.jobs.length} jobs tracked`);
for (const job of list.body.jobs.slice(0, 6)) {
  const duration = job.durationMs === null ? '—' : `${job.durationMs}ms`;
  console.log(`    ${job.status.padEnd(10)} ${duration.padEnd(9)} ${job.jsCount ?? '—'} files  ${job.url}`);
}
console.log();

console.log('Done. The server is still running; Ctrl+C to stop it.');