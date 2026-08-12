import { PluginCollisionError } from './errors.js';
import type { DemuxerPlugin, Plugin, TransportPlugin } from './types.js';

const norm = (value: string): string => value.toLowerCase();

export class PluginRegistry {
  private readonly byId = new Map<string, Plugin>();
  private readonly schemeOwners = new Map<string, Plugin>();
  private readonly mimeOwners = new Map<string, DemuxerPlugin>();

  register(plugin: Plugin): void {
    const id = plugin.id;
    if (this.byId.has(id)) {
      throw new PluginCollisionError(`plugin id "${id}" is already registered`);
    }
    for (const scheme of plugin.schemes) {
      const key = norm(scheme);
      const owner = this.schemeOwners.get(key);
      if (owner !== undefined) {
        throw new PluginCollisionError(`scheme "${scheme}" is already claimed by plugin "${owner.id}"`);
      }
    }
    if (plugin.type === 'demuxer') {
      for (const mime of plugin.mimeTypes) {
        const key = norm(mime);
        const owner = this.mimeOwners.get(key);
        if (owner !== undefined) {
          throw new PluginCollisionError(`mimeType "${mime}" is already claimed by plugin "${owner.id}"`);
        }
      }
    }
    this.byId.set(id, plugin);
    for (const scheme of plugin.schemes) {
      this.schemeOwners.set(norm(scheme), plugin);
    }
    if (plugin.type === 'demuxer') {
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
    if (plugin.type === 'demuxer') {
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
    return this.mimeOwners.get(key);
  }

  list(): readonly Plugin[] {
    return [...this.byId.values()];
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }
}