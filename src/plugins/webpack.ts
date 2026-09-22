/**
 * Webpack / rspack chunk discovery.
 *
 * ## Why this is long
 *
 * Webpack's runtime has been rewritten repeatedly and each generation names its
 * chunk-URL builder differently and stores its chunk-to-hash map in a different
 * shape. There is no single pattern; there is a sequence of increasingly generic
 * attempts, and each one exists because a real site needed it. That shape is
 * preserved deliberately — collapsing the branches into something tidier would
 * silently stop finding chunks on the sites each branch was written for.
 *
 * The attempts run in a fixed order, most specific first, and each returns as
 * soon as it produces chunk URLs:
 *
 * 1. `"prefix" + id + sep + {id:hash}[id] + suffix` — the classic runtime shape.
 * 2. `"prefix" + ({id:name}[id] || id) + "." + {id:hash}[id] + ".js"` — with a
 *    name map, as rsbuild/rspack inline.
 * 3. `"prefix/" + {id:name}[id] + "." + {id:hash}[id] + ".js"` — folder-scoped.
 * 4. `"prefix/" + ({id:name}[id] || id) + "." + {id:hash}[id] + ".js"` — the
 *    `__webpack_require__.u` form.
 * 5. `({id:name}[id] || id) + "." + {id:hash}[id] + ".js"` — no prefix.
 * 6. `(id === e ? "special" : e) + "-" + {id:hash}[id] + ".js"` — Gatsby's shape.
 * 7. Arrow-function prefix plus a `{id:hash}` map.
 * 8. Generic fallbacks: path prefix + `chunk-<hash>`, numeric hash maps,
 *    `webpackChunk_x.push([[id]])`, URL-builder hash, `.e(id)` calls, string
 *    chunk ids, and finally the webpack 4 `HASH.TIMESTAMP` fingerprint.
 *
 * ## State that persists across files
 *
 * Two maps outlive a single analysis, because the information they hold is split
 * across files: `stringChunkHashMaps` collects string chunk-id hashes (a chunk's
 * id appears in one file and its hash in another), and `runtimeFingerprint`
 * carries the `HASH.TIMESTAMP` pattern from an inline HTML runtime to the
 * `app.js` that only contains `.e("chunk-xxx")` calls. A plugin instance is
 * therefore stateful and must not be reused across scans.
 */

import type { AnalyzeInput, Plugin, PluginResult } from '../extractor/types.js';
import {
  ResultBuilder,
  containsAny,
  findAllFirst,
  forEachMatch,
} from './helpers.js';

/** Whether a string consists only of lower-case hex digits. */
function isHex(value: string): boolean {
  if (value === '') {
    return false;
  }
  for (const ch of value) {
    const isDigit = ch >= '0' && ch <= '9';
    const isLowerHex = ch >= 'a' && ch <= 'f';
    if (!isDigit && !isLowerHex) {
      return false;
    }
  }
  return true;
}

/**
 * Whether a chunk id looks like a complete `chunk-<hash>` filename rather than a
 * module name.
 *
 * `chunk-2d0b2b28` is a finished filename and can be fetched as-is; `chunk-vendor`
 * is a module name that still needs a hash, so it becomes a wildcard probe. The
 * 70% threshold tolerates ids that are mostly-but-not-entirely hex.
 */
export function isLikelyChunkHash(chunkId: string): boolean {
  if (!chunkId.startsWith('chunk-') || chunkId.length <= 'chunk-'.length + 7) {
    return false;
  }
  const hashPart = chunkId.slice('chunk-'.length);
  let hexCount = 0;
  for (const ch of hashPart) {
    if (
      (ch >= '0' && ch <= '9') ||
      (ch >= 'a' && ch <= 'f') ||
      (ch >= 'A' && ch <= 'F')
    ) {
      hexCount++;
    }
  }
  return hexCount / hashPart.length > 0.7;
}

/** `{id:value}` map extraction, restricted to numeric keys. */
const ID_VALUE = /(\d+):"([^"]+)"/g;
/** Numeric-key hash entries, tolerant of whitespace. */
const MAP_NUMERIC_HASH = /(\d+)\s*:\s*"([a-zA-Z0-9]{3,40})"/g;
/** Quoted-string-key hash entries. */
const MAP_QUOTED_KEY_HASH = /"([a-zA-Z_][a-zA-Z0-9_.~@\-/]+)"\s*:\s*"([a-zA-Z0-9]{3,40})"/g;
/** Bare-identifier-key hash entries. */
const MAP_IDENT_KEY_HASH = /([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:\s*"([a-zA-Z0-9]{3,40})"/g;
/** Quoted-string-key value entries. */
const MAP_QUOTED_KEY_VALUE = /"([a-zA-Z_][a-zA-Z0-9_.~@\-/]+)"\s*:\s*"([^"\\]{1,80})"/g;
/** Bare-identifier-key value entries. */
const MAP_IDENT_KEY_VALUE = /([a-zA-Z_$][a-zA-Z0-9_$]{1,60})\s*:\s*"([^"\\]{1,80})"/g;
/** Quoted numeric keys, as federation runtimes emit. */
const FC_NUM_HASH = /"(\d+)"\s*:\s*"([a-zA-Z0-9]{3,40})"/g;
const FC_NUM_NAME = /"(\d+)"\s*:\s*"([^"\\]{1,80})"/g;

export class WebpackPlugin implements Plugin {
  readonly name = 'WebpackPlugin';

  // ===== Precheck =====
  private readonly markers = [
    '__webpack_require__',
    'webpackJsonp',
    'chunk-',
    'webpackChunk',
    '__webpack_public_path__',
    'resourceBaseUrl',
    // rspack 2.x renamed the runtime globals; `__rspack_*` markers are injected
    // on demand from 2.0 onwards.
    'rspackChunk',
    '__rspack_',
  ];

  /**
   * A webpack 5 minimal runtime with none of the standard markers, recognised
   * purely by the shape of its chunk URL builder.
   */
  private readonly minimalRuntime =
    /=\s*function\s*\(\w+\)\s*\{\s*return\s*"[^"]*"\s*\+\s*\w+\s*\+\s*"[^"]*"\s*\+\s*\(?\{[^}]*\}\)?\[\w+\]\s*\+\s*"\.js"/;

  // ===== publicPath =====
  private readonly publicPath =
    /(?:__webpack_require__\.\w+|window\.__webpack_public_path__|window\.resourceBaseUrl|[a-z]\.p)\s*=\s*["']([^"']+)["']/;

  // ===== Attempt 1: "prefix" + id + sep + {id:hash}[id] + suffix =====
  private readonly chunkMapPattern =
    /"([^"]*)"\s*\+\s*\w+\s*\+\s*"([^"]*)"\s*\+\s*\(?\{([^}]+)\}\)?\[\w+\]\s*\+\s*"([^"]*)"/;

  // ===== Attempt 2: "prefix" + (({id:name}[e]||e)) + "." + ({id:hash}[e]) + ".js" =====
  private readonly staticChunkPattern =
    /"([^"]+\/)"\s*\+\s*\(\s*\(([^)]+)\)\[\w+\]\s*\|\|\s*\w+\s*\)\s*\+\s*"\."\s*\+\s*\(([^)]+)\)\[\w+\]\s*\+\s*"\.js"/;

  // ===== Attempt 3: "prefix/" + {id:name}[c] + "." + {id:hash}[c] + ".js" =====
  private readonly chunkReturnPattern =
    /"([^"]+\/)"\s*\+\s*\{[^}]+\}\[\w+\]\s*\+\s*"\."\s*\+\s*\{[^}]+\}\[\w+\]\s*\+\s*"\.js"/;

  // ===== Attempt 4: "prefix/" + ({id:name}[e]||e) + "." + {id:hash}[e] + ".js" =====
  private readonly requireUChunkPattern =
    /"([^"]+\/)"\s*\+\s*\(\s*\{([^}]+)\}\s*\[\w+\]\s*\|\|\s*\w+\s*\)\s*\+\s*"\."\s*\+\s*\{([^}]+)\}\s*\[\w+\]\s*\+\s*"\.js"/;

  // ===== Attempt 5: ({id:name}[e]||e) + "." + {id:hash}[e] + (".async")? + ".js" =====
  private readonly federationChunkPattern =
    /\(\s*\{([^}]+)\}\s*\[\w+\]\s*\|\|\s*\w+\s*\)\s*\+\s*"\."\s*\+\s*\{([^}]+)\}\s*\[\w+\]\s*\+\s*"((?:\.async)?\.js)"/;

  // ===== Attempt 6: (id===e?"special":e) + "-" + {id:hash}[e] + ".js" =====
  private readonly ternaryNameMap =
    /\((\d+)===e\?"([^"]+)":e\)\+\s*"([^"]+)"\+\s*\{([^}]+)\}\s*\[\w+\]\+\s*"\.js"/;

  // ===== Attempt 7: arrow-function path prefix =====
  private readonly arrowFnPrefix =
    /\.\w+\s*=\s*\w+\s*=>\s*"([^"]+)"\s*\+\s*\w+\s*\+\s*"-"/;
  private readonly numericHashMap = /(\d+):"([a-f0-9]{6,10})"/g;

  // ===== Attempt 8: generic fallbacks =====
  private readonly pathPrefixPattern =
    /\(\s*\w+\.\w+\s*\|\|\s*""\s*\)\s*\+\s*["']([^"']+\/)["']/;
  private readonly pathPrefixAlt = /\+\s*["'](\/?static\/js\/)["']/;
  private readonly fallbackPrefix = /\+\s*["']([a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/)["']/;
  private readonly chunkHashMap = /"(chunk-[0-9a-f]+)"\s*:\s*"([0-9a-f]+)"/g;
  private readonly chunkNumericHash = /[\{,]\s*(\d+)\s*:\s*["']([a-f0-9]{20,24})["']/g;
  private readonly jsPrefix = /\+\s*["'](\w+\/)["']/;
  private readonly querySuffix = /\.js\?([a-zA-Z0-9_=]+)"/;
  private readonly lType =
    /\.\w+\s*=\s*\w+\s*=>\s*"([^"]+)"\s*\+\s*\w+\s*\+\s*"([^"]+)"\s*\+\s*\{([^}]+)\}\[\w+\]\s*\+\s*"([^"]+)"/;
  private readonly chunkPush = /\.\s*push\s*\(\s*\[\s*\[\s*(\d+)\s*\]/g;
  private readonly chunkSelfReg = /webpackChunk_([a-zA-Z_][a-zA-Z0-9_]*)\s*\.\s*push\s*\(\s*\[\s*\[\s*(\d+)\s*\]/g;
  private readonly chunkHashMapShort = /\{(\d+):"([a-f0-9]{7,40})"\}/g;
  private readonly chunkUrlBuilder =
    /\.\w+\s*=\s*function\s*\(\w+\)\s*\{\s*return\s*\w+\s*\+\s*"\.([[:alnum:]]+)\.js"\s*\}/;
  private readonly chunkLoadCall = /\.\w+\s*\(\s*(\d+)\s*\)/g;
  private readonly chunkLoadStringId = /\.(\w+)\s*\(\s*["'](chunk-[a-z0-9]+)["']\s*\)/g;
  private readonly stringChunkHashMap = /"(chunk-[a-z0-9]+)"\s*:\s*"([a-f0-9]{5,10})"/g;
  private readonly stringKeyHashMap = /"([a-zA-Z][a-zA-Z0-9_~\-]+)":"([a-f0-9]{5,20})"/g;
  private readonly directPath = /(\d+)===e\?"([^"]+\.js)"/g;

  // ===== webpack 4 two-segment fingerprint =====
  private readonly runtimeFingerprintPattern =
    /\+\s*["']\.([a-f0-9]{6,20}\.\d{10,16})\.js["']/;
  private readonly chunkHashMapFingerprint =
    /"(chunk-[0-9a-f]{6,})"\s*:\s*"([a-f0-9]{6,20}\.\d{10,16})"/g;
  private readonly chunkExistenceMap = /"(chunk-[0-9a-f]{6,})"\s*:\s*1\b/g;

  // ===== Cross-file state =====
  /**
   * String chunk-id to hash maps accumulated across files.
   *
   * The first hash wins for a given id: a chunk's JS hash and its CSS hash can
   * appear in the same file; the first is kept because the JS one is the
   * target being looked for.
   */
  private stringChunkHashMaps: Array<Map<string, string>> = [];

  /**
   * The `HASH.TIMESTAMP` pattern, learned from an inline HTML runtime and reused
   * for later JS files that only reference chunk ids.
   */
  private runtimeFingerprint = '';

  precheck(input: AnalyzeInput): boolean {
    if (input.contentType !== 'js') {
      return false;
    }
    const text = input.text ?? new TextDecoder().decode(input.content);
    if (containsAny(text, this.markers)) {
      return true;
    }
    return this.minimalRuntime.test(text);
  }

  analyze(input: AnalyzeInput): PluginResult {
    const builder = new ResultBuilder(input.sourceUrl);
    const content = input.text ?? new TextDecoder('utf-8', { fatal: false }).decode(input.content);

    // publicPath is the base for relative artifact paths.
    const publicPathMatch = this.publicPath.exec(content);
    const publicPath = publicPathMatch?.[1];
    if (publicPath !== undefined && publicPath !== '') {
      builder.addPublicPath(publicPath);
    }

    /** An absolute publicPath lets chunk URLs be queued directly instead of probed. */
    const absolutePublicPath = this.absolutePublicPath(publicPath);

    // Attempts 1-7 each return on success; only attempt 8 falls through.
    if (this.tryChunkMapPattern(content, builder, publicPath)) return builder.build();
    if (this.tryStaticChunkPattern(content, builder)) return builder.build();
    if (this.tryChunkReturnPattern(content, builder, absolutePublicPath)) return builder.build();
    if (this.tryRequireUChunkPattern(content, builder, absolutePublicPath)) return builder.build();
    if (this.tryFederationChunkPattern(content, builder)) return builder.build();
    if (this.tryTernaryNameMap(content, builder)) return builder.build();
    if (this.tryArrowFunctionPrefix(content, builder)) return builder.build();

    this.tryGenericFallbacks(content, builder, input.sourceUrl);
    this.tryRuntimeFingerprint(content, builder, input.sourceUrl);

    return builder.build();
  }

  /** An `http(s)` publicPath, normalised to end in `/`; otherwise `''`. */
  private absolutePublicPath(publicPath: string | undefined): string {
    if (publicPath === undefined) {
      return '';
    }
    if (!publicPath.startsWith('http://') && !publicPath.startsWith('https://')) {
      return '';
    }
    return publicPath.endsWith('/') ? publicPath : `${publicPath}/`;
  }

  // ===== Attempt 1 =====
  private tryChunkMapPattern(
    content: string,
    builder: ResultBuilder,
    publicPath: string | undefined,
  ): boolean {
    const match = this.chunkMapPattern.exec(content);
    if (!match || match.length < 5) {
      return false;
    }

    const prefix = match[1] ?? '';
    // An empty separator means `-` by convention.
    const separator = (match[2] ?? '') === '' ? '-' : match[2]!;
    const hashMapBody = match[3] ?? '';
    const suffix = match[4] ?? '';

    const hashMap = this.extractHashMap(hashMapBody);
    if (hashMap.size === 0) {
      return false;
    }

    // A root-relative publicPath (a module-federation remote's `/remote/`) is
    // prepended so the resulting path resolves into the remote's directory
    // rather than matching the host's identically-named `js/` directory.
    let pathPrefix = '';
    if (publicPath !== undefined && publicPath !== '') {
      const trimmed = publicPath.replace(/\/+$/, '');
      if (trimmed !== '' && trimmed.startsWith('/')) {
        pathPrefix = trimmed;
      }
    }

    for (const [chunkId, hash] of hashMap) {
      builder.addProbe(`${pathPrefix}${prefix}${chunkId}${separator}${hash}${suffix}`);
    }
    return true;
  }

  /** Pull `{id: hash}` entries out of a captured map body. */
  private extractHashMap(mapBody: string): Map<string, string> {
    const map = new Map<string, string>();
    for (const [pattern] of [
      [MAP_NUMERIC_HASH],
      [MAP_QUOTED_KEY_HASH],
      [MAP_IDENT_KEY_HASH],
    ] as const) {
      forEachMatch(pattern, mapBody, (groups) => {
        const id = groups[0];
        const hash = groups[1];
        if (id !== undefined && hash !== undefined && !map.has(id)) {
          map.set(id, hash);
        }
      });
    }
    return map;
  }

  // ===== Attempt 2 =====
  private tryStaticChunkPattern(content: string, builder: ResultBuilder): boolean {
    const match = this.staticChunkPattern.exec(content);
    if (!match || match.length < 4) {
      return false;
    }

    const prefix = match[1] ?? '';
    const nameSource = match[2] ?? '';
    const hashSource = match[3] ?? '';

    const nameMap = new Map<string, string>();
    const hashMap = new Map<string, string>();

    // rsbuild inlines the maps directly in the URL builder.
    if (nameSource.trim().startsWith('{')) {
      this.collectIdValue(nameSource, nameMap);
    }
    if (hashSource.trim().startsWith('{')) {
      forEachMatch(MAP_NUMERIC_HASH, hashSource, (groups) => {
        const id = groups[0];
        const hash = groups[1];
        if (id !== undefined && hash !== undefined) {
          hashMap.set(id, hash);
        }
      });
    }

    // Variable form: the maps are defined elsewhere in the file.
    if (!nameSource.trim().startsWith('{') && !hashSource.trim().startsWith('{')) {
      const nameDef = new RegExp(
        `${escapeRegExp(nameSource.trim())}\\s*=\\s*\\{([^}]+)\\}`,
      );
      const hashDef = new RegExp(
        `${escapeRegExp(hashSource.trim())}\\s*=\\s*\\{([^}]+)\\}`,
      );

      const nameMatch = nameDef.exec(content);
      if (nameMatch?.[1] !== undefined) {
        this.collectIdValue(nameMatch[1], nameMap);
      }
      const hashMatch = hashDef.exec(content);
      if (hashMatch?.[1] !== undefined) {
        this.collectIdValue(hashMatch[1], hashMap);
      }
    }

    // Fewer than three entries means the maps were not found where expected, so
    // fall back to every id-to-hex pair in the file. The length and hex checks
    // are what keep CSS class-name maps from being mistaken for chunk hashes.
    if (hashMap.size < 3) {
      hashMap.clear();
      forEachMatch(ID_VALUE, content, (groups) => {
        const id = groups[0];
        const value = groups[1];
        if (id === undefined || value === undefined) {
          return;
        }
        if (value.length >= 6 && value.length <= 40 && isHex(value)) {
          hashMap.set(id, value);
        }
      });
    }

    for (const [id, hash] of hashMap) {
      const name = nameMap.get(id) ?? id;
      builder.addProbe(`${prefix}${name}.${hash}.js`);
    }
    return true;
  }

  /** Collect numeric-key entries from a map body, keeping the first per key. */
  private collectIdValue(body: string, target: Map<string, string>): void {
    forEachMatch(ID_VALUE, body, (groups) => {
      const id = groups[0];
      const value = groups[1];
      if (id !== undefined && value !== undefined && !target.has(id)) {
        target.set(id, value);
      }
    });
  }

  // ===== Attempt 3 =====
  private tryChunkReturnPattern(
    content: string,
    builder: ResultBuilder,
    absolutePublicPath: string,
  ): boolean {
    const match = this.chunkReturnPattern.exec(content);
    if (!match || match[1] === undefined) {
      return false;
    }
    const prefix = match[1];

    // Split every id-to-value pair into names and hashes by whether the value is hex.
    const nameMap = new Map<string, string>();
    const hashMap = new Map<string, string>();
    forEachMatch(ID_VALUE, content, (groups) => {
      const id = groups[0];
      const value = groups[1];
      if (id === undefined || value === undefined) {
        return;
      }
      if (isHex(value)) {
        hashMap.set(id, value);
      } else {
        nameMap.set(id, value);
      }
    });

    for (const [id, hash] of hashMap) {
      const name = nameMap.get(id) ?? id;
      const chunkPath = `${prefix}${name}.${hash}.js`;
      if (absolutePublicPath !== '') {
        // Queueing the full URL avoids the fragment resolver choosing a
        // different base for a path that is already unambiguous.
        builder.addAbsolute(absolutePublicPath + chunkPath);
      } else {
        builder.addProbe(chunkPath);
      }
    }
    return true;
  }

  // ===== Attempt 4 =====
  private tryRequireUChunkPattern(
    content: string,
    builder: ResultBuilder,
    absolutePublicPath: string,
  ): boolean {
    const match = this.requireUChunkPattern.exec(content);
    if (!match || match.length < 4) {
      return false;
    }

    const prefix = match[1] ?? '';
    const nameMapBody = match[2] ?? '';
    const hashMapBody = match[3] ?? '';

    // Extracted strictly from the captured blocks. Scanning the whole file here
    // would let a later CSS map overwrite a JS hash for the same key — the
    // webpack 4 double-map runtime does exactly that, and honouring it turns
    // every chunk URL into a 404.
    const nameMap = this.extractNameMapStrict(nameMapBody);
    const hashMap = this.extractHashMapStrict(hashMapBody);

    const add = (chunkPath: string): void => {
      if (absolutePublicPath !== '') {
        builder.addAbsolute(absolutePublicPath + chunkPath);
      } else {
        builder.addProbe(chunkPath);
      }
    };

    for (const [id, hash] of hashMap) {
      add(`${prefix}${nameMap.get(id) ?? id}.${hash}.js`);
    }

    // When no numeric-key hashes were found, the ids are strings
    // (`chunk-xxx`, `noprefetch-xxx`, `vendors~xxx`) rather than numbers.
    if (hashMap.size === 0) {
      forEachMatch(this.stringKeyHashMap, content, (groups) => {
        const chunkId = groups[0];
        const hash = groups[1];
        if (chunkId === undefined || hash === undefined) {
          return;
        }
        if (hashMap.has(chunkId)) {
          return;
        }
        hashMap.set(chunkId, hash);
        add(`${prefix}${nameMap.get(chunkId) ?? chunkId}.${hash}.js`);
      });
    }

    // A `740===e?"path.js"` special case maps one id to a fully-formed path.
    forEachMatch(this.directPath, content, (groups) => {
      const path = groups[1];
      if (path !== undefined) {
        builder.addProbe(path);
      }
    });

    return true;
  }

  private extractNameMapStrict(body: string): Map<string, string> {
    const map = new Map<string, string>();
    for (const pattern of [ID_VALUE, FC_NUM_NAME, MAP_QUOTED_KEY_VALUE, MAP_IDENT_KEY_VALUE]) {
      forEachMatch(pattern, body, (groups) => {
        const id = groups[0];
        const value = groups[1];
        if (id !== undefined && value !== undefined) {
          map.set(id, value);
        }
      });
    }
    return map;
  }

  private extractHashMapStrict(body: string): Map<string, string> {
    const map = new Map<string, string>();
    for (const pattern of [MAP_NUMERIC_HASH, FC_NUM_HASH, MAP_QUOTED_KEY_HASH, MAP_IDENT_KEY_HASH]) {
      forEachMatch(pattern, body, (groups) => {
        const id = groups[0];
        const value = groups[1];
        if (id !== undefined && value !== undefined) {
          map.set(id, value);
        }
      });
    }
    return map;
  }

  // ===== Attempt 5 =====
  private tryFederationChunkPattern(content: string, builder: ResultBuilder): boolean {
    const match = this.federationChunkPattern.exec(content);
    if (!match || match.length < 4) {
      return false;
    }

    const nameMapBody = match[1] ?? '';
    const hashMapBody = match[2] ?? '';
    const suffix = match[3] ?? '';

    // The prefix sits before the matched expression as a separate literal.
    let prefix = '';
    const matchIndex = content.indexOf(match[0]);
    if (matchIndex > 0) {
      const before = content.slice(0, matchIndex);
      const prefixPattern = /"([^"]+\/)"\s*\+\s*$/g;
      const candidates = [...before.matchAll(new RegExp(prefixPattern.source, 'g'))];
      const last = candidates[candidates.length - 1];
      if (last?.[1] !== undefined) {
        prefix = last[1];
      }
    }
    if (prefix === '') {
      // `.async.js` chunks live at the site root (umi's layout); anything else
      // defaults to the async chunk directory.
      prefix = suffix.endsWith('.async.js') ? '' : 'static/js/async/';
    }

    const nameMap = this.extractNameMapStrict(nameMapBody);
    const hashMap = this.extractHashMapStrict(hashMapBody);

    for (const [id, hash] of hashMap) {
      const name = nameMap.get(id) ?? id;
      builder.addProbe(`${prefix}${name}.${hash}${suffix}`);
    }
    return true;
  }

  // ===== Attempt 6 =====
  private tryTernaryNameMap(content: string, builder: ResultBuilder): boolean {
    const match = this.ternaryNameMap.exec(content);
    if (!match || match.length < 5) {
      return false;
    }

    const specialId = match[1] ?? '';
    const specialName = match[2] ?? '';
    const separator = match[3] ?? '';
    const mapBody = match[4] ?? '';

    forEachMatch(MAP_NUMERIC_HASH, mapBody, (groups) => {
      const id = groups[0];
      const hash = groups[1];
      if (id === undefined || hash === undefined) {
        return;
      }
      const name = id === specialId ? specialName : id;
      builder.addProbe(`${name}${separator}${hash}.js`);
    });
    return true;
  }

  // ===== Attempt 7 =====
  private tryArrowFunctionPrefix(content: string, builder: ResultBuilder): boolean {
    const match = this.arrowFnPrefix.exec(content);
    const prefix = match?.[1];
    if (prefix === undefined || prefix === '') {
      return false;
    }

    forEachMatch(this.numericHashMap, content, (groups) => {
      const chunkId = groups[0];
      const hash = groups[1];
      if (chunkId !== undefined && hash !== undefined) {
        builder.addProbe(`${prefix}${chunkId}-${hash}.js`);
      }
    });
    return true;
  }

  // ===== Attempt 8: generic fallbacks =====

  /**
   * The catch-all pass.
   *
   * Unlike the earlier attempts this one does not return early: several
   * independent patterns each contribute probe targets, and missing any of them
   * loses chunks.
   */
  private tryGenericFallbacks(
    content: string,
    builder: ResultBuilder,
    sourceUrl: string,
  ): void {
    const pathPrefix = this.detectPathPrefix(content);

    // `chunk-<hash>` ids with their hash in a sibling map.
    forEachMatch(this.chunkHashMap, content, (groups) => {
      const chunkId = groups[0];
      const hash = groups[1];
      if (chunkId !== undefined && hash !== undefined) {
        builder.addProbe(`${pathPrefix}${chunkId}.${hash}.js`);
      }
    });

    // Numeric ids with a long content hash, optionally named.
    const nameMap = new Map<string, string>();
    forEachMatch(ID_VALUE, content, (groups) => {
      const id = groups[0];
      const value = groups[1];
      if (id !== undefined && value !== undefined && !isHex(value)) {
        nameMap.set(id, value);
      }
    });

    const jsPrefixMatch = this.jsPrefix.exec(content);
    const jsPrefix = jsPrefixMatch?.[1] ?? '';
    const queryMatch = this.querySuffix.exec(content);
    const querySuffix = queryMatch?.[1] ?? '';

    forEachMatch(this.chunkNumericHash, content, (groups) => {
      const chunkId = groups[0];
      const hash = groups[1];
      if (chunkId === undefined || hash === undefined) {
        return;
      }
      // `rspack/webpack` numeric-id format is `<name>.chunk.<hash>.js`.
      const name = nameMap.get(chunkId) ?? chunkId;
      let fragment = `${name}.chunk.${hash}.js`;
      if (jsPrefix !== '') {
        fragment = jsPrefix + fragment;
      }
      if (querySuffix !== '') {
        fragment = `${fragment}?${querySuffix}`;
      }
      builder.addProbe(fragment);
    });

    // The `lType` shape resolves to a wildcard: the hash lives in the map, which
    // this pattern cannot reach, so only the prefix is usable.
    forEachMatch(this.lType, content, (groups) => {
      const prefix = groups[0];
      if (prefix !== undefined) {
        builder.addProbe(`${prefix}_placeholder_.js`);
      }
    });

    forEachMatch(this.chunkPush, content, (groups) => {
      const chunkId = groups[0];
      if (chunkId !== undefined) {
        builder.addProbe(`${chunkId}-*.js`);
      }
    });

    // `webpackChunk_x.push([[id], {...}])` self-registration, with a sibling hash map.
    const webpackChunkNames = new Set<string>();
    forEachMatch(this.chunkSelfReg, content, (groups) => {
      const name = groups[0];
      if (name !== undefined) {
        webpackChunkNames.add(name);
      }
    });

    if (webpackChunkNames.size > 0) {
      const chunkHashMap = new Map<string, string>();
      forEachMatch(this.chunkHashMapShort, content, (groups) => {
        const chunkId = groups[0];
        const hash = groups[1];
        if (chunkId !== undefined && hash !== undefined) {
          chunkHashMap.set(chunkId, hash);
        }
      });
      for (const [chunkId, hash] of chunkHashMap) {
        builder.addProbe(`${chunkId}.${hash}.js`);
      }
    }

    // A chunk URL builder that hard-codes the hash: `u.u=function(t){return t+".95f73b75.js"}`.
    const builderMatch = this.chunkUrlBuilder.exec(content);
    const chunkHash = builderMatch?.[1] ?? '';

    // `.e(id)` load calls. A wildcard is only emitted when the file is confirmed
    // to be a webpack chunk runtime, otherwise ordinary calls like `.charAt(0)`
    // would produce phantom probes.
    const hasChunkLoadContext = chunkHash !== '' || webpackChunkNames.size > 0;
    forEachMatch(this.chunkLoadCall, content, (groups) => {
      const chunkId = groups[0];
      if (chunkId === undefined) {
        return;
      }
      if (chunkHash !== '') {
        builder.addProbe(`${chunkId}.${chunkHash}.js`);
      } else if (hasChunkLoadContext) {
        builder.addProbe(`${chunkId}-*.js`);
      }
    });

    this.collectStringChunkHashes(content, builder, pathPrefix);

    void sourceUrl;
  }

  /** Choose the artifact path prefix from the shape of the runtime. */
  private detectPathPrefix(content: string): string {
    // Preferred: the runtime's own path expression, e.g. `(x.p||"")+"static/js/"`.
    const primary = this.pathPrefixPattern.exec(content);
    if (primary?.[1] !== undefined && primary[1] !== '') {
      return primary[1];
    }

    // RuoYi-Vue style: `x.p+"static/js/"`.
    const alt = this.pathPrefixAlt.exec(content);
    if (alt?.[1] !== undefined && alt[1] !== '') {
      return alt[1];
    }

    // Last resort: any `+ "a/b/"` literal. A fresh regex per scan is required
    // because `lastIndex` persists on a `/g` pattern across calls, which would
    // make a second invocation on a different input skip matches.
    let candidate = '';
    forEachMatch(this.fallbackPrefix, content, (groups) => {
      if (candidate !== '') {
        return;
      }
      const value = groups[0];
      // `use ...` is CSS injected through a style loader, never a path prefix.
      if (value !== undefined && !value.startsWith('use ')) {
        candidate = value;
      }
    });

    return candidate;
  }

  /**
   * Accumulate string chunk-id hashes and emit probes for them.
   *
   * `{"chunk-2d0b2b28":"6267aaf1"}` is the standard webpack runtime shape, and
   * both halves may live in different files, so the map is carried on the
   * instance. When no map is available the `.e("chunk-xxx")` calls are used
   * instead, which yields a wildcard or, for an already-hashed id, a direct path.
   */
  private collectStringChunkHashes(
    content: string,
    builder: ResultBuilder,
    pathPrefix: string,
  ): void {
    const merged = new Map<string, string>();
    for (const stored of this.stringChunkHashMaps) {
      for (const [k, v] of stored) {
        merged.set(k, v);
      }
    }

    // The first hash for an id wins: JS and CSS hashes both appear for the same
    // id, and the JS one is the target.
    forEachMatch(this.stringChunkHashMap, content, (groups) => {
      const chunkId = groups[0];
      const hash = groups[1];
      if (chunkId === undefined || hash === undefined) {
        return;
      }
      if (!merged.has(chunkId)) {
        merged.set(chunkId, hash);
      }
    });

    if (merged.size > 0) {
      this.stringChunkHashMaps.push(new Map(merged));
    }

    if (merged.size > 0) {
      const generated = new Set<string>();
      for (const [chunkId, hash] of merged) {
        const fragment = `${pathPrefix}${chunkId}.${hash}.js`;
        if (generated.has(fragment)) {
          continue;
        }
        generated.add(fragment);
        builder.addProbe(fragment);
      }
      return;
    }

    // No hash map: fall back to the load call sites.
    const seen = new Set<string>();
    forEachMatch(this.chunkLoadStringId, content, (groups) => {
      const chunkId = groups[1];
      if (chunkId === undefined || seen.has(chunkId)) {
        return;
      }
      seen.add(chunkId);

      // An already-hashed id is a complete filename; anything else needs a hash
      // and can only be expressed as a wildcard.
      const fragment = isLikelyChunkHash(chunkId)
        ? `${pathPrefix}${chunkId}.js`
        : `${pathPrefix}${chunkId}-*.js`;
      builder.addProbe(fragment);
    });
  }

  /**
   * The webpack 4 `HASH.TIMESTAMP` chunk URL shape.
   *
   * Here the chunk filename is fully determined — `<chunk-id>.<HASH>.<TIMESTAMP>.js`
   * — so an absolute URL is constructed directly. That is deliberate and
   * important: the pipeline's fragment resolver rejects `chunk-*.js` wildcards
   * (there is no hash to fill in), but a fully-formed absolute URL bypasses that
   * check entirely.
   *
   * The fingerprint is remembered on the instance because it is discovered in an
   * inline HTML runtime, while the chunk-id references appear later in `app.js`.
   */
  private tryRuntimeFingerprint(
    content: string,
    builder: ResultBuilder,
    sourceUrl: string,
  ): void {
    let fingerprint = this.runtimeFingerprint;
    if (fingerprint === '') {
      const match = this.runtimeFingerprintPattern.exec(content);
      if (match?.[1] !== undefined) {
        fingerprint = match[1];
        this.runtimeFingerprint = fingerprint;
      }
    }
    if (fingerprint === '') {
      return;
    }

    const buildChunkUrl = (chunkId: string): string => {
      const fileName = `${chunkId}.${fingerprint}.js`;
      try {
        const parsed = new URL(sourceUrl);
        if (parsed.protocol !== '' && parsed.host !== '') {
          const lastSlash = parsed.pathname.lastIndexOf('/');
          const baseDir =
            lastSlash >= 0 ? parsed.pathname.slice(0, lastSlash + 1) : parsed.pathname;
          parsed.pathname = baseDir + fileName;
          return parsed.toString();
        }
      } catch {
        // Fall through to a relative path.
      }
      return fileName;
    };

    const seen = new Set<string>();
    const add = (chunkId: string): void => {
      if (seen.has(chunkId)) {
        return;
      }
      seen.add(chunkId);
      builder.addProbe(buildChunkUrl(chunkId));
    };

    // Three sources, most precise first.
    forEachMatch(this.chunkHashMapFingerprint, content, (groups) => {
      const chunkId = groups[0];
      if (chunkId !== undefined) {
        add(chunkId);
      }
    });
    forEachMatch(this.chunkExistenceMap, content, (groups) => {
      const chunkId = groups[0];
      if (chunkId !== undefined) {
        add(chunkId);
      }
    });
    forEachMatch(this.chunkLoadStringId, content, (groups) => {
      const chunkId = groups[1];
      if (chunkId !== undefined) {
        add(chunkId);
      }
    });
  }
}

/** Escape a string for literal use inside a `RegExp`. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export { findAllFirst, containsAny };