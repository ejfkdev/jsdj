/**
 * Plugin collection.
 *
 * `createDefaultRegistry()` assembles the built-in plugin set, in the
 * same order. Order does not affect which plugins run — they all run over every
 * applicable input — but it does determine the order of `jsDetails` provenance
 * entries, so it is kept stable.
 *
 * Every plugin is exported individually so a caller can compose a focused
 * registry (only the Next.js plugin, say) or call one directly and skip the
 * pipeline.
 */

import { PluginRegistry } from '../extractor/registry.js';
import type { Plugin } from '../extractor/types.js';

import { HtmlScriptPlugin, extractInlineScripts } from './html-script.js';
import {
  DynamicImportPlugin,
  EsmImportPlugin,
  ScriptCreatePlugin,
  SourceMapPlugin,
  UniversalUrlPlugin,
  resolveSourceMapUrl,
  setSourceMapRecorder,
} from './patterns.js';
import {
  ModernJsPlugin,
  NuxtPlugin,
  RequireJsPlugin,
  SvelteKitPlugin,
  TrunkPlugin,
  VitePlugin,
  extractBraceBalancedJson,
} from './frameworks.js';
import { WebpackPlugin, isLikelyChunkHash } from './webpack.js';
import { NextJsPlugin } from './nextjs.js';
import {
  GarfishPlugin,
  IcestarkPlugin,
  MicroAppPlugin,
  QiankunPlugin,
  WujiePlugin,
  looksLikeMicroAppEntry,
} from './micro-apps.js';
import { HtmlPivotPlugin } from './html-pivot.js';
import {
  EmpPlugin,
  ModuleFederationManifestPlugin,
  ModuleFederationPlugin,
  constructVmokChunkUrls,
  parseVmokManifest,
} from './federation.js';
import {
  HelMicroPlugin,
  UrlPatternPlugin,
  isHelMicroMetadata,
} from './helmicro.js';

export {
  HtmlScriptPlugin,
  extractInlineScripts,
  DynamicImportPlugin,
  EsmImportPlugin,
  ScriptCreatePlugin,
  SourceMapPlugin,
  UniversalUrlPlugin,
  resolveSourceMapUrl,
  setSourceMapRecorder,
  ModernJsPlugin,
  NuxtPlugin,
  RequireJsPlugin,
  SvelteKitPlugin,
  TrunkPlugin,
  VitePlugin,
  extractBraceBalancedJson,
  WebpackPlugin,
  isLikelyChunkHash,
  NextJsPlugin,
  GarfishPlugin,
  IcestarkPlugin,
  MicroAppPlugin,
  QiankunPlugin,
  WujiePlugin,
  looksLikeMicroAppEntry,
  HtmlPivotPlugin,
  EmpPlugin,
  ModuleFederationManifestPlugin,
  ModuleFederationPlugin,
  constructVmokChunkUrls,
  parseVmokManifest,
  HelMicroPlugin,
  UrlPatternPlugin,
  isHelMicroMetadata,
};

export type { Plugin, PluginRegistry };

/**
 * Build the registry containing every built-in plugin.
 *
 * Order matters: HTML and core loading patterns first,
 * then framework-specific detectors, then the micro-frontend entry plugins, and
 * finally the generic fallbacks. The fallbacks are last by convention only — they
 * are not gated on earlier plugins having failed, since a page can mix several.
 */
export function createDefaultRegistry(): PluginRegistry {
  const registry = new PluginRegistry();

  // Core loading patterns.
  registry.register(new HtmlScriptPlugin());
  registry.register(new DynamicImportPlugin());
  registry.register(new WebpackPlugin());
  registry.register(new NextJsPlugin());
  registry.register(new NuxtPlugin());
  registry.register(new VitePlugin());
  registry.register(new SvelteKitPlugin());
  registry.register(new RequireJsPlugin());
  registry.register(new ModuleFederationPlugin());
  registry.register(new ModuleFederationManifestPlugin());
  registry.register(new HelMicroPlugin());
  registry.register(new EsmImportPlugin());
  registry.register(new ScriptCreatePlugin());
  registry.register(new ModernJsPlugin());
  registry.register(new UrlPatternPlugin());
  registry.register(new SourceMapPlugin());

  // Bundler-specific manifests.
  registry.register(new UmiJsPlaceholder());
  registry.register(new TrunkPlugin());

  // Micro-frontend sub-application entries.
  registry.register(new QiankunPlugin());
  registry.register(new GarfishPlugin());
  registry.register(new MicroAppPlugin());
  registry.register(new WujiePlugin());
  registry.register(new IcestarkPlugin());

  // Multi-page and iframe entry discovery.
  registry.register(new HtmlPivotPlugin());

  // EMP federation manifests.
  registry.register(new EmpPlugin());

  // Generic fallback extraction.
  registry.register(new UniversalUrlPlugin());

  return registry;
}

/**
 * Placeholder for the UmiJS plugin.
 *
 * A `UmiJSPlugin` is reserved here. Its pattern set is the modern.js route
 * manifest shape with Umi's `b.p` publicPath, which `ModernJsPlugin` already
 * covers. The slot keeps the registry's plugin count and ordering stable, so an
 * Umi-specific detector can be dropped in later without touching the assembly.
 */
class UmiJsPlaceholder implements Plugin {
  readonly name = 'UmiJSPlugin';

  precheck(): boolean {
    return false;
  }

  analyze(): Record<string, never> {
    return {};
  }
}

/** Names of every plugin the default registry can contain. */
export const BUILTIN_PLUGIN_NAMES = [
  'HTMLScriptPlugin',
  'DynamicImportPlugin',
  'WebpackPlugin',
  'NextJSPlugin',
  'NuxtJSPlugin',
  'VitePlugin',
  'SvelteKitPlugin',
  'RequireJSPlugin',
  'ModuleFederationPlugin',
  'ModuleFederationManifestPlugin',
  'HelMicroPlugin',
  'ESMImportPlugin',
  'ScriptCreatePlugin',
  'ModernJSPlugin',
  'URLPatternPlugin',
  'SourceMapPlugin',
  'UmiJSPlugin',
  'TrunkPlugin',
  'QiankunPlugin',
  'GarfishPlugin',
  'MicroAppPlugin',
  'WujiePlugin',
  'IcestarkPlugin',
  'HTMLPivotPlugin',
  'EmpPlugin',
  'UniversalURLPlugin',
] as const;