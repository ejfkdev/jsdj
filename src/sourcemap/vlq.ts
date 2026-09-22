/**
 * Base64 VLQ decoding for source map `mappings` strings.
 *
 * The character table, the 5-bit grouping and the sign-bit convention all
 * follow the source map v3 spec:
 * https://sourcemaps.info/spec.html#h.qz3o9nc69um5
 */

/** Character table used by base64 VLQ encoding (source map standard). */
const BASE64_VLQ_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Reverse lookup: character code -> 6-bit value, or -1 when the character is
 * not part of the VLQ alphabet. 128 entries covers the whole ASCII range, which
 * is what the Go implementation indexed into.
 */
const BASE64_VLQ_DECODE: Int8Array = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < BASE64_VLQ_CHARS.length; i++) {
    table[BASE64_VLQ_CHARS.charCodeAt(i)] = i;
  }
  return table;
})();

/** 5 bits of payload per continuation group. */
const VLQ_BASE_SHIFT = 5;
/** Value contributed by a set continuation bit (0b100000). */
const VLQ_CONTINUATION_BIT = 1 << VLQ_BASE_SHIFT; // 32
/** Mask for the 5 payload bits (0b011111). */
const VLQ_BASE_MASK = VLQ_CONTINUATION_BIT - 1; // 31
/** The lowest bit of the decoded payload is the sign. */
const VLQ_SIGN_BIT = 1;

/** A single mapping entry from a decoded `mappings` string. */
export interface Mapping {
  /** Line in the generated (minified) file. 0-based. */
  generatedLine: number;
  /** Column in the generated file. 0-based. */
  generatedColumn: number;
  /** Index into the `sources` array, or -1 when absent. */
  sourceIndex: number;
  /** Line in the original source. 0-based, or -1 when absent. */
  sourceLine: number;
  /** Column in the original source. 0-based, or -1 when absent. */
  sourceColumn: number;
  /** Index into the `names` array, or -1 when absent. */
  nameIndex: number;
}

/** Result of decoding one VLQ segment. */
export interface VlqDecodeResult {
  value: number;
  next: number;
  ok: boolean;
}

/**
 * Decode a single VLQ segment starting at `start`.
 *
 * Returns `ok: false` when an invalid character is hit or the segment runs off
 * the end while a continuation bit is still set — matching the Go original,
 * where `next` then points at the offending position so callers can stop.
 */
export function decodeVLQSegment(
  s: string,
  start: number,
): VlqDecodeResult {
  let result = 0;
  let shift = 0;

  for (let i = start; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= BASE64_VLQ_DECODE.length) {
      return { value: 0, next: i, ok: false };
    }
    const digit = BASE64_VLQ_DECODE[code]!;
    if (digit < 0) {
      return { value: 0, next: i, ok: false };
    }

    // The 6th bit signals another group follows; the low 5 bits are payload.
    const continuation = (digit >> VLQ_BASE_SHIFT) & 1;
    const dataBits = digit & VLQ_BASE_MASK;
    result |= dataBits << shift;
    shift += VLQ_BASE_SHIFT;

    if (continuation === 0) {
      const negative = (result & VLQ_SIGN_BIT) !== 0;
      let value = result >> 1;
      if (negative) {
        value = -value;
      }
      return { value, next: i + 1, ok: true };
    }
  }

  return { value: 0, next: start, ok: false };
}

/** Split on `;` preserving empty entries so line numbers stay aligned. */
function splitBySemicolon(s: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ';') {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

/** Split on `,` dropping empty entries. */
function splitByComma(s: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ',') {
      if (i > start) {
        out.push(s.slice(start, i));
      }
      start = i + 1;
    }
  }
  if (start < s.length) {
    out.push(s.slice(start));
  }
  return out;
}

/**
 * Parse a source map `mappings` string into mapping entries.
 *
 * Lines are separated by `;`, segments within a line by `,`. A segment carries
 * 1, 4 or 5 VLQ values:
 *
 * - 1 value: generatedColumn only (reuses the previous source)
 * - 4 values: generatedColumn, sourceIndex, sourceLine, sourceColumn
 * - 5 values: the above plus nameIndex
 *
 * Every value except generatedColumn is a delta from the previous segment, and
 * those deltas carry across line boundaries. generatedColumn resets to 0 at the
 * start of each line.
 */
export function parseMappings(mappings: string): Mapping[] {
  if (mappings === '') {
    return [];
  }

  const result: Mapping[] = [];

  // Deltas that persist across lines.
  let genCol = 0;
  let srcIdx = 0;
  let srcLine = 0;
  let srcCol = 0;
  let nameIdx = 0;

  const lines = splitBySemicolon(mappings);
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!;
    genCol = 0;
    if (line === '') {
      continue;
    }

    for (const seg of splitByComma(line)) {
      if (seg === '') {
        continue;
      }

      let pos = 0;

      let decoded = decodeVLQSegment(seg, pos);
      if (!decoded.ok) {
        break;
      }
      pos = decoded.next;
      genCol += decoded.value;

      const mapping: Mapping = {
        generatedLine: lineIdx,
        generatedColumn: genCol,
        sourceIndex: -1,
        sourceLine: -1,
        sourceColumn: -1,
        nameIndex: -1,
      };

      if (pos < seg.length) {
        decoded = decodeVLQSegment(seg, pos);
        if (!decoded.ok) {
          break;
        }
        pos = decoded.next;
        srcIdx += decoded.value;
        mapping.sourceIndex = srcIdx;

        decoded = decodeVLQSegment(seg, pos);
        if (!decoded.ok) {
          break;
        }
        pos = decoded.next;
        srcLine += decoded.value;
        mapping.sourceLine = srcLine;

        decoded = decodeVLQSegment(seg, pos);
        if (!decoded.ok) {
          break;
        }
        pos = decoded.next;
        srcCol += decoded.value;
        mapping.sourceColumn = srcCol;

        if (pos < seg.length) {
          decoded = decodeVLQSegment(seg, pos);
          if (!decoded.ok) {
            break;
          }
          pos = decoded.next;
          nameIdx += decoded.value;
          mapping.nameIndex = nameIdx;
        }
      }

      result.push(mapping);
    }
  }

  return result;
}