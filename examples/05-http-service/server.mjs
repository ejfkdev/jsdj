/**
 * A scan service.
 *
 * Wraps jsdj in an HTTP endpoint. The interesting parts are the ones a scan forces
 * you to think about, and they are the same in any framework:
 *
 *   - **A scan is slow.** Seconds to minutes on a real site. So it is a job, not a
 *     request: POST returns an id, GET polls for the result.
 *   - **A scan is expensive.** It opens many sockets. An unbounded number of
 *     concurrent scans will exhaust the process, so concurrency is capped and
 *     excess work queues.
 *   - **A scan needs cancelling.** A client that gives up should not leave a
 *     thousand requests running. An AbortSignal is threaded through.
 *   - **Sources can be huge.** A large app restores thousands of files. The result
 *     is capped, and the full tree stays on disk.
 *
 * Run:   node server.mjs
 * Try:   node demo.mjs
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { scan, FsStorage, formatMarkdown } from '@ejfkdev/jsdj';

// ===== Configuration =====

const PORT = Number(process.env.PORT ?? 3000);

/** How many scans may run at once. Everything else waits in the queue. */
const MAX_CONCURRENT_SCANS = 2;

/** Restored source files returned inline. The rest stay on disk. */
const MAX_INLINE_SOURCES = 200;

/** How long a finished job's result is kept. */
const JOB_TTL_MS = 10 * 60 * 1000;

// ===== Job bookkeeping =====

/**
 * @typedef {object} Job
 * @property {string} id
 * @property {string} url
 * @property {'queued'|'running'|'done'|'error'|'cancelled'} status
 * @property {number} createdAt
 * @property {number} [startedAt]
 * @property {number} [finishedAt]
 * @property {object} [result]
 * @property {string} [error]
 * @property {AbortController} [controller]
 */

/** @type {Map<string, Job>} */
const jobs = new Map();

/** Jobs waiting for a slot. A plain array used as a FIFO. */
const queue = [];

/** How many scans are running right now. */
let running = 0;

function pump() {
  // Start queued jobs while slots are free. Called after every state change.
  while (running < MAX_CONCURRENT_SCANS && queue.length > 0) {
    const id = queue.shift();
    const job = jobs.get(id);
    if (job === undefined || job.status !== 'queued') {
      // Cancelled while queued: skip it and try the next.
      continue;
    }
    runJob(job);
  }
}

function runJob(job) {
  running++;
  job.status = 'running';
  job.startedAt = Date.now();
  job.controller = new AbortController();

  // A file cache is the right store for a service: a repeat scan of the same site
  // then replays `meta.json` and skips the network, which turns a 60-second scan
  // into milliseconds. `FsStorage.create` resolves the default cache root.
  FsStorage.create()
    .then((storage) =>
      scan({
        url: job.url,
        storage,
        // A per-scan override the caller sent, defaulting to the service's.
        maxInlineSources: job.maxInlineSources ?? MAX_INLINE_SOURCES,
        noCache: job.noCache,
        signal: job.controller.signal,
      }),
    )
    .then((result) => {
      if (job.status === 'cancelled') {
        return;
      }
      job.status = 'done';
      job.result = {
        summary: result.summary,
        jsUrls: result.jsUrls,
        jsDetails: result.jsDetails,
        htmlEntries: result.htmlEntries,
        sourceMaps: result.sourceMaps ?? {},
        cacheDirs: result.cacheDirs ?? {},
        sources: result.sources,
        sourcesOmitted: result.sourcesOmitted,
        cold: job.noCache === true,
      };
    })
    .catch((err) => {
      if (job.status === 'cancelled') {
        return;
      }
      job.status = 'error';
      job.error = err instanceof Error ? err.message : String(err);
    })
    .finally(() => {
      running--;
      job.finishedAt = Date.now();
      // A queued job's signal must not keep its controller alive after it is gone.
      job.controller = undefined;
      pump();
    });
}

// ===== Request handling =====

const json = (res, status, body) => {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

const readBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    // Refuse an oversized body rather than buffering it.
    if (chunks.reduce((n, c) => n + c.length, 0) > 1_000_000) {
      throw new Error('request body too large');
    }
  }
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

/** Reject a URL that jsdj would reject anyway, before allocating a job. */
const isScannable = (value) => {
  if (typeof value !== 'string' || value === '') {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  try {
    // ---- health ----
    if (req.method === 'GET' && path === '/healthz') {
      return json(res, 200, {
        status: 'ok',
        running,
        queued: queue.length,
        maxConcurrent: MAX_CONCURRENT_SCANS,
        jobs: jobs.size,
      });
    }

    // ---- start a scan ----
    if (req.method === 'POST' && path === '/scan') {
      const body = await readBody(req);

      if (!isScannable(body.url)) {
        return json(res, 400, {
          error: 'url must be an absolute http:// or https:// URL',
          received: body.url ?? null,
        });
      }

      const id = randomUUID();
      const job = {
        id,
        url: body.url,
        status: 'queued',
        createdAt: Date.now(),
        maxInlineSources:
          typeof body.maxInlineSources === 'number' ? body.maxInlineSources : undefined,
        // A caller can force a fresh scan, which is what a UI's "rescan" button
        // needs. Without it the cache would silently answer with old data.
        noCache: body.noCache === true,
      };

      jobs.set(id, job);
      queue.push(id);
      pump();

      // 202, not 200: the work has been accepted but not done. The Location header
      // tells the client where to poll, which is the convention for this shape.
      res.setHeader('location', `/scan/${id}`);
      return json(res, 202, {
        id,
        status: job.status,
        poll: `/scan/${id}`,
        queuePosition: job.status === 'queued' ? queue.indexOf(id) + 1 : 0,
      });
    }

    // ---- poll ----
    const pollMatch = /^\/scan\/([0-9a-f-]+)$/.exec(path);
    if (req.method === 'GET' && pollMatch) {
      const job = jobs.get(pollMatch[1]);
      if (job === undefined) {
        return json(res, 404, { error: 'unknown job', id: pollMatch[1] });
      }

      if (job.status === 'queued' || job.status === 'running') {
        return json(res, 200, {
          id: job.id,
          status: job.status,
          url: job.url,
          elapsedMs: Date.now() - (job.startedAt ?? job.createdAt),
          queuePosition: job.status === 'queued' ? queue.indexOf(job.id) + 1 : 0,
        });
      }

      if (job.status === 'error') {
        return json(res, 200, { id: job.id, status: 'error', error: job.error, url: job.url });
      }

      if (job.status === 'cancelled') {
        return json(res, 200, { id: job.id, status: 'cancelled', url: job.url });
      }

      return json(res, 200, {
        id: job.id,
        status: 'done',
        url: job.url,
        durationMs: (job.finishedAt ?? 0) - (job.startedAt ?? 0),
        result: job.result,
      });
    }

    // ---- the Markdown report, for a caller that wants what the CLI prints ----
    const reportMatch = /^\/scan\/([0-9a-f-]+)\.md$/.exec(path);
    if (req.method === 'GET' && reportMatch) {
      const job = jobs.get(reportMatch[1]);
      if (job === undefined) {
        return json(res, 404, { error: 'unknown job' });
      }
      if (job.status !== 'done' || job.result === undefined) {
        return json(res, 409, { error: `job is ${job.status}` });
      }

      // `formatMarkdown` is the same renderer the CLI uses, so the service and the
      // CLI produce identical output without shelling out.
      const markdown = formatMarkdown({
        ...job.result,
        sources: [],
        sourcesOmitted: job.result.sourcesOmitted,
      });
      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-length': Buffer.byteLength(markdown),
      });
      return res.end(markdown);
    }

    // ---- cancel ----
    const cancelMatch = /^\/scan\/([0-9a-f-]+)\/cancel$/.exec(path);
    if (req.method === 'POST' && cancelMatch) {
      const job = jobs.get(cancelMatch[1]);
      if (job === undefined) {
        return json(res, 404, { error: 'unknown job' });
      }
      if (job.status === 'done' || job.status === 'error') {
        return json(res, 409, { error: `job already ${job.status}` });
      }

      job.status = 'cancelled';
      // Aborting is what stops the in-flight requests. Without it the scan would keep
      // running to completion for a client that has already gone away — the failure
      // mode that makes a service fall over under load.
      job.controller?.abort();
      job.finishedAt = Date.now();

      const queuedAt = queue.indexOf(job.id);
      if (queuedAt >= 0) {
        queue.splice(queuedAt, 1);
      }

      return json(res, 200, { id: job.id, status: 'cancelled' });
    }

    // ---- job list ----
    if (req.method === 'GET' && path === '/scans') {
      return json(res, 200, {
        jobs: [...jobs.values()]
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, 50)
          .map((job) => ({
            id: job.id,
            url: job.url,
            status: job.status,
            createdAt: job.createdAt,
            durationMs: job.finishedAt && job.startedAt ? job.finishedAt - job.startedAt : null,
            jsCount: job.result?.summary.jsCount ?? null,
          })),
      });
    }

    return json(res, 404, { error: 'not found', path });
  } catch (err) {
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

// ===== Housekeeping =====

// Finished jobs are held for a while so a slow client can still collect its result,
// then dropped. An unbounded map is a slow memory leak in a long-running service.
setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    const finished = job.finishedAt ?? 0;
    if (finished !== 0 && finished < cutoff) {
      jobs.delete(id);
    }
  }
}, 60_000).unref();

// ===== Shutdown =====

// Abort in-flight scans on the way out, so a container restart does not leave a
// thousand sockets open on the target site.
let shuttingDown = false;
const shutdown = (signal) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`\n${signal} received, aborting ${running} scan(s) and exiting`);

  for (const job of jobs.values()) {
    if (job.status === 'running') {
      job.status = 'cancelled';
      job.controller?.abort();
    }
  }

  server.close(() => process.exit(0));
  // Do not hang forever on a stuck socket.
  setTimeout(() => process.exit(0), 5000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, () => {
  console.log(`scan service on http://127.0.0.1:${PORT}`);
  console.log(`  POST /scan                 { "url": "https://..." } -> { id }`);
  console.log(`  GET  /scan/:id             poll for status and result`);
  console.log(`  GET  /scan/:id.md          the Markdown report`);
  console.log(`  POST /scan/:id/cancel      abort a queued or running scan`);
  console.log(`  GET  /scans                recent jobs`);
  console.log(`  GET  /healthz              liveness plus queue depth`);
  console.log();
  console.log(`  max concurrent scans: ${MAX_CONCURRENT_SCANS}`);
  console.log();
  console.log('run `node demo.mjs` in another terminal');
});