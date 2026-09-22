/**
 * Plugin registry.
 *
 * Plugin registry, extended with an opt-out list so
 * a caller can run a focused subset of plugins.
 */

import type { Plugin } from './types.js';

/** Holds the plugins a scan will run. */
export class PluginRegistry {
  private readonly plugins: Plugin[] = [];
  private readonly byName = new Map<string, Plugin>();

  /** Add a plugin. A duplicate name replaces the earlier entry. */
  register(plugin: Plugin): this {
    const existing = this.byName.get(plugin.name);
    if (existing) {
      const idx = this.plugins.indexOf(existing);
      if (idx >= 0) {
        this.plugins[idx] = plugin;
      }
      this.byName.set(plugin.name, plugin);
      return this;
    }
    this.plugins.push(plugin);
    this.byName.set(plugin.name, plugin);
    return this;
  }

  /** Add several plugins. */
  registerAll(plugins: readonly Plugin[]): this {
    for (const plugin of plugins) {
      this.register(plugin);
    }
    return this;
  }

  /** All registered plugins, in registration order. */
  getAll(): readonly Plugin[] {
    return this.plugins;
  }

  /** Look up a plugin by name. */
  get(name: string): Plugin | undefined {
    return this.byName.get(name);
  }

  /** Registered plugin names. */
  names(): string[] {
    return this.plugins.map((p) => p.name);
  }

  /** Number of registered plugins. */
  get size(): number {
    return this.plugins.length;
  }

  /** Remove a plugin by name. Returns whether anything was removed. */
  remove(name: string): boolean {
    const plugin = this.byName.get(name);
    if (!plugin) {
      return false;
    }
    const idx = this.plugins.indexOf(plugin);
    if (idx >= 0) {
      this.plugins.splice(idx, 1);
    }
    this.byName.delete(name);
    return true;
  }

  /**
   * Build a registry containing only the named plugins.
   *
   * Throws on an unknown name rather than silently ignoring it, so a typo in a
   * caller's plugin list surfaces immediately instead of producing a scan that
   * mysteriously finds nothing.
   */
  select(names: readonly string[]): PluginRegistry {
    const selected = new PluginRegistry();
    for (const name of names) {
      const plugin = this.byName.get(name);
      if (!plugin) {
        throw new Error(
          `unknown plugin: ${name} (available: ${this.names().join(', ')})`,
        );
      }
      selected.register(plugin);
    }
    return selected;
  }

  /**
   * Build a registry with the named plugins removed.
   *
   * Unknown names are ignored here: excluding a plugin that is not present is a
   * no-op rather than an error, which makes the exclusion list safe to keep
   * stable as the plugin set evolves.
   */
  exclude(names: readonly string[]): PluginRegistry {
    const excluded = new Set(names);
    const remaining = new PluginRegistry();
    for (const plugin of this.plugins) {
      if (!excluded.has(plugin.name)) {
        remaining.register(plugin);
      }
    }
    return remaining;
  }
}