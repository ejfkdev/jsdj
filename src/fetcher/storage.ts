/**
 * The storage contract.
 *
 * The CLI writes every downloaded artifact to a fixed temp directory, and the
 * presence of `meta.json` lets it skip re-discovery on a second run. That is a
 * fine assumption on a CLI and an impossible one in a browser, so the whole
 * thing sits behind this interface.
 *
 * Two implementations ship:
 *
 * - {@link FsStorage} — Node's filesystem, using the on-disk layout.
 * - {@link NullStorage} — used in the browser, or whenever caching is disabled.
 *   Every write is a no-op and every read misses, so the scan always goes to the
 *   network. That is the specified browser behaviour: no caching, with the
 *   developer free to inject their own store.
 *
 * All methods are async even where the filesystem implementation could be
 * synchronous, because a browser-backed store (OPFS, IndexedDB, a remote
 * bucket) cannot be anything but async.
 */

/**
 * A location for one artifact: a `subdir` (`js`, `html`, `source_map`,
 * `metadata`, `sources`) plus a path within it.
 */
export interface StorageKey {
  /** Cached entry root for the site, e.g. `https_example.com`. */
  scope: string;
  /** Artifact category. */
  subdir: string;
  /** Path within `subdir`. Callers pass already-flattened or tree-shaped paths. */
  path: string;
}

/** A pluggable store for downloaded and restored artifacts. */
export interface Storage {
  /** Whether reads are permitted. */
  readonly readable: boolean;
  /** Whether writes are permitted. */
  readonly writable: boolean;

  /** Absolute base directory, when the store has one. Diagnostics only. */
  readonly baseDir?: string;

  /**
   * Read an artifact. Returns `null` on miss, or when reads are disabled.
   *
   * An empty stored file also counts as a miss — a zero-byte
   * download is never useful and re-fetching is preferable to trusting it.
   */
  read(key: StorageKey): Promise<Uint8Array | null>;

  /** Write an artifact. Silently does nothing when writes are disabled. */
  write(key: StorageKey, content: Uint8Array): Promise<void>;

  /** Whether an artifact exists and is non-empty. */
  exists(key: StorageKey): Promise<boolean>;

  /**
   * Read the site metadata document, if the store keeps one.
   *
   * Separate from `read` because a store may implement metadata differently
   * (a single record, an index) than blob storage.
   */
  readMetadata(scope: string): Promise<Uint8Array | null>;

  /** Write the site metadata document. */
  writeMetadata(scope: string, content: Uint8Array): Promise<void>;

  /** Restored source files written during this scan, keyed by `sources/` path. */
  listSources(scope: string): Promise<string[]>;

  /** Release resources. */
  close?(): Promise<void>;
}

/** Derive the storage scope for a site URL, e.g. `https_example.com_8080_aa`. */
export function scopeFromUrl(url: string): string {
  let scope = url;
  scope = scope.replace(/^https:\/\//, 'https_');
  scope = scope.replace(/^http:\/\//, 'http_');
  scope = scope.replace(/:/g, '_');
  scope = scope.replace(/\//g, '_');
  return scope;
}

/**
 * Make a path safe to use as a filename segment.
 *
 * Leading and trailing slashes are
 * dropped, `..` is neutralised, and separators plus Windows-reserved characters
 * become underscores. Returns `''` when the input cannot be made safe, which
 * callers treat as "do not cache this".
 */
export function normalizePathForFile(input: string): string {
  let path = input;
  if (path.startsWith('/')) {
    path = path.slice(1);
  }
  if (path.endsWith('/')) {
    path = path.slice(0, -1);
  }

  path = path.replace(/\.\./g, '_');
  path = path.replace(/\.\//g, '_');
  path = path.replace(/\/\.\//g, '_');

  let out = '';
  for (const ch of path) {
    out += '/\\<>:"|?*\u0000'.includes(ch) ? '_' : ch;
  }

  // A residual `..` means the input was hostile; refuse it.
  return out.includes('..') ? '' : out;
}

/**
 * Constrain a restored-source path to a safe relative form, keeping its
 * directory structure.
 *
 * Unlike {@link normalizePathForFile} this does not flatten: the whole point of
 * the `sources/` tree is to reproduce the original project layout. Each segment
 * is validated instead, and any `..` segment rejects the path outright — this is
 * the final guard before a write.
 */
export function safeSourcePath(sourcePath: string): string | null {
  if (sourcePath === '') {
    return null;
  }
  const segments = sourcePath.replace(/\\/g, '/').split('/');
  const cleaned: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      return null;
    }
    cleaned.push(segment);
  }
  return cleaned.length === 0 ? null : cleaned.join('/');
}