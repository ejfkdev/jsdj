/**
 * HTML script extraction.
 *
 * Covers `<script src>`, `<link rel="modulepreload">`, `<link rel="prefetch">`
 * and `<script type="module" src>`, plus inline script bodies lifted out for
 * separate analysis.
 *
 * The inline-script extraction uses a real tokenizer rather than a regex,
 * because a `</script>` inside a string literal would fool a regex and truncate
 * the body. The regexes only handle the attribute-bearing tags, where nesting is
 * not a hazard.
 */

import type { AnalyzeInput, Plugin, PluginContext, PluginResult } from '../extractor/types.js';
import { ResultBuilder, findAllFirst, firstPresent, forEachMatch } from './helpers.js';

/** Matches `<script ... src="...">` with an optionally unquoted value. */
const SCRIPT_SRC = /<script[^>]*\bsrc=["']?([^"'>\s]+)["']?/gi;

/** Matches `<link rel="modulepreload" href="...">` with an optional `.js` suffix check. */
const MODULE_PRELOAD =
  /<link[^>]+rel\s*=\s*["']?modulepreload["']?[^>]+href\s*=\s*["']?([^"'\s>]+\.js)["']?/gi;

/**
 * Matches `<link rel="prefetch" href="...">` in either attribute order.
 *
 * Two capture groups because `href` may precede or follow `rel`; exactly one
 * will be populated. Both forms appear in the wild — Vue 3 / Vite production
 * builds emit prefetch links for every async chunk, and minified HTML often puts
 * `href` first.
 */
const PREFETCH =
  /<link[^>]+(?:href\s*=\s*["']?([^"'\s>]+\.js)["']?[^>]*rel\s*=\s*["']?prefetch["']?|rel\s*=\s*["']?prefetch["']?[^>]+href\s*=\s*["']?([^"'\s>]+\.js)["']?)/gi;

/** Matches `<script type="module" src="...">`. */
const ENTRY_SCRIPT = /<script[^>]+type=["']module["'][^>]*src=["']([^"']+)["']/gi;

/** Extract script tags, preload/prefetch hints and inline script bodies from HTML. */
export class HtmlScriptPlugin implements Plugin {
  readonly name = 'HTMLScriptPlugin';

  precheck(input: AnalyzeInput): boolean {
    return input.contentType === 'html';
  }

  analyze(input: AnalyzeInput): PluginResult {
    const builder = new ResultBuilder(input.sourceUrl);
    const text = input.text ?? decode(input.content);

    for (const src of findAllFirst(SCRIPT_SRC, text)) {
      builder.add(src);
    }

    for (const href of findAllFirst(MODULE_PRELOAD, text)) {
      builder.add(href);
    }

    // Prefetch links: pick whichever of the two alternation groups matched.
    forEachMatch(PREFETCH, text, (groups) => {
      const href = firstPresent(groups);
      if (href !== '') {
        builder.add(href);
      }
    });

    for (const src of findAllFirst(ENTRY_SCRIPT, text)) {
      builder.add(src);
    }

    const result = builder.build();

    // Inline bodies are handed back for the pipeline to analyse as JS, one level
    // deep, with this document as the base URL so relative imports resolve.
    const inlineScripts = extractInlineScripts(text)
      .map((content, index) => ({ sourceUrl: input.sourceUrl, index, content }))
      .filter((script) => script.content.length > 0);

    if (inlineScripts.length > 0) {
      result.inlineScripts = inlineScripts;
    }

    return result;
  }
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/**
 * Extract the bodies of inline `<script>` elements.
 *
 * A hand-rolled scanner rather than `DOMParser`, because `DOMParser` is a browser
 * API and this must run identically on Node. The scan tracks whether the current
 * tag is a `script` with no `src`, and collects raw text until the matching
 * `</script>`.
 *
 * Comment handling matters: `<!-- ... -->` can legally wrap script content, and a
 * `</script>` inside a JS string would otherwise end the body early — a real
 * pattern in bundles that embed HTML snippets.
 */
export function extractInlineScripts(html: string): string[] {
  const scripts: string[] = [];
  const lower = html.toLowerCase();
  let cursor = 0;

  while (cursor < html.length) {
    const open = lower.indexOf('<script', cursor);
    if (open < 0) {
      break;
    }

    // Confirm the tag name ends here, so `<scripting-thing>` is not matched.
    const afterName = open + '<script'.length;
    const nameEndChar = html[afterName];
    if (
      nameEndChar !== undefined &&
      nameEndChar !== '>' &&
      nameEndChar !== '/' &&
      !/\s/.test(nameEndChar)
    ) {
      cursor = afterName;
      continue;
    }

    const tagEnd = html.indexOf('>', afterName);
    if (tagEnd < 0) {
      break;
    }

    const attributes = html.slice(afterName, tagEnd);
    const selfClosing = attributes.trimEnd().endsWith('/');

    // An external script has nothing to extract.
    if (/\bsrc\s*=/i.test(attributes)) {
      cursor = tagEnd + 1;
      continue;
    }

    if (selfClosing) {
      scripts.push('');
      cursor = tagEnd + 1;
      continue;
    }

    const close = findScriptClose(lower, tagEnd + 1);
    const body = html.slice(tagEnd + 1, close);
    scripts.push(body);
    cursor = close >= html.length ? html.length : close + '</script>'.length;
  }

  return scripts;
}

/**
 * Find the offset of the `</script>` that closes the current element.
 *
 * Walks candidate closers and skips any that fall inside a string literal or a
 * `<!-- -->` comment, since those are content rather than terminators.
 */
function findScriptClose(lowerHtml: string, from: number): number {
  let cursor = from;
  for (;;) {
    const close = lowerHtml.indexOf('</script', cursor);
    if (close < 0) {
      return lowerHtml.length;
    }

    // Verify this is really a closing tag and not `</scriptfoo>`.
    const after = lowerHtml[close + '</script'.length];
    if (after !== undefined && after !== '>' && !/\s/.test(after)) {
      cursor = close + 1;
      continue;
    }

    if (isInsideComment(lowerHtml, from, close) || isInsideString(lowerHtml, from, close)) {
      cursor = close + 1;
      continue;
    }

    return close;
  }
}

/** Whether `offset` sits inside an unterminated `<!-- ... -->` after `from`. */
function isInsideComment(html: string, from: number, offset: number): boolean {
  let cursor = from;
  while (cursor < offset) {
    const open = html.indexOf('<!--', cursor);
    if (open < 0 || open >= offset) {
      return false;
    }
    const close = html.indexOf('-->', open + 4);
    if (close < 0) {
      // Comment never closes: everything after it is comment text.
      return true;
    }
    if (close >= offset) {
      return true;
    }
    cursor = close + 3;
  }
  return false;
}

/**
 * Whether `offset` sits inside an unterminated string literal after `from`.
 *
 * This is deliberately approximate — it does not parse template literals with
 * nesting, and it treats an apostrophe in a comment as a quote. A false positive
 * here means one candidate closer is skipped, which the next iteration recovers
 * from; a false negative means a body is cut short. Conservative bias toward
 * "inside a string" is therefore the right direction.
 */
function isInsideString(html: string, from: number, offset: number): boolean {
  let quote: string | null = null;
  for (let i = from; i < offset; i++) {
    const ch = html[i]!;
    if (quote === null) {
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
      }
    } else if (ch === '\\') {
      // Skip the escaped character.
      i++;
    } else if (ch === quote) {
      quote = null;
    }
  }
  return quote !== null;
}