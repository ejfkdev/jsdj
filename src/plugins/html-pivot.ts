/**
 * HTML entry-point discovery.
 *
 * Finds further HTML documents to crawl, from two sources:
 *
 * - **HTML content**: same-origin `<a href>`, `<link href>` and `<iframe src>`.
 *   This is what covers multi-page sites where the server renders a directory
 *   index per route.
 * - **JS content**: quoted `.html` literals. Frameworks like Storybook reference
 *   a preview page (`iframe.html`) as a string and only concatenate it into an
 *   iframe's `src` at runtime, so nothing in the markup points at it.
 *
 * Cross-origin links are dropped — the point is to walk a site, not the web —
 * and every entry is queued as an HTML intermediate, where the pipeline's global
 * pivot budget bounds the crawl.
 */

import type {
  AnalyzeInput,
  Plugin,
  PluginResult,
} from '../extractor/types.js';
import { decodeContent } from '../extractor/decode.js';
import {
  MAX_MICRO_APP_ENTRIES,
  ResultBuilder,
  containsAny,
  firstPresent,
  forEachMatch,
} from './helpers.js';

/** Extensions that disqualify a link from being an HTML entry. */
const NON_HTML_EXTENSIONS = [
  '.js',
  '.css',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.json',
  '.xml',
  '.map',
  '.pdf',
];

export class HtmlPivotPlugin implements Plugin {
  readonly name = 'HTMLPivotPlugin';

  /** Quoted `.html`/`.htm` literals in JS. */
  private readonly jsHtml = /["']([^"'<>\\\s]{1,200}\.html?)["']/g;

  /** `<a href>`, `<link href>`, `<iframe src>` with quoted or bare values. */
  private readonly hrefAttribute =
    /(?:<a\b[^>]*\bhref\s*=\s*|<link\b[^>]*\bhref\s*=\s*|<iframe\b[^>]*\bsrc\s*=\s*)(?:"([^"]+)"|'([^']+)'|([^"'\s>]+))/g;

  precheck(input: AnalyzeInput): boolean {
    const text = textOf(input);
    if (input.contentType === 'html') {
      return containsAny(text, ['href=', 'iframe']);
    }
    if (input.contentType === 'js') {
      return containsAny(text, ['.html', 'import(']);
    }
    return false;
  }

  analyze(input: AnalyzeInput): PluginResult {
    const builder = new ResultBuilder(input.sourceUrl);

    let sourceHost = '';
    try {
      sourceHost = new URL(input.sourceUrl).host;
    } catch {
      sourceHost = '';
    }

    const accepted = new Set<string>();

    const addOne = (raw: string): void => {
      let value = raw.trim();
      if (value === '') {
        return;
      }
      // Anchors, pseudo-schemes and template placeholders are not crawlable.
      if (
        value.startsWith('#') ||
        value.startsWith('javascript:') ||
        value.startsWith('mailto:') ||
        value.includes('${')
      ) {
        return;
      }
      // A query string on a navigation link is not part of the resource path.
      const queryIdx = value.indexOf('?');
      if (queryIdx >= 0) {
        value = value.slice(0, queryIdx);
      }
      if (value === '') {
        return;
      }

      const lower = value.toLowerCase();
      for (const ext of NON_HTML_EXTENSIONS) {
        if (lower.endsWith(ext)) {
          return;
        }
      }

      let absolute: string;
      try {
        absolute = new URL(value, input.sourceUrl).toString();
      } catch {
        return;
      }
      if (!absolute.startsWith('http://') && !absolute.startsWith('https://')) {
        return;
      }

      // Same-origin only.
      try {
        const parsed = new URL(absolute);
        if (sourceHost !== '' && parsed.host !== sourceHost) {
          return;
        }
      } catch {
        return;
      }
      if (accepted.has(absolute)) {
        return;
      }
      accepted.add(absolute);

      builder.addIntermediate({
        url: absolute,
        type: 'html',
        fromUrl: input.sourceUrl,
      });
    };

    /**
     * A directory-shaped link is expanded into three candidates.
     *
     * Multi-page frameworks disagree about how a route maps to disk: some serve
     * `/page1` from a route handler, some write `/page1/index.html`, some write
     * `/page1.html`. Trying all three costs two harmless 404s when the first is
     * right.
     */
    const add = (raw: string): void => {
      const value = raw.trim();
      if (value === '') {
        return;
      }
      const withoutTrailing = value.replace(/\/+$/, '');
      if (!withoutTrailing.includes('.') && !value.endsWith('/')) {
        addOne(value);
        addOne(`${value}/index.html`);
        addOne(`${value}.html`);
        return;
      }
      addOne(value);
    };

    if (input.contentType === 'js') {
      const content = decodeContent(textOf(input));
      forEachMatch(this.jsHtml, content, (groups) => {
        const value = groups[0];
        if (value !== undefined) {
          add(value);
        }
      });
      return builder.build();
    }

    const text = textOf(input);
    // Bounded, as in the reference implementation: a page's navigation can list more
    // pages than the crawl budget allows, and contributing all of them would let this
    // one page consume the entire budget before the pages it links to have even been
    // fetched. `forEachMatch` cannot be interrupted, so the count is checked inside.
    let emitted = 0;
    forEachMatch(this.hrefAttribute, text, (groups) => {
      if (emitted >= MAX_MICRO_APP_ENTRIES) {
        return;
      }
      const value = firstPresent(groups);
      if (value !== '') {
        const before = builder.intermediateCount;
        add(value);
        if (builder.intermediateCount > before) {
          emitted = builder.intermediateCount;
        }
      }
    });

    return builder.build();
  }
}

function textOf(input: AnalyzeInput): string {
  return input.text ?? new TextDecoder('utf-8', { fatal: false }).decode(input.content);
}