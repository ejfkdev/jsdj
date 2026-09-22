/**
 * Source map (v3) parsing and original-source restoration.
 *
 * Restoration uses a two-tier strategy:
 *
 * 1. **Preferred** — read `sourcesContent`, which holds the original plaintext
 *    sources captured at build time. Fast and faithful, but only present when
 *    the bundler kept the field.
 * 2. **Fallback** — when `sourcesContent` is missing or empty for some entries,
 *    decode `mappings` (base64 VLQ) and splice the minified file back together
 *    per-source. Mappings carry only positional information, so this cannot
 *    reproduce the original text; the output is labelled as incomplete.
 */

import { parseMappings, type Mapping } from './vlq.js';
import { normalizeSourcePath } from './path.js';

/** The JSON shape of a source map v3 document. */
export interface SourceMap {
  /** Spec version; 3 is the de-facto standard. */
  version: number;
  /** Name of the generated file this map belongs to. */
  file?: string;
  /** Prefix applied to entries in `sources`. */
  sourceRoot?: string;
  /** Original source paths. */
  sources: string[];
  /**
   * Original source contents, positionally matching `sources`. May be absent,
   * or contain null/empty entries for individual sources.
   */
  sourcesContent?: (string | null)[];
  /** Identifier names referenced by `mappings`. */
  names?: string[];
  /** Base64 VLQ position mapping string. */
  mappings: string;
}

/** How a restored file's content was obtained. */
export type RestoreMode = 'none' | 'sourcesContent' | 'mappings';

/** One restored source file. */
export interface SourceFile {
  /** Normalised relative path, e.g. `src/App.jsx`. */
  path: string;
  /** File content. */
  content: string;
  /** How the content was produced. */
  mode: RestoreMode;
}

/** Raised when source map input cannot be parsed. */
export class SourceMapParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceMapParseError';
  }
}

/**
 * Parse source map JSON.
 *
 * Errors on empty input, invalid JSON, or a map with an empty `sources` array.
 * An unexpected `version` is tolerated rather than rejected, since real-world
 * maps occasionally drift from the spec.
 */
export function parse(content: Uint8Array | string): SourceMap {
  const text =
    typeof content === 'string' ? content : new TextDecoder().decode(content);

  if (text.length === 0) {
    throw new SourceMapParseError('empty source map content');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new SourceMapParseError(
      `parse source map json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new SourceMapParseError('source map is not a JSON object');
  }

  const raw = parsed as Record<string, unknown>;
  const sources = Array.isArray(raw['sources']) ? raw['sources'] : [];
  if (sources.length === 0) {
    throw new SourceMapParseError('source map has no sources');
  }

  const sourcesContentRaw = raw['sourcesContent'];
  const sourcesContent = Array.isArray(sourcesContentRaw)
    ? (sourcesContentRaw as (string | null)[])
    : undefined;

  return {
    version: typeof raw['version'] === 'number' ? raw['version'] : 0,
    file: typeof raw['file'] === 'string' ? raw['file'] : undefined,
    sourceRoot:
      typeof raw['sourceRoot'] === 'string' ? raw['sourceRoot'] : undefined,
    sources: sources.map((s) => (typeof s === 'string' ? s : '')),
    sourcesContent,
    names: Array.isArray(raw['names'])
      ? (raw['names'] as unknown[]).map((n) => (typeof n === 'string' ? n : ''))
      : undefined,
    mappings: typeof raw['mappings'] === 'string' ? raw['mappings'] : '',
  };
}

/**
 * Whether the map carries at least one non-empty `sourcesContent` entry.
 *
 * A `true` here means the preferred restoration path can produce output, though
 * individual sources may still fall back to mappings.
 */
export function hasSourcesContent(sm: SourceMap): boolean {
  if (!sm.sourcesContent) {
    return false;
  }
  for (const c of sm.sourcesContent) {
    if (c !== null && c !== undefined && c !== '') {
      return true;
    }
  }
  return false;
}

/**
 * Reconstruct the code belonging to one source index by walking the minified
 * file according to the mappings.
 *
 * This is a best-effort fallback. Mappings describe where generated code came
 * from; they do not contain the original text, so the result is the minified
 * fragments that map to this source concatenated in generated-code order.
 * Variable names, comments and all other compression losses are unrecoverable.
 *
 * Returns `''` when no mapping references the requested source.
 */
export function reconstructFromMappings(
  mappings: Mapping[],
  minifiedContent: string,
  sourceIndex: number,
): string {
  if (mappings.length === 0 || minifiedContent.length === 0) {
    return '';
  }

  const relevant = mappings.filter((m) => m.sourceIndex === sourceIndex);
  if (relevant.length === 0) {
    return '';
  }

  const lines = minifiedContent.split('\n');

  let out = '';
  let prevGenLine = -1;
  let prevGenCol = 0;

  for (const m of relevant) {
    if (m.generatedLine < 0 || m.generatedLine >= lines.length) {
      continue;
    }
    const line = lines[m.generatedLine]!;

    if (m.generatedLine === prevGenLine) {
      // Same generated line: take the span between the previous column and
      // this one.
      const start = Math.max(prevGenCol, 0);
      const end = Math.min(m.generatedColumn, line.length);
      if (end > start) {
        out += line.slice(start, end);
      }
    } else {
      // New generated line: flush the tail of the previous line, emit any
      // lines we skipped over wholesale, then take this line up to the column.
      if (prevGenLine >= 0 && prevGenLine < lines.length) {
        const prevLine = lines[prevGenLine]!;
        if (prevGenCol < prevLine.length) {
          out += prevLine.slice(prevGenCol);
        }
        out += '\n';
      }
      for (let l = prevGenLine + 1; l < m.generatedLine; l++) {
        if (l < lines.length) {
          out += lines[l]!;
          out += '\n';
        }
      }
      const end = Math.min(m.generatedColumn, line.length);
      if (end > 0) {
        out += line.slice(0, end);
      }
    }

    prevGenLine = m.generatedLine;
    prevGenCol = m.generatedColumn;
  }

  // Flush whatever remains on the final line.
  if (prevGenLine >= 0 && prevGenLine < lines.length) {
    const line = lines[prevGenLine]!;
    if (prevGenCol < line.length) {
      out += line.slice(prevGenCol);
    }
  }

  return out;
}

/** Header prepended to mappings-reconstructed files so they are not mistaken for original source. */
function mappingsHeader(originalPath: string): string {
  return (
    '/* [jsdj] Restored from source map mappings — not complete source code.\n' +
    `   Original path: ${originalPath}\n` +
    '   This file was reassembled from the minified JS using source map\n' +
    '   positions and may be incomplete. */\n'
  );
}

/**
 * Restore the original source files described by a source map.
 *
 * `sourcesContent` is used where present. For entries without it, if
 * `minifiedContent` is supplied the mappings are decoded and used to rebuild
 * fragments. Sources for which neither route yields content are skipped.
 *
 * Pass `minifiedContent` as `undefined` when `sourcesContent` is known to be
 * complete — that avoids the decoding work entirely.
 */
export function restoreFiles(
  sm: SourceMap | null | undefined,
  minifiedContent?: Uint8Array | string | null | undefined,
): SourceFile[] {
  if (!sm) {
    throw new SourceMapParseError('nil source map');
  }
  if (sm.sources.length === 0) {
    throw new SourceMapParseError('no sources to restore');
  }

  const minified =
    minifiedContent === null || minifiedContent === undefined
      ? ''
      : typeof minifiedContent === 'string'
        ? minifiedContent
        : new TextDecoder().decode(minifiedContent);

  const result: SourceFile[] = [];

  // Decoded lazily: only needed once we hit a source with no sourcesContent.
  let mappings: Mapping[] | null = null;

  for (let i = 0; i < sm.sources.length; i++) {
    const src = sm.sources[i]!;
    let content = '';
    let mode: RestoreMode = 'none';

    const entry = sm.sourcesContent?.[i];
    if (entry !== null && entry !== undefined && entry !== '') {
      content = entry;
      mode = 'sourcesContent';
    }

    if (mode === 'none' && minified.length > 0) {
      if (mappings === null) {
        mappings = parseMappings(sm.mappings);
      }
      const reconstructed = reconstructFromMappings(mappings, minified, i);
      if (reconstructed !== '') {
        content = reconstructed;
        mode = 'mappings';
      }
    }

    if (mode === 'none') {
      continue;
    }

    let normalizedPath = normalizeSourcePath(src, sm.sourceRoot ?? '');
    if (normalizedPath === '') {
      normalizedPath = `unnamed_${i}.js`;
    }

    result.push({
      path: normalizedPath,
      content: mode === 'mappings' ? mappingsHeader(src) + content : content,
      mode,
    });
  }

  return result;
}