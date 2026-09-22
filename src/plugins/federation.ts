/**
 * Module federation and EMP plugins.
 *
 * These three all discover artifacts whose names appear nowhere in the page: the
 * host bundle references a manifest or a `remoteEntry.js` by path, and the real
 * chunk inventory lives inside that file. Each plugin therefore emits an
 * intermediate to fetch and re-dispatch, rather than guessing at chunk names.
 */

import type {
  AnalyzeInput,
  DiscoveredResource,
  Plugin,
  PluginResult,
} from '../extractor/types.js';
import {
  ResultBuilder,
  containsAny,
  findAllFirst,
  forEachMatch,
} from './helpers.js';

function textOf(input: AnalyzeInput): string {
  return input.text ?? new TextDecoder('utf-8', { fatal: false }).decode(input.content);
}

function originOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
}

/** Module federation: `remoteEntry.js` and `*manifest*.json` references. */
export class ModuleFederationPlugin implements Plugin {
  readonly name = 'ModuleFederationPlugin';
  private readonly manifest = /["']([^"']*manifest[^"']*\.json)["']/g;
  private readonly remoteEntry = /["']([^"']*remoteEntry\.js)["']/g;

  precheck(input: AnalyzeInput): boolean {
    if (input.contentType !== 'js') {
      return false;
    }
    return containsAny(textOf(input), [
      'remoteEntry.js',
      '__webpack_share_scopes__',
      '__webpack_init_sharing__',
    ]);
  }

  analyze(input: AnalyzeInput): PluginResult {
    const builder = new ResultBuilder(input.sourceUrl);
    const content = textOf(input);

    const add = (path: string): void => {
      // A templated path is a build placeholder, not a real artifact.
      if (path.includes('{{') || path.includes('}}')) {
        return;
      }
      builder.add(path);
    };

    for (const path of findAllFirst(this.manifest, content)) {
      add(path);
    }

    // The `remoteEntry.js` runtime is itself required: it carries the remote's
    // own chunk map, which appears nowhere else.
    for (const entryPath of findAllFirst(this.remoteEntry, content)) {
      add(entryPath);

      // Sibling manifests hold the remote's full sync/async chunk inventory.
      let entryUrl: string;
      try {
        entryUrl = new URL(entryPath, input.sourceUrl).toString();
      } catch {
        continue;
      }
      const lastSlash = entryUrl.lastIndexOf('/');
      if (lastSlash < 0) {
        continue;
      }
      const dir = entryUrl.slice(0, lastSlash + 1);
      for (const name of ['mf-manifest.json', 'federation-manifest.json']) {
        add(dir + name);
      }

      // The remote's own entry HTML is probed at two conventional locations.
      // Covering both layouts matters because Vite places `remoteEntry.js` under
      // `assets/`, so the HTML is either beside it or one level up; the wrong
      // guess is a harmless 404.
      try {
        const parsed = new URL(entryUrl);
        const segments = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/');
        if (segments.length < 2 || segments[segments.length - 1] !== 'remoteEntry.js') {
          continue;
        }
        const dirs = [segments.slice(0, -1)];
        const firstDir = dirs[0]!;
        if (firstDir[firstDir.length - 1] === 'assets') {
          dirs.push(firstDir.slice(0, -1));
        }
        for (const d of dirs) {
          if (d.length === 0) {
            continue;
          }
          builder.addIntermediate({
            url: `${parsed.protocol}//${parsed.host}/${d.join('/')}/index.html`,
            type: 'html',
            fromUrl: input.sourceUrl,
          });
        }
      } catch {
        continue;
      }
    }

    return builder.build();
  }
}

/** The standard module-federation manifest shape (`@module-federation/enhanced`). */
interface StandardMfManifest {
  metaData?: { publicPath?: string };
  exposes?: Array<{
    assets?: { js?: { sync?: string[]; async?: string[] } };
  }>;
}

/** The Vmok/Feishu-era manifest shape. */
interface VmokManifest {
  metaData?: {
    publicPath?: string;
    region?: Record<string, string>;
  };
  shared?: Array<{ assets?: { js?: { sync?: string[]; async?: string[] } } }>;
  exposes?: Array<{ assets?: { js?: { sync?: string[]; async?: string[] } } }>;
}

/** Parsed Vmok manifest: chunk paths plus the CDN origin they live on. */
export interface VmokManifestResult {
  chunks: string[];
  cdnBase: string;
  publicPath: string;
}

/**
 * Parse a Vmok-style manifest.
 *
 * The chunk list comes from `shared[].assets.js` and `exposes[].assets.js`, and
 * the URLs are rebuilt from the region CDN origin plus the `publicPath` with its
 * `//__CDN_PREFIX__/` placeholder stripped.
 */
export function parseVmokManifest(jsonContent: string): VmokManifestResult {
  let manifest: VmokManifest;
  try {
    manifest = JSON.parse(jsonContent) as VmokManifest;
  } catch {
    return { chunks: [], cdnBase: '', publicPath: '' };
  }

  const collected: string[] = [];
  for (const shared of manifest.shared ?? []) {
    collected.push(...(shared.assets?.js?.sync ?? []));
    collected.push(...(shared.assets?.js?.async ?? []));
  }
  for (const expose of manifest.exposes ?? []) {
    collected.push(...(expose.assets?.js?.sync ?? []));
    collected.push(...(expose.assets?.js?.async ?? []));
  }

  const chunks = [...new Set(collected)];

  const region = manifest.metaData?.region?.['cn'];
  const cdnBase = region !== undefined && region !== '' ? `https://${region}` : '';

  const rawPublicPath = manifest.metaData?.publicPath ?? '';
  const publicPath = rawPublicPath.replace('//__CDN_PREFIX__/', '');

  return { chunks, cdnBase, publicPath };
}

/** Rebuild absolute chunk URLs from a parsed Vmok manifest. */
export function constructVmokChunkUrls(
  result: VmokManifestResult,
  fromUrl: string,
): DiscoveredResource[] {
  const cdnBase = result.cdnBase.replace(/\/+$/, '');
  const publicPath = result.publicPath.replace(/^\/+/, '').replace(/\/+$/, '');

  return result.chunks.map((chunk) => ({
    url: `${cdnBase}/${publicPath}/${chunk}`,
    fromUrl,
    isInline: false,
  }));
}

/**
 * Module federation manifests.
 *
 * Two generations, both handled: the modern `@module-federation/enhanced` shape
 * with `exposes[].assets.js.{sync,async}` and `metaData.publicPath`, and the
 * older Vmok shape with a region-keyed CDN map.
 */
export class ModuleFederationManifestPlugin implements Plugin {
  readonly name = 'ModuleFederationManifestPlugin';
  private readonly manifestPath = /baseHost\s*\+\s*["']([^"']+manifest\.json)["']/g;
  private readonly anyManifest = /["']([^"']*manifest\.json)["']/g;
  private readonly baseHostTernary = /baseHost\s*=[^;?]+\?"[^"]+":"([^"]+)"/;
  private readonly baseHostSimple = /baseHost\s*=\s*["'](https?:\/\/[^"']+)["']/;

  /**
   * Hosts whose CDN origin differs from the site origin.
   *
   * A manifest is served from the CDN, but its chunks live on the site origin
   * (or vice versa), so neither path can simply be resolved against the CDN URL.
   */
  private readonly cdnToOrigin: Record<string, string> = {
    'sf3-cn.feishucdn.com': 'https://www.feishu.cn',
    'sf1-scmcdn-cn.feishucdn.com': 'https://www.feishu.cn',
    'lf3-cn.feishucdn.com': 'https://www.feishu.cn',
    'lf1-cdn.feishucdn.com': 'https://www.feishu.cn',
  };

  precheck(input: AnalyzeInput): boolean {
    const text = textOf(input);
    if (input.contentType === 'json') {
      // The `metaData` key plus either `publicPath` or `region` identifies a
      // federation manifest; a plain `{metaData}` object would be ambiguous.
      return (
        text.includes('"metaData"') &&
        (text.includes('"publicPath"') || text.includes('"region"'))
      );
    }
    if (input.contentType === 'js') {
      return new RegExp(this.manifestPath.source).test(text);
    }
    return false;
  }

  analyze(input: AnalyzeInput): PluginResult {
    if (input.contentType === 'json') {
      return this.analyzeManifest(input);
    }
    return this.analyzeJs(input);
  }

  private analyzeManifest(input: AnalyzeInput): PluginResult {
    const builder = new ResultBuilder(input.sourceUrl);
    const content = textOf(input);

    // Modern shape first.
    let manifest: StandardMfManifest;
    try {
      manifest = JSON.parse(content) as StandardMfManifest;
    } catch {
      return {};
    }

    if (Array.isArray(manifest.exposes) && manifest.exposes.length > 0) {
      let publicPath = manifest.metaData?.publicPath ?? '/';
      if (publicPath === '') {
        publicPath = '/';
      }
      if (!publicPath.endsWith('/')) {
        publicPath += '/';
      }

      for (const expose of manifest.exposes) {
        for (const chunk of [
          ...(expose.assets?.js?.sync ?? []),
          ...(expose.assets?.js?.async ?? []),
        ]) {
          if (chunk !== '') {
            // The chunk path is relative to publicPath, not to the manifest.
            builder.add(publicPath + chunk);
          }
        }
      }
      return builder.build();
    }

    // Older Vmok shape.
    const vmok = parseVmokManifest(content);
    if (vmok.chunks.length === 0) {
      return {};
    }
    for (const resource of constructVmokChunkUrls(vmok, input.sourceUrl)) {
      builder.addAbsolute(resource.url);
    }
    return builder.build();
  }

  private analyzeJs(input: AnalyzeInput): PluginResult {
    const builder = new ResultBuilder(input.sourceUrl);
    const content = textOf(input);

    // Prefer the `baseHost + "path/manifest.json"` form, which means the host is
    // resolved at runtime; fall back to any quoted manifest path.
    let manifestPath = findAllFirst(this.manifestPath, content)[0] ?? '';
    if (manifestPath === '') {
      manifestPath = findAllFirst(this.anyManifest, content)[0] ?? '';
    }
    if (manifestPath === '') {
      return {};
    }

    const baseHost = this.extractBaseHost(content);
    let manifestUrl: string;
    if (baseHost !== '') {
      manifestUrl = `${baseHost}/${manifestPath.replace(/^\/+/, '')}`;
    } else {
      manifestUrl = this.constructManifestUrl(input.sourceUrl, manifestPath);
    }
    if (manifestUrl === '') {
      return {};
    }

    builder.addIntermediate({
      url: manifestUrl,
      type: 'json',
      fromUrl: input.sourceUrl,
    });
    return builder.build();
  }

  /**
   * Read `baseHost` out of the bundle.
   *
   * The ternary form is a build-time environment switch
   * (`baseHost = location.hostname.includes("boe") ? "https://staging" : "https://prod"`),
   * and the production branch is the second alternative, which is the one worth
   * following.
   */
  private extractBaseHost(content: string): string {
    const ternary = this.baseHostTernary.exec(content);
    if (ternary?.[1] !== undefined && ternary[1] !== '') {
      return ternary[1];
    }
    const simple = this.baseHostSimple.exec(content);
    if (simple?.[1] !== undefined && simple[1] !== '') {
      return simple[1];
    }
    return '';
  }

  /** Rebuild a manifest URL, mapping known CDN hosts back to their site origin. */
  private constructManifestUrl(sourceUrl: string, manifestPath: string): string {
    const trimmed = manifestPath.replace(/^\/+/, '');

    const idx = sourceUrl.indexOf('://');
    let sourceOrigin = '';
    if (idx !== -1) {
      const rest = sourceUrl.slice(idx + 3);
      const slashIdx = rest.indexOf('/');
      if (slashIdx !== -1) {
        sourceOrigin = sourceUrl.slice(0, idx + 3 + slashIdx);
      }
    }

    const mapped = this.cdnToOrigin[sourceOrigin];
    if (mapped !== undefined) {
      return `${mapped}/${trimmed}`;
    }
    return `${sourceOrigin}/${trimmed}`;
  }
}

/** EMP (`@efox/emp`): `emp.json` federation manifest. */
export class EmpPlugin implements Plugin {
  readonly name = 'EmpPlugin';

  precheck(input: AnalyzeInput): boolean {
    const text = textOf(input);
    if (input.contentType === 'js' || input.contentType === 'html') {
      return containsAny(text, ['__MFE_REMOTE__', 'emp.json', '__EMP__']);
    }
    if (input.contentType === 'json') {
      return text.includes('"federatedModules"');
    }
    return false;
  }

  analyze(input: AnalyzeInput): PluginResult {
    const builder = new ResultBuilder(input.sourceUrl);

    // An `emp.json` body enumerates the runtime entry and every exposed module's
    // chunks — names that appear in no other file.
    if (input.contentType === 'json') {
      interface EmpExpose {
        chunks?: string[];
      }
      interface EmpConfig {
        federatedModules?: Array<{
          remote?: string;
          entry?: string;
          exposes?: Record<string, EmpExpose[]>;
        }>;
      }

      let config: EmpConfig;
      try {
        config = JSON.parse(textOf(input)) as EmpConfig;
      } catch {
        return {};
      }

      for (const federation of config.federatedModules ?? []) {
        if (federation.entry) {
          builder.add(federation.entry);
        }
        for (const exposeList of Object.values(federation.exposes ?? {})) {
          for (const expose of exposeList) {
            for (const chunk of expose.chunks ?? []) {
              builder.add(chunk);
            }
          }
        }
      }
      return builder.build();
    }

    // Otherwise probe the conventional manifest locations. The filename changed
    // between EMP versions, so both are tried.
    const origin = originOf(input.sourceUrl);
    if (origin !== '') {
      for (const name of ['emp.json', 'emp-stats.json']) {
        builder.addIntermediate({
          url: `${origin}/${name}`,
          type: 'json',
          fromUrl: input.sourceUrl,
        });
      }
    }
    return builder.build();
  }
}

export { forEachMatch };