/**
 * Micro-frontend plugins.
 *
 * All five follow the same shape: find the framework's registration config in a
 * bundle, pull out the `entry`/`url` value — which points at a sub-application's
 * HTML directory, not a JS file — and hand it to the pipeline as an HTML
 * intermediate. The pipeline then downloads that HTML and runs the ordinary
 * plugins over it, so a sub-app's scripts are found the same way the host's are.
 *
 * Two details keep the false-positive rate down:
 *
 * - A context check. A captured value is only accepted when a companion config
 *   field (`container`, `name`, `el`, …) appears within a 400-character window,
 *   which distinguishes a real registration object from an unrelated string that
 *   happens to match `url: "..."`.
 * - An entry-shape check. Template placeholders, protocol-relative dev addresses
 *   and bare relative paths are rejected: none of them can be resolved reliably
 *   from inside a bundle.
 */

import type {
  AnalyzeInput,
  Plugin,
  PluginResult,
} from '../extractor/types.js';
import { decodeContent } from '../extractor/decode.js';
import {
  ResultBuilder,
  MAX_MICRO_APP_ENTRIES,
  containsAny,
  forEachMatch,
  hasContextNearby,
} from './helpers.js';

/** Per-plugin entry cap. */
const MAX_ENTRIES = MAX_MICRO_APP_ENTRIES;

/**
 * Whether a registration value points at a sub-application HTML entry.
 *
 * Accepts an absolute path directory (`/aio/app/business/`), a full URL
 * directory (`https://cdn.x.com/app/`), or an explicit HTML file. Rejects a
 * protocol-relative dev address (`//127.0.0.1:5010/`), template placeholders, and
 * bare relative paths — the last because a directory entry cannot be resolved
 * reliably relative to a bundle that may itself be served from a CDN.
 */
export function looksLikeMicroAppEntry(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '') {
    return false;
  }
  // Dev entries are typically protocol-relative (`//ip:port/`).
  if (trimmed.startsWith('//')) {
    return false;
  }
  if (
    !trimmed.startsWith('/') &&
    !trimmed.startsWith('http://') &&
    !trimmed.startsWith('https://')
  ) {
    return false;
  }
  if (trimmed.includes('${')) {
    return false;
  }

  const lower = trimmed.toLowerCase();
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    return true;
  }

  // Directory form must end in a slash.
  if (!trimmed.endsWith('/')) {
    return false;
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      new URL(trimmed);
    } catch {
      return false;
    }
  }
  return true;
}

/** Shared implementation for the config-keyed micro-frontend plugins. */
abstract class MicroAppPluginBase implements Plugin {
  abstract readonly name: string;

  /** Config key pattern; the first capture is the entry value. */
  protected abstract readonly entryPattern: RegExp;
  /** Framework markers that must appear for the plugin to apply. */
  protected abstract readonly markers: readonly string[];
  /** Companion fields that confirm a real registration object. */
  protected abstract readonly contextKeywords: readonly string[];

  precheck(input: AnalyzeInput): boolean {
    if (input.contentType !== 'js') {
      return false;
    }
    return containsAny(textOf(input), this.markers);
  }

  analyze(input: AnalyzeInput): PluginResult {
    const builder = new ResultBuilder(input.sourceUrl);

    // Minified bundles escape slashes (`\/`), so decode before matching.
    const content = decodeContent(textOf(input));
    if (content === '') {
      return {};
    }

    forEachMatch(this.entryPattern, content, (groups, match) => {
      const value = groups[0];
      if (value === undefined || value === '') {
        return;
      }

      // Position of the match, needed for the context window.
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (!hasContextNearby(content, start, end, this.contextKeywords)) {
        return;
      }

      if (!looksLikeMicroAppEntry(value)) {
        return;
      }

      builder.addIntermediate({
        url: value,
        type: 'html',
        fromUrl: input.sourceUrl,
      });
    });

    // The entry cap is enforced by truncation rather than by breaking early,
    // because `forEachMatch` cannot be interrupted; the pipeline's global HTML
    // budget is the effective limit anyway.
    const result = builder.build();
    if (result.intermediates && result.intermediates.length > MAX_ENTRIES) {
      result.intermediates = result.intermediates.slice(0, MAX_ENTRIES);
    }
    return result;
  }
}

/**
 * qiankun: `entry` or `proEntry` in `registerMicroApps`.
 *
 * `entry` is the qiankun v2 key; `proEntry` is what vite-plugin-qiankun emits.
 */
export class QiankunPlugin extends MicroAppPluginBase {
  readonly name = 'QiankunPlugin';
  protected readonly entryPattern = /(?:proEntry|entry)["']?\s*:\s*["']([^"']+)["']/g;
  protected readonly markers = ['proEntry', 'entry'];
  protected readonly contextKeywords = [
    'container',
    'activeRule',
    'activeWhen',
    'sandbox',
    'singular',
    'name',
  ];
}

/** Garfish: `entry` inside an `apps` array. */
export class GarfishPlugin extends MicroAppPluginBase {
  readonly name = 'GarfishPlugin';
  protected readonly entryPattern = /entry["']?\s*:\s*["']([^"']+)["']/g;
  protected readonly markers = ['Garfish', 'garfish'];
  protected readonly contextKeywords = ['name'];
}

/** micro-app: `url` in a `microApp.start` config. */
export class MicroAppPlugin extends MicroAppPluginBase {
  readonly name = 'MicroAppPlugin';
  protected readonly entryPattern = /url["']?\s*:\s*["']([^"']+)["']/g;
  protected readonly markers = ['microApp.start', 'micro-app'];
  protected readonly contextKeywords = ['name', 'container'];
}

/** wujie: `url` in a `startApp` config. */
export class WujiePlugin extends MicroAppPluginBase {
  readonly name = 'WujiePlugin';
  protected readonly entryPattern = /url["']?\s*:\s*["']([^"']+)["']/g;
  protected readonly markers = ['startApp', 'wujie'];
  protected readonly contextKeywords = ['name', 'el'];
}

/**
 * icestark: `url` as a single value or inside an array.
 *
 * The array form needs separate handling: `url: ["/a/", "/b/"]` yields several
 * entries from one config key, and the single-value pattern would only capture
 * the first.
 */
export class IcestarkPlugin implements Plugin {
  readonly name = 'IcestarkPlugin';
  private readonly urlSingle = /url["']?\s*:\s*(?:\[\s*)?["']([^"']+)["']/g;
  private readonly urlArray = /url["']?\s*:\s*\[([^\]]+)\]/g;
  private readonly quoted = /["']([^"']+)["']/g;

  precheck(input: AnalyzeInput): boolean {
    if (input.contentType !== 'js') {
      return false;
    }
    return containsAny(textOf(input), ['AppRoute', '@ice/stark', 'icestark']);
  }

  analyze(input: AnalyzeInput): PluginResult {
    const builder = new ResultBuilder(input.sourceUrl);
    const content = decodeContent(textOf(input));
    if (content === '') {
      return {};
    }

    const accept = (value: string, start: number, end: number): void => {
      if (
        !hasContextNearby(content, start, end, ['name', 'container', 'sandbox']) ||
        !looksLikeMicroAppEntry(value)
      ) {
        return;
      }
      builder.addIntermediate({ url: value, type: 'html', fromUrl: input.sourceUrl });
    };

    // The array form first, so its members are not double-counted by the
    // single-value pattern's optional `[`.
    forEachMatch(this.urlArray, content, (groups, match) => {
      const body = groups[0];
      if (body === undefined) {
        return;
      }
      const base = match.index ?? 0;
      forEachMatch(this.quoted, body, (inner) => {
        const value = inner[0];
        if (value !== undefined) {
          accept(value, base, base + match[0].length);
        }
      });
    });

    forEachMatch(this.urlSingle, content, (groups, match) => {
      const value = groups[0];
      if (value === undefined) {
        return;
      }
      const start = match.index ?? 0;
      accept(value, start, start + match[0].length);
    });

    const result = builder.build();
    if (result.intermediates && result.intermediates.length > MAX_ENTRIES) {
      result.intermediates = result.intermediates.slice(0, MAX_ENTRIES);
    }
    return result;
  }
}

function textOf(input: AnalyzeInput): string {
  return input.text ?? new TextDecoder('utf-8', { fatal: false }).decode(input.content);
}