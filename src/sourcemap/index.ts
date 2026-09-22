/**
 * Source map (v3) parsing and original-source restoration.
 *
 * This module is the entry point for everything under `src/sourcemap/`. It has
 * no Node-specific dependencies, so it works unchanged in browsers.
 */

export {
  parse,
  hasSourcesContent,
  restoreFiles,
  reconstructFromMappings,
  SourceMapParseError,
  type SourceMap,
  type SourceFile,
  type RestoreMode,
} from './sourcemap.js';

export {
  parseMappings,
  decodeVLQSegment,
  type Mapping,
  type VlqDecodeResult,
} from './vlq.js';

export {
  normalizeSourcePath,
  sanitizePathSegments,
  safeFilePath,
  MAX_SOURCE_PATH_DEPTH,
  MAX_SOURCE_PATH_LEN,
} from './path.js';