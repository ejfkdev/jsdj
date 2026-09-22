/**
 * A counting semaphore used to bound concurrent network requests.
 *
 * This replaces the channel-based budget in the Go fetcher. One difference
 * matters for behaviour: Go's semaphore blocked with no cancellation path, so a
 * waiting request could not be abandoned. Here `acquire` accepts an abort
 * signal, so a cancelled scan stops issuing requests instead of draining the
 * whole queue first.
 */

/** A cancellation request, mirroring the subset of `AbortSignal` used here. */
export interface AbortLike {
  readonly aborted: boolean;
  addEventListener(
    type: 'abort',
    listener: () => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (err: unknown) => void;
  signal?: AbortLike;
  onAbort?: () => void;
}

/** Bounds the number of concurrent operations. */
export class Semaphore {
  private available: number;
  private readonly waiters: Waiter[] = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`semaphore limit must be a positive integer, got ${limit}`);
    }
    this.available = limit;
  }

  /** Number of slots currently free. */
  get free(): number {
    return this.available;
  }

  /** Number of callers waiting for a slot. */
  get pending(): number {
    return this.waiters.length;
  }

  /**
   * Acquire a slot, resolving to the function that releases it.
   *
   * Rejects if `signal` aborts while waiting.
   */
  acquire(signal?: AbortLike): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(new AbortError());
    }

    if (this.available > 0) {
      this.available--;
      return Promise.resolve(this.makeRelease());
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      if (signal) {
        const onAbort = () => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) {
            this.waiters.splice(idx, 1);
          }
          reject(new AbortError());
        };
        waiter.signal = signal;
        waiter.onAbort = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  /**
   * Run `fn` while holding a slot, releasing it whatever the outcome.
   */
  async run<T>(fn: () => Promise<T>, signal?: AbortLike): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      // Guard against a double release inflating the slot count.
      if (released) {
        return;
      }
      released = true;

      const next = this.waiters.shift();
      if (next) {
        if (next.signal && next.onAbort) {
          next.signal.removeEventListener('abort', next.onAbort);
        }
        // Hand the slot directly to the next waiter; do not touch `available`.
        next.resolve(this.makeRelease());
        return;
      }
      this.available++;
    };
  }
}

/** Thrown when an operation is abandoned because its signal aborted. */
export class AbortError extends Error {
  constructor(message = 'operation aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

/**
 * Run `tasks` with at most `limit` in flight at once, preserving input order in
 * the result array.
 *
 * Unlike `Promise.all` this keeps going after individual failures; the caller
 * inspects each slot. Rejections from `fn` are captured, not propagated, so one
 * broken task cannot abandon its siblings — the discovery loop relies on that,
 * since a single unreachable chunk must not end the scan.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) {
        return;
      }
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index]!, index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}