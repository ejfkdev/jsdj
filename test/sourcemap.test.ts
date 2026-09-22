/**
 * Source map parsing and restoration.
 *
 * These cases are the acceptance criteria for the TypeScript port: the same
 * inputs must produce the same outputs as the Go implementation.
 */

import { describe, expect, test } from 'bun:test';

import {
  decodeVLQSegment,
  hasSourcesContent,
  normalizeSourcePath,
  parse,
  parseMappings,
  reconstructFromMappings,
  restoreFiles,
  safeFilePath,
  MAX_SOURCE_PATH_DEPTH,
  MAX_SOURCE_PATH_LEN,
  type SourceMap,
} from '../src/sourcemap/index.js';

// ===== VLQ decoding =====

describe('decodeVLQSegment', () => {
  // Standard base64 VLQ vectors. For a single character the decoded value is
  // the encoding value with the lowest bit as sign:
  //   A=0 -> 0, C=2 -> 1, D=3 -> -1, E=4 -> 2, F=5 -> -2
  //   G=6 -> 3, H=7 -> -3, Y=24 -> 12, Z=25 -> -12
  const cases: [string, number][] = [
    ['A', 0],
    ['C', 1],
    ['D', -1],
    ['E', 2],
    ['F', -2],
    ['G', 3],
    ['H', -3],
    ['Y', 12],
    ['Z', -12],
    ['gB', 16],
    ['hB', -16],
  ];

  for (const [input, want] of cases) {
    test(`${input} -> ${want}`, () => {
      const result = decodeVLQSegment(input, 0);
      expect(result.ok).toBe(true);
      expect(result.value).toBe(want);
      expect(result.next).toBe(input.length);
    });
  }

  test('multiple segments in one string', () => {
    const s = 'AAAA';
    let pos = 0;
    for (let i = 0; i < 4; i++) {
      const result = decodeVLQSegment(s, pos);
      expect(result.ok).toBe(true);
      expect(result.value).toBe(0);
      pos = result.next;
    }
    expect(pos).toBe(s.length);
  });

  test('invalid character', () => {
    expect(decodeVLQSegment('!', 0).ok).toBe(false);
  });
});

// ===== parseMappings =====

describe('parseMappings', () => {
  test('empty input yields no mappings', () => {
    expect(parseMappings('')).toEqual([]);
  });

  test('single full segment', () => {
    const mappings = parseMappings('AAAA');
    expect(mappings).toHaveLength(1);
    const m = mappings[0]!;
    expect(m.generatedLine).toBe(0);
    expect(m.generatedColumn).toBe(0);
    expect(m.sourceIndex).toBe(0);
  });

  test('two segments advance generatedColumn', () => {
    const mappings = parseMappings('AAAA,SAASA');
    expect(mappings).toHaveLength(2);
    expect(mappings[0]!.generatedColumn).toBe(0);
    expect(mappings[0]!.sourceIndex).toBe(0);
    expect(mappings[1]!.generatedColumn).toBe(9);
  });

  test('generatedColumn resets per line', () => {
    const mappings = parseMappings('AAAA;AAAA');
    expect(mappings).toHaveLength(2);
    expect(mappings[0]!.generatedLine).toBe(0);
    expect(mappings[1]!.generatedLine).toBe(1);
    expect(mappings[1]!.generatedColumn).toBe(0);
  });

  test('segment without name index leaves nameIndex at -1', () => {
    const mappings = parseMappings('AAAA,EAAE');
    expect(mappings).toHaveLength(2);
    const m = mappings[1]!;
    expect(m.generatedColumn).toBe(2);
    expect(m.sourceColumn).toBe(2);
    expect(m.nameIndex).toBe(-1);
  });
});

// ===== normalizeSourcePath =====

describe('normalizeSourcePath', () => {
  const cases: [string, string, string, string][] = [
    ['webpack prefix', 'webpack:///./src/App.jsx', '', 'src/App.jsx'],
    [
      'webpack-internal prefix',
      'webpack-internal:///./node_modules/foo.js',
      '',
      'node_modules/foo.js',
    ],
    ['relative path', './src/utils.js', '', 'src/utils.js'],
    ['absolute path', '/static/js/app.js', '', 'static/js/app.js'],
    ['simple filename', 'index.js', '', 'index.js'],
    [
      'parent traversal consumed at root',
      '../../etc/passwd',
      '',
      'etc/passwd',
    ],
    [
      'vite relative path with ../',
      '../../../../node_modules/foo/bar.js',
      '',
      'node_modules/foo/bar.js',
    ],
    ['relative ../ within path', 'src/a/../b.js', '', 'src/b.js'],
    ['dot segments', './src/./utils/./a.js', '', 'src/utils/a.js'],
    [
      'with sourceRoot',
      'App.jsx',
      'webpack:///./src',
      'src/App.jsx',
    ],
    ['empty source', '', '', ''],
    ['backslash normalized', 'src\\utils\\a.js', '', 'src/utils/a.js'],
  ];

  for (const [name, source, sourceRoot, want] of cases) {
    test(name, () => {
      expect(normalizeSourcePath(source, sourceRoot)).toBe(want);
    });
  }

  test('never produces a .. segment', () => {
    const evil = [
      '../../../etc/passwd',
      './..//etc',
      'a/../../b',
      '../foo',
      'foo/../../bar',
    ];
    for (const s of evil) {
      const got = normalizeSourcePath(s, '');
      expect(got.split('/')).not.toContain('..');
    }
  });
});

// ===== parse =====

describe('parse', () => {
  test('valid map', () => {
    const content = `{
      "version": 3,
      "sources": ["webpack:///./src/index.js"],
      "sourcesContent": ["console.log('hello');\\n"],
      "mappings": "AAAA",
      "names": []
    }`;
    const sm = parse(content);
    expect(sm.version).toBe(3);
    expect(sm.sources).toHaveLength(1);
    expect(hasSourcesContent(sm)).toBe(true);
  });

  test('empty input throws', () => {
    expect(() => parse('')).toThrow();
  });

  test('map with no sources throws', () => {
    expect(() => parse('{"version":3,"sources":[],"mappings":""}')).toThrow();
  });
});

// ===== restoreFiles =====

describe('restoreFiles', () => {
  test('restores from sourcesContent', () => {
    const sm: SourceMap = {
      version: 3,
      sources: ['webpack:///./src/index.js', 'webpack:///./src/utils.js'],
      sourcesContent: ["console.log('index');\n", 'export const x = 1;\n'],
      mappings: 'AAAA',
    };

    const files = restoreFiles(sm);
    expect(files).toHaveLength(2);
    expect(files[0]!.path).toBe('src/index.js');
    expect(files[0]!.mode).toBe('sourcesContent');
    expect(files[0]!.content).toBe("console.log('index');\n");
  });

  test('skips empty sourcesContent entries when no minified content given', () => {
    const sm: SourceMap = {
      version: 3,
      sources: ['src/a.js', 'src/b.js'],
      sourcesContent: ['content a', ''],
      mappings: 'AAAA',
    };
    const files = restoreFiles(sm);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe('src/a.js');
  });

  test('falls back to mappings when sourcesContent is empty', () => {
    const minified = 'var x = 1;\n';
    const sm: SourceMap = {
      version: 3,
      sources: ['src/original.js'],
      sourcesContent: [''],
      mappings: 'AAAA',
    };
    const files = restoreFiles(sm, minified);
    expect(files).toHaveLength(1);
    expect(files[0]!.mode).toBe('mappings');
    expect(files[0]!.content.startsWith('/* [jsdj]')).toBe(true);
    expect(files[0]!.content).toContain('var x = 1;');
  });

  test('no content and no minified yields nothing', () => {
    const sm: SourceMap = {
      version: 3,
      sources: ['src/a.js'],
      mappings: 'AAAA',
    };
    expect(restoreFiles(sm)).toHaveLength(0);
  });

  test('unnamed fallback when source path normalises to empty', () => {
    const sm: SourceMap = {
      version: 3,
      sources: [''],
      sourcesContent: ['content'],
      mappings: '',
    };
    const files = restoreFiles(sm);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe('unnamed_0.js');
  });
});

// ===== safeFilePath =====

describe('safeFilePath', () => {
  const cases: [string, string][] = [
    ['src/App.jsx', 'src/App.jsx'],
    ['a/b/c.js', 'a/b/c.js'],
    ['single.js', 'single.js'],
    ['', ''],
  ];
  for (const [input, want] of cases) {
    test(`${input || '<empty>'}`, () => {
      expect(safeFilePath(input)).toBe(want);
    });
  }
});

// ===== path length and depth limits =====

describe('path limits', () => {
  test('over-long path is truncated but kept', () => {
    const longPart = 'a'.repeat(100);
    let longPath = '';
    for (let i = 0; i < 10; i++) {
      longPath += longPart + '/';
    }
    longPath += 'filename.js';

    const result = normalizeSourcePath(longPath, '');
    expect(result.length).toBeLessThanOrEqual(MAX_SOURCE_PATH_LEN + 100);
    expect(result).not.toBe('');
  });

  test('over-deep path is flattened within the depth limit', () => {
    const deepPath = 'dir/'.repeat(50) + 'file.js';
    const result = normalizeSourcePath(deepPath, '');
    const depth = (result.match(/\//g) ?? []).length;
    expect(depth).toBeLessThanOrEqual(MAX_SOURCE_PATH_DEPTH);
    expect(result).not.toBe('');
  });
});

// ===== hasSourcesContent =====

describe('hasSourcesContent', () => {
  const cases: [string, SourceMap, boolean][] = [
    ['undefined content', { version: 3, sources: ['a'], mappings: '' }, false],
    ['empty array', { version: 3, sources: ['a'], sourcesContent: [], mappings: '' }, false],
    ['all empty', { version: 3, sources: ['a', 'b'], sourcesContent: ['', ''], mappings: '' }, false],
    ['has content', { version: 3, sources: ['a'], sourcesContent: ['code'], mappings: '' }, true],
    ['partial', { version: 3, sources: ['a', 'b'], sourcesContent: ['', 'code'], mappings: '' }, true],
    ['null entry', { version: 3, sources: ['a'], sourcesContent: [null], mappings: '' }, false],
  ];
  for (const [name, sm, want] of cases) {
    test(name, () => {
      expect(hasSourcesContent(sm)).toBe(want);
    });
  }
});

// ===== reconstructFromMappings across sources =====

describe('reconstructFromMappings', () => {
  test('splits minified content by source index', () => {
    const minified = 'aaa\nbbb\n';
    // Line 0 segment targets source 0; line 1 segment targets source 1.
    const mappings = parseMappings('AAAA;ACCA');
    expect(mappings).toHaveLength(2);

    expect(reconstructFromMappings(mappings, minified, 0)).toContain('aaa');
    expect(reconstructFromMappings(mappings, minified, 1)).toContain('bbb');
  });

  test('unknown source index yields empty string', () => {
    const mappings = parseMappings('AAAA');
    expect(reconstructFromMappings(mappings, 'code\n', 99)).toBe('');
  });
});