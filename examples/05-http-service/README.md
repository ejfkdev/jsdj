# Example: a scan service

Wraps jsdj in an HTTP endpoint, built on `node:http` so there is nothing to install
beyond jsdj itself. The structure is the same in any framework — Express, Fastify,
Hono — so the parts worth reading are the ones a scan forces you to think about.

## Setup

```bash
npm install
node ../fixture-site/serve.mjs      # the scan target, in another terminal
node server.mjs                     # the service
node demo.mjs                       # exercise it, in a third terminal
```

## The four problems a scan creates

**A scan is slow.** Seconds to minutes on a real site, so it cannot be a request.
`POST /scan` returns `202` with a job id and a `Location` to poll; `GET /scan/:id`
reports progress and the result.

**A scan is expensive.** It opens many sockets at once. In an unbounded service, ten
simultaneous scans become ten thousand sockets and the process falls over. So
concurrency is capped (`MAX_CONCURRENT_SCANS = 2`) and the excess queues, with the
queue position reported to the client.

**A scan needs cancelling.** A client that gives up must not leave a thousand
requests running. `POST /scan/:id/cancel` calls `AbortController.abort()`, which
threads through to the fetcher and stops the in-flight requests. The slot is released,
verified by `/healthz` returning to zero.

**A result can be huge.** A large app restores thousands of source files. The service
caps the inline content at 200 files and keeps the full tree on disk, reporting how
many were omitted.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/scan` | Start a scan. Body: `{ url, noCache?, maxInlineSources? }` |
| `GET` | `/scan/:id` | Poll status and result |
| `GET` | `/scan/:id.md` | The Markdown report |
| `POST` | `/scan/:id/cancel` | Abort a queued or running scan |
| `GET` | `/scans` | Recent jobs |
| `GET` | `/healthz` | Liveness plus queue depth |

```bash
# start a scan
curl -s -X POST localhost:3000/scan \
  -H 'content-type: application/json' \
  -d '{"url":"http://127.0.0.1:18080/"}' | jq

# poll it
curl -s localhost:3000/scan/<id> | jq '.status, .result.summary'

# ask for a fresh scan even though the cache is warm
curl -s -X POST localhost:3000/scan \
  -H 'content-type: application/json' \
  -d '{"url":"http://127.0.0.1:18080/","noCache":true}' | jq
```

## What the demo covers

`demo.mjs` walks through eight things:

1. `POST /scan` returns `202` immediately, then polling reports `running` → `done`.
2. The result is the library `ScanResult`, serialised — the same shape a library
   caller gets, so a client uses it identically.
3. `GET /scan/:id.md` produces the CLI's report, because `formatMarkdown` is the
   same renderer. No subprocess involved.
4. A repeat scan replays the cache: 26ms cold versus 2ms warm, same URLs, same
   sources, same counts.
5. Four simultaneous requests with two slots: two run, two queue, all complete in
   order.
6. Cancelling a running scan returns `200`, the status becomes `cancelled`, and the
   slot is released.
7. Invalid input is rejected with `400` before a job is allocated, so a bad request
   never consumes a scan slot.
8. `GET /scans` lists recent jobs with durations.

## Why the cache matters here

The service uses a file cache, which turns a rescan into a `meta.json` replay. That
is what makes a "rescan" button in a UI viable: seconds become milliseconds. It also
means `noCache` has to exist, or the button would silently return stale data.

`noCache` suppresses cache *reads* while still writing what the scan downloads. That
is the behaviour the reference CLI's `--no-cache` has, and the distinction matters:
a "disabled" cache that also refused writes would throw away the artifacts the forced
rescan just fetched, making the next scan slow again.

## Notes on the implementation

**Abort is threaded, not faked.** `job.controller.signal` is passed as `scan({ signal })`
and reaches every fetch. Removing it would make a cancelled scan keep running to
completion — the failure mode that makes a service fall over under sustained load.

**Jobs expire.** Finished jobs are held for 10 minutes so a slow client can still
collect its result, then dropped. An unbounded map is a slow memory leak.

**In-flight scans are aborted on shutdown.** `SIGTERM` aborts everything and then
closes the server, so a container restart does not leave sockets open against the
target. A hard timeout exits anyway if a socket is stuck.

**The 202/poll shape is a choice.** For a small site you could scan inline within the
request. The job shape is here because scanning a real site takes long enough that a
request would time out at every proxy in the path.

## Adapting this

Express and friends change only the routing:

```js
app.post('/scan', async (req, res) => {
  const job = startJob(req.body.url);
  res.status(202).location(`/scan/${job.id}`).json({ id: job.id });
});

app.get('/scan/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  res.json(job.status === 'done' ? job.result : { status: job.status });
});
```

The job registry, concurrency cap, cancellation and cache handling are unchanged.