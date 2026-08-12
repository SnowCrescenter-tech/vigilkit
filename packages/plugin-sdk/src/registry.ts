import { PluginCollisionError } from './errors.js';
import type { DemuxerPlugin, Plugin, SourcePlugin, TransportPlugin } from './types.js';

const norm = (value: string): string => value.toLowerCase();

const claimsMime = (plugin: Plugin): plugin is DemuxerPlugin | SourcePlugin =>
  plugin.type === 'demuxer' || plugin.type === 'source';

export class PluginRegistry {
  private readonly byId = new Map<string, Plugin>();
  private readonly schemeOwners = new Map<string, Plugin>();
  private readonly mimeOwners = new Map<string, DemuxerPlugin | SourcePlugin>();

  register(plugin: Plugin): void {
    const id = plugin.id;
    const existing = this.byId.get(id);
    if (existing !== undefined) {
      throw new PluginCollisionError(
        `plugin id "${id}" is already registered as a ${existing.type}`,
      );
    }
    for (const scheme of plugin.schemes) {
      const key = norm(scheme);
      const owner = this.schemeOwners.get(key);
      if (owner !== undefined) {
        throw new PluginCollisionError(
          `scheme "${scheme}" is already claimed by ${owner.type} plugin "${owner.id}"`,
        );
      }
    }
    if (claimsMime(plugin)) {
      for (const mime of plugin.mimeTypes) {
        const key = norm(mime);
        const owner = this.mimeOwners.get(key);
        if (owner !== undefined) {
          throw new PluginCollisionError(
            `mimeType "${mime}" is already claimed by ${owner.type} plugin "${owner.id}"; ` +
              `cannot register ${plugin.type} plugin "${plugin.id}"`,
          );
        }
      }
    }
    this.byId.set(id, plugin);
    for (const scheme of plugin.schemes) {
      this.schemeOwners.set(norm(scheme), plugin);
    }
    if (claimsMime(plugin)) {
      for (const mime of plugin.mimeTypes) {
        this.mimeOwners.set(norm(mime), plugin);
      }
    }
  }

  unregister(id: string): boolean {
    const plugin = this.byId.get(id);
    if (plugin === undefined) {
      return false;
    }
    this.byId.delete(id);
    for (const scheme of plugin.schemes) {
      this.schemeOwners.delete(norm(scheme));
    }
    if (claimsMime(plugin)) {
      for (const mime of plugin.mimeTypes) {
        this.mimeOwners.delete(norm(mime));
      }
    }
    return true;
  }

  getTransport(scheme: string): TransportPlugin | undefined {
    const plugin = this.schemeOwners.get(norm(scheme));
    return plugin?.type === 'transport' ? plugin : undefined;
  }

  getDemuxer(schemeOrMime: string): DemuxerPlugin | undefined {
    const key = norm(schemeOrMime);
    const byScheme = this.schemeOwners.get(key);
    if (byScheme?.type === 'demuxer') {
      return byScheme;
    }
    const byMime = this.mimeOwners.get(key);
    return byMime?.type === 'demuxer' ? byMime : undefined;
  }

  getSource(idOrMime: string): SourcePlugin | undefined {
    const key = norm(idOrMime);
    for (const plugin of this.byId.values()) {
      if (plugin.type === 'source' && norm(plugin.id) === key) {
        return plugin;
      }
    }
    const byMime = this.mimeOwners.get(key);
    return byMime?.type === 'source' ? byMime : undefined;
  }

  list(): readonly Plugin[] {
    return [...this.byId.values()];
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }
}
