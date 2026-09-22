/**
 * Storage implementations.
 *
 * {@link FsStorage} uses the on-disk layout. The platform-free stores
 * (`NullStorage`, `MemoryStorage`) live in `memory-storage.ts` so the browser
 * entry can re-export them without pulling this module's `node:fs` and
 * `node:path` edges into a bundle.
 */

import { scopeFromUrl, safeSourcePath, type Storage, type StorageKey } from './storage.js';
import { NullStorage } from './memory-storage.js';
import { importBuiltin } from './import-builtin.js';

/** Default cache location. */
export const DEFAULT_CACHE_SUBDIR = 'ejfkdev/dj';

export interface FsStorageOptions {
  /** Cache root. Defaults to `<tmpdir>/ejfkdev/dj`. */
  baseDir?: string;
  /** Allow reads. */
  readable?: boolean;
  /** Allow writes. */
  writable?: boolean;
  /**
   * Mirror every write into this directory as well, flattening the scope.
   * Backs the CLI's `-o/--output`.
   */
  outputDir?: string;
}

/**
 * Filesystem-backed storage, using the directory layout:
 *
 * ```text
 * <baseDir>/<scope>/
 * ├── js/            downloaded JS
 * ├── source_map/    source map files
 * ├── sources/       restored original sources (directory tree preserved)
 * ├── html/          the initial page
 * └── meta.json      site metadata
 * ```
 *
 * `node:fs` is imported lazily so that merely importing this module never pulls
 * a Node builtin into a browser bundle.
 */
export class FsStorage implements Storage {
  readonly readable: boolean;
  readonly writable: boolean;
  readonly baseDir: string;
  private readonly outputDir: string | undefined;
  private fsModule: Promise<typeof import('node:fs/promises')> | null = null;

  constructor(options: FsStorageOptions = {}) {
    this.readable = options.readable ?? true;
    this.writable = options.writable ?? true;
    this.outputDir = options.outputDir;
    this.baseDir = options.baseDir ?? '';
  }

  /** Resolve the default cache root lazily, since it needs `os.tmpdir()`. */
  static async create(options: FsStorageOptions = {}): Promise<FsStorage> {
    let baseDir = options.baseDir;
    if (baseDir === undefined || baseDir === '') {
      const os = await importBuiltin<typeof import('node:os')>('node:os');
      const path = await importBuiltin<typeof import('node:path')>('node:path');
      baseDir = path.join(os.tmpdir(), DEFAULT_CACHE_SUBDIR);
    }
    return new FsStorage({ ...options, baseDir });
  }

  private fs(): Promise<typeof import('node:fs/promises')> {
    if (this.fsModule === null) {
      this.fsModule = importBuiltin<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    }
    return this.fsModule;
  }

  private async pathMod(): Promise<typeof import('node:path')> {
    return importBuiltin<typeof import('node:path')>('node:path');
  }

  /** Absolute path for a key, or `null` when the key cannot be made safe. */
  async resolvePath(key: StorageKey): Promise<string | null> {
    const path = await this.pathMod();
    const safePath =
      key.subdir === 'sources'
        ? safeSourcePath(key.path)
        : key.path === ''
          ? null
          : key.path;
    if (key.path !== '' && safePath === null) {
      return null;
    }
    const relative = safePath ?? '';
    return relative === ''
      ? path.join(this.baseDir, key.scope)
      : path.join(this.baseDir, key.scope, key.subdir, relative);
  }

  async read(key: StorageKey): Promise<Uint8Array | null> {
    if (!this.readable) {
      return null;
    }
    const resolved = await this.resolvePath(key);
    if (!resolved) {
      return null;
    }
    const fs = await this.fs();
    try {
      const data = await fs.readFile(resolved);
      return data.byteLength === 0 ? null : new Uint8Array(data);
    } catch {
      return null;
    }
  }

  async write(key: StorageKey, content: Uint8Array): Promise<void> {
    if (!this.writable) {
      return;
    }
    const resolved = await this.resolvePath(key);
    if (resolved) {
      await this.writeFileAt(resolved, content);
    }
    if (this.outputDir !== undefined && this.outputDir !== '') {
      const path = await this.pathMod();
      const outPath =
        key.path === ''
          ? path.join(this.outputDir, 'meta.json')
          : path.join(this.outputDir, key.subdir, key.path.replace(/\\/g, '/'));
      await this.writeFileAt(outPath, content);
    }
  }

  private async writeFileAt(
    filePath: string,
    content: Uint8Array,
  ): Promise<void> {
    const fs = await this.fs();
    const path = await this.pathMod();
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content);
    } catch {
      // A failed cache write must never fail the scan.
    }
  }

  async exists(key: StorageKey): Promise<boolean> {
    const resolved = await this.resolvePath(key);
    if (!resolved) {
      return false;
    }
    try {
      const fs = await this.fs();
      const stat = await fs.stat(resolved);
      return stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
  }

  async readMetadata(scope: string): Promise<Uint8Array | null> {
    return this.read({ scope, subdir: '', path: 'meta.json' });
  }

  async writeMetadata(scope: string, content: Uint8Array): Promise<void> {
    return this.write({ scope, subdir: '', path: 'meta.json' }, content);
  }

  /**
   * Walk `sources/` and return every file path relative to that directory.
   *
   * Used to decide whether a previous run's restored sources are still intact,
   * so restoration can be skipped.
   */
  async listSources(scope: string): Promise<string[]> {
    const path = await this.pathMod();
    const root = path.join(this.baseDir, scope, 'sources');
    const fs = await this.fs();
    const out: string[] = [];

    const walk = async (dir: string, prefix: string): Promise<void> => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
          await walk(path.join(dir, entry.name), rel);
        } else if (entry.isFile()) {
          out.push(rel);
        }
      }
    };

    await walk(root, '');
    return out.sort();
  }

  /** Absolute path of the `sources/` directory for a scope. */
  async sourcesDir(scope: string): Promise<string> {
    const path = await this.pathMod();
    return path.join(this.baseDir, scope, 'sources');
  }

  /** Count files directly under a subdirectory, for output stats. */
  async countFiles(scope: string, subdir: string): Promise<number> {
    const path = await this.pathMod();
    const fs = await this.fs();
    try {
      const entries = await fs.readdir(path.join(this.baseDir, scope, subdir));
      return entries.length;
    } catch {
      return 0;
    }
  }
}

/** Build the storage a scan should use, given its options. */
export async function createStorage(options: {
  /** Explicit store, used as-is. */
  storage?: Storage;
  /** Cache root override for the filesystem store. */
  cacheDir?: string;
  /** Allow reads. */
  readable?: boolean;
  /** Allow writes. */
  writable?: boolean;
  /** Mirror writes here too (`-o`). */
  outputDir?: string;
  /** Force the no-op store regardless of platform. */
  disabled?: boolean;
}): Promise<Storage> {
  if (options.storage) {
    return options.storage;
  }
  if (options.disabled) {
    return new NullStorage();
  }

  const { detectRuntime } = await import('./runtime.js');
  if (detectRuntime() !== 'node') {
    // No filesystem in the browser: the specified behaviour is no caching, with
    // the developer supplying their own store if they want it.
    return new NullStorage();
  }

  return FsStorage.create({
    baseDir: options.cacheDir,
    readable: options.readable ?? true,
    writable: options.writable ?? true,
    outputDir: options.outputDir,
  });
}

export { scopeFromUrl };