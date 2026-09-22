/**
 * Storage implementations with no platform dependencies.
 *
 * These live apart from `fs-storage.ts` because that module reaches for
 * `node:path` and `node:fs` — lazily, but a bundler still walks the import edge.
 * Keeping the in-memory stores here lets the browser entry re-export them without
 * any Node reference appearing in the graph.
 */

import { type Storage, type StorageKey } from './storage.js';

/** The no-op store: nothing is read, nothing is written, nothing persists. */
export class NullStorage implements Storage {
  readonly readable = false;
  readonly writable = false;

  async read(_key: StorageKey): Promise<Uint8Array | null> {
    void _key;
    return null;
  }

  async write(_key: StorageKey, _content: Uint8Array): Promise<void> {
    void _key;
    void _content;
  }

  async exists(_key: StorageKey): Promise<boolean> {
    void _key;
    return false;
  }

  async readMetadata(_scope: string): Promise<Uint8Array | null> {
    void _scope;
    return null;
  }

  async writeMetadata(_scope: string, _content: Uint8Array): Promise<void> {
    void _scope;
    void _content;
  }

  async listSources(_scope: string): Promise<string[]> {
    void _scope;
    return [];
  }
}

/**
 * An in-memory store.
 *
 * Useful in tests, and in a browser session that wants cache semantics for its
 * lifetime without persistence. A `readable`/`writable` configuration reproduces
 * the CLI's `--no-cache` split, where reads are skipped but writes still happen.
 */
export class MemoryStorage implements Storage {
  readonly readable: boolean;
  readonly writable: boolean;
  private readonly entries = new Map<string, Uint8Array>();

  constructor(options: { readable?: boolean; writable?: boolean } = {}) {
    this.readable = options.readable ?? true;
    this.writable = options.writable ?? true;
  }

  private key(k: StorageKey): string {
    return `${k.scope}/${k.subdir}/${k.path}`;
  }

  async read(key: StorageKey): Promise<Uint8Array | null> {
    if (!this.readable) {
      return null;
    }
    const value = this.entries.get(this.key(key));
    // A zero-byte entry counts as a miss, matching the file store: an
    // empty download is never useful, so re-fetching beats trusting it.
    return value && value.byteLength > 0 ? value : null;
  }

  async write(key: StorageKey, content: Uint8Array): Promise<void> {
    if (!this.writable) {
      return;
    }
    this.entries.set(this.key(key), content);
  }

  async exists(key: StorageKey): Promise<boolean> {
    const value = this.entries.get(this.key(key));
    return value !== undefined && value.byteLength > 0;
  }

  async readMetadata(scope: string): Promise<Uint8Array | null> {
    return this.read({ scope, subdir: '', path: 'meta.json' });
  }

  async writeMetadata(scope: string, content: Uint8Array): Promise<void> {
    return this.write({ scope, subdir: '', path: 'meta.json' }, content);
  }

  async listSources(scope: string): Promise<string[]> {
    const prefix = `${scope}/sources/`;
    const out: string[] = [];
    for (const [key, value] of this.entries) {
      if (key.startsWith(prefix) && value.byteLength > 0) {
        out.push(key.slice(prefix.length));
      }
    }
    return out.sort();
  }

  /** Drop everything. */
  clear(): void {
    this.entries.clear();
  }

  /** Number of stored artifacts. */
  get size(): number {
    return this.entries.size;
  }
}