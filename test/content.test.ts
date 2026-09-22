/**
 * Content classification and URL identity tests.
 *
 * These cover behaviours where a plausible-but-wrong implementation diverges from
 * on real sites. Each case documents what the divergence would be, because the
 * symptoms are subtle — a wrongly-classified body silently adds or drops a URL.
 */

import { describe, expect, test } from 'bun:test';

import {
  decodeContent,
  detectContentKind,
  jsonpCallbackName,
  looksLikeJsonp,
  unwrapJsonp,
} from '../src/extractor/decode.js';
import { UniversalUrlPlugin } from '../src/plugins/patterns.js';
import {
  buildSourceMapUrl,
  expandComboLoader,
  getBaseUrl,
  isLikelyStaticResource,
  isSourceMapUrl,
  normalizeUrl,
  rebaseLoopbackOrigin,
  resolveRelativePath,
} from '../src/extractor/url.js';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('detectContentKind', () => {
  test('recognises the standard MIME types', () => {
    expect(detectContentKind('text/html', bytes('x'))).toBe('html');
    expect(detectContentKind('text/html; charset=utf-8', bytes('x'))).toBe('html');
    expect(detectContentKind('application/xhtml+xml', bytes('x'))).toBe('html');
    expect(detectContentKind('application/json', bytes('x'))).toBe('json');
    expect(detectContentKind('text/json', bytes('x'))).toBe('json');
    expect(detectContentKind('application/javascript', bytes('x'))).toBe('js');
    expect(detectContentKind('text/javascript', bytes('x'))).toBe('js');
    expect(detectContentKind('application/x-javascript', bytes('x'))).toBe('js');
  });

  test('an unrecognised MIME type falls back to sniffing', () => {
    // A web app manifest: the type is not recognised, and the fallback
    // classifies any `{`-leading body as JSON. Treating it as JS instead would
    // make the pipeline report the manifest as a JavaScript file.
    expect(
      detectContentKind('application/manifest+json', bytes('{"name":"React"}')),
    ).toBe('json');
  });

  test('a JSON body is JSON regardless of the URL', () => {
    // There is no URL tiebreaker here; adding one changes which URLs are reported.
    expect(detectContentKind('text/plain', bytes('{"a":1}'))).toBe('json');
    expect(detectContentKind('text/plain', bytes('[1,2]'))).toBe('json');
    expect(detectContentKind('', bytes('{"a":1}'), 'https://a.test/x.js')).toBe(
      'json',
    );
  });

  test('an HTML body is HTML regardless of a .js URL', () => {
    expect(detectContentKind('', bytes('<!DOCTYPE html><p>x'), 'https://a.test/x.js')).toBe(
      'html',
    );
  });

  test('names JSONP rather than folding it into JS', () => {
    // A callback-wrapped body is reported as `jsonp`, so a
    // caller can choose to unwrap rather than treat the callback as source.
    expect(detectContentKind('', bytes('cb({"a":1})'))).toBe('jsonp');
    expect(detectContentKind('', bytes('window.cb([1,2])'))).toBe('jsonp');
    expect(detectContentKind('', bytes('a.b.c({})'))).toBe('jsonp');
  });

  test('a mislabelled JS bundle is still treated as JS', () => {
    // The whole reason the default is JS rather than HTML.
    expect(detectContentKind('text/plain', bytes('function f(){return 1}'))).toBe('js');
    expect(detectContentKind('application/octet-stream', bytes('const x=1'))).toBe('js');
    expect(detectContentKind('', bytes('!function(){}()'))).toBe('js');
  });

  test('defaults to JS when nothing is conclusive', () => {
    expect(detectContentKind('', bytes('42'))).toBe('js');
    expect(detectContentKind('', bytes(''))).toBe('js');
  });
});

describe('JSONP helpers', () => {
  test('looksLikeJsonp accepts a call wrapping an object or array', () => {
    expect(looksLikeJsonp('cb({})')).toBe(true);
    expect(looksLikeJsonp('cb([1])')).toBe(true);
    expect(looksLikeJsonp('cb ({})')).toBe(true);
    expect(looksLikeJsonp('window.cb({})')).toBe(true);
  });

  test('looksLikeJsonp rejects plain JS and plain JSON', () => {
    expect(looksLikeJsonp('function f(){}')).toBe(false);
    expect(looksLikeJsonp('{"a":1}')).toBe(false);
    expect(looksLikeJsonp('[1,2]')).toBe(false);
    // A call with a non-literal argument is not a JSONP payload.
    expect(looksLikeJsonp('cb(name)')).toBe(false);
  });

  test('jsonpCallbackName extracts the callback', () => {
    expect(jsonpCallbackName('cb({})')).toBe('cb');
    expect(jsonpCallbackName('a.b.c({})')).toBe('a.b.c');
    expect(jsonpCallbackName('{"a":1}')).toBeNull();
  });

  test('unwrapJsonp returns the inner JSON', () => {
    expect(unwrapJsonp('cb({"a":1})')).toBe('{"a":1}');
    expect(unwrapJsonp('cb([1,2]);')).toBe('[1,2]');
    // Some endpoints prepend a block comment.
    expect(unwrapJsonp('/* hi */cb({"a":1})')).toBe('{"a":1}');
  });

  test('unwrapJsonp returns null when there is no JSON to unwrap', () => {
    expect(unwrapJsonp('cb(notJson)')).toBeNull();
    expect(unwrapJsonp('{"a":1}')).toBeNull();
    expect(unwrapJsonp('cb(')).toBeNull();
  });
});

describe('decodeContent', () => {
  test('reverses JS string escapes, making escaped URLs matchable', () => {
    expect(decodeContent('"https:\\/\\/a.test\\/b.js"')).toBe('"https://a.test/b.js"');
  });

  test('reverses URL encoding', () => {
    expect(decodeContent('%2Fa%2Fb.js')).toBe('/a/b.js');
  });

  test('reverses Unicode escapes', () => {
    expect(decodeContent('\\u003Cscript src=x\\u003E')).toBe('<script src=x>');
  });

  test('reverses HTML entities without over-decoding', () => {
    expect(decodeContent('&lt;script&gt;')).toBe('<script>');
    // `&amp;lt;` must decode to `&lt;`, not all the way to `<`.
    expect(decodeContent('&amp;lt;')).toBe('&lt;');
  });

  test('leaves content without escapes untouched', () => {
    expect(decodeContent('const x = 1;')).toBe('const x = 1;');
  });

  test('a literal backslash survives', () => {
    // A placeholder protects `\\` so a real backslash is not consumed by the
    // single-escape replacements.
    expect(decodeContent('a\\\\b')).toBe('a\\b');
  });
});

describe('normalizeUrl', () => {
  test('matches Go path.Clean semantics', () => {
    // Verified against the Go extractor's NormalizeURL. A bare origin keeps no
    // trailing slash, and a non-empty path loses one.
    const cases: [string, string][] = [
      ['https://a.test', 'https://a.test'],
      ['https://a.test/', 'https://a.test/'],
      ['https://a.test/guide', 'https://a.test/guide'],
      ['https://a.test/guide/', 'https://a.test/guide'],
      ['https://a.test/x/../y', 'https://a.test/y'],
      ['https://a.test/a//b', 'https://a.test/a/b'],
      ['https://a.test/a?b=1#frag', 'https://a.test/a?b=1'],
    ];
    for (const [input, want] of cases) {
      expect(normalizeUrl(input)).toBe(want);
    }
  });

  test('is idempotent', () => {
    // The pipeline normalises on enqueue and again on dequeue, so a second pass
    // must not change the key.
    for (const input of [
      'https://a.test',
      'https://a.test/guide/',
      'https://a.test/a//b',
      'https://a.test/a.js?v=1#x',
    ]) {
      const once = normalizeUrl(input);
      expect(normalizeUrl(once)).toBe(once);
    }
  });

  test('returns unparseable input unchanged', () => {
    expect(normalizeUrl('not a url')).toBe('not a url');
  });
});

describe('rebaseLoopbackOrigin', () => {
  test('rewrites a loopback origin onto the scanned one, port included', () => {
    // The regression this guards: assigning `url.host` keeps the existing port, so
    // a naive implementation yields `a.test:50315` instead of `a.test`.
    expect(
      rebaseLoopbackOrigin(
        'http://127.0.0.1:50315/remote/entry.js',
        'https://a.test/',
      ),
    ).toBe('https://a.test/remote/entry.js');

    expect(
      rebaseLoopbackOrigin('http://localhost:3000/x.js', 'https://a.test/app/'),
    ).toBe('https://a.test/x.js');
  });

  test('leaves a non-loopback target alone', () => {
    expect(
      rebaseLoopbackOrigin('https://cdn.test/x.js', 'https://a.test/'),
    ).toBe('https://cdn.test/x.js');
  });

  test('leaves an already-matching origin alone', () => {
    expect(
      rebaseLoopbackOrigin('https://a.test/x.js', 'https://a.test/'),
    ).toBe('https://a.test/x.js');
  });

  test('preserves the path and drops the loopback port', () => {
    const result = rebaseLoopbackOrigin(
      'http://127.0.0.1:8080/a/b/c.js',
      'https://a.test:443/',
    );
    expect(result).not.toContain('8080');
    expect(result).toContain('/a/b/c.js');
  });
});

describe('URL helpers', () => {
  test('resolveRelativePath handles the usual forms', () => {
    expect(resolveRelativePath('https://a.test/x/y.js', './z.js')).toBe(
      'https://a.test/x/z.js',
    );
    expect(resolveRelativePath('https://a.test/x/y.js', '/z.js')).toBe(
      'https://a.test/z.js',
    );
    expect(resolveRelativePath('https://a.test/x/', '//b.test/z.js')).toBe(
      'https://b.test/z.js',
    );
  });

  test('getBaseUrl returns scheme and host', () => {
    expect(getBaseUrl('https://a.test:8443/x/y')).toBe('https://a.test:8443');
  });

  test('buildSourceMapUrl inserts before the query', () => {
    expect(buildSourceMapUrl('https://a.test/app.js')).toBe(
      'https://a.test/app.js.map',
    );
    expect(buildSourceMapUrl('https://a.test/app.js?v=1')).toBe(
      'https://a.test/app.js.map?v=1',
    );
  });

  test('isSourceMapUrl ignores the query string', () => {
    expect(isSourceMapUrl('https://a.test/app.js.map')).toBe(true);
    expect(isSourceMapUrl('https://a.test/app.js.map?v=1')).toBe(true);
    expect(isSourceMapUrl('https://a.test/app.js')).toBe(false);
  });

  test('expandComboLoader splits a WordPress-style bundle', () => {
    expect(
      expandComboLoader('https://a.test/_static/??/js/a.js,/js/b.js'),
    ).toEqual(['https://a.test/_static/js/a.js', 'https://a.test/_static/js/b.js']);
  });

  test('expandComboLoader splits an Alibaba-style bundle', () => {
    expect(expandComboLoader('https://g.alicdn.com/path/??a.js,b.js')).toEqual([
      'https://g.alicdn.com/path/a.js',
      'https://g.alicdn.com/path/b.js',
    ]);
  });

  test('expandComboLoader passes through a URL without ??', () => {
    expect(expandComboLoader('https://a.test/app.js')).toEqual([
      'https://a.test/app.js',
    ]);
  });

  test('expandComboLoader handles both real formats', () => {
    // WordPress puts the prefix before `??` and the members start with `/`.
    expect(expandComboLoader('https://a.test/_static/??/js/a.js,/js/b.js')).toEqual([
      'https://a.test/_static/js/a.js',
      'https://a.test/_static/js/b.js',
    ]);
    // Alibaba Cloud CDN puts the members directly after `??`.
    expect(expandComboLoader('https://g.alicdn.com/path/??a.js,b.js')).toEqual([
      'https://g.alicdn.com/path/a.js',
      'https://g.alicdn.com/path/b.js',
    ]);
  });

  test('a combo URL is expanded before URL resolution', async () => {
    // The subtle case, and the reason the expansion happens inside the plugin rather
    // than only in the pipeline: the WHATWG URL parser cannot tell `??` from the start
    // of a query string, so resolving `/static/??a.js,b.js` first turns it into a path
    // of `/static` plus a query, losing the slash that separates the prefix from the
    // member list. Expanding on the raw text keeps it intact.
    const plugin = new UniversalUrlPlugin();
    const text = `document.write('<scr'+'ipt src="/static/??combo-a.js,combo-b.js"></scr'+'ipt>');`;

    // `UniversalUrlPlugin.analyze` takes only the input: it needs no accumulated
    // state, which is why its signature omits the context argument.
    const result = plugin.analyze({
      sourceUrl: 'https://a.test/static/combo.js',
      contentType: 'js',
      content: new TextEncoder().encode(text),
      text,
    });

    const urls = (result.urls ?? []).map((u) => u.url).sort();
    expect(urls).toContain('https://a.test/static/combo-a.js');
    expect(urls).toContain('https://a.test/static/combo-b.js');
    // The mangled form must not appear: it would 404.
    expect(urls.some((u) => u.includes('??'))).toBe(false);
  });

  test('isLikelyStaticResource matches the loose cases', () => {
    expect(isLikelyStaticResource('https://a.test/app.js')).toBe(true);
    expect(isLikelyStaticResource('https://a.test/load?type=module.js')).toBe(true);
    expect(isLikelyStaticResource('https://a.test/hm.js?t=1')).toBe(true);
    // The documented oddity: `.json` contains `.js`, so a manifest path matches.
    expect(isLikelyStaticResource('https://a.test/.vite/manifest.json')).toBe(true);
    // A page is not a static resource.
    expect(isLikelyStaticResource('https://a.test/page')).toBe(false);
  });
});