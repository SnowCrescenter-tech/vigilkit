import { describe, expect, it } from 'vitest';
import { PluginRegistry } from './registry.js';
import { PluginCollisionError } from './errors.js';
import type { DemuxerPlugin, TransportPlugin } from './types.js';

function demuxerPlugin(id: string, mimeTypes: string[], schemes: string[]): DemuxerPlugin {
  return {
    type: 'demuxer',
    id,
    mimeTypes,
    schemes,
    create() {
      return {
        push() {},
        flush() {},
        onEvent() {
          return () => {};
        },
        close() {},
      };
    },
  };
}

function transportPlugin(id: string, schemes: string[]): TransportPlugin {
  return {
    type: 'transport',
    id,
    schemes,
    create() {
      return {
        connect() {},
        close() {},
        onEvent() {
          return () => {};
        },
      };
    },
  };
}

describe('PluginRegistry', () => {
  it('registers a unique demuxer and transport; list() contains both', () => {
    const registry = new PluginRegistry();
    registry.register(demuxerPlugin('d1', ['video/x-flv'], ['flv']));
    registry.register(transportPlugin('t1', ['ws', 'wss']));
    expect(registry.list().map((p) => p.id).sort()).toEqual(['d1', 't1']);
  });

  it('throws PluginCollisionError on duplicate id, message mentions the id', () => {
    const registry = new PluginRegistry();
    registry.register(demuxerPlugin('dup', ['video/x-flv'], ['flv']));
    expect(() => registry.register(transportPlugin('dup', ['ws']))).toThrow(PluginCollisionError);
    expect(() => registry.register(transportPlugin('dup', ['ws']))).toThrow(/dup/);
  });

  it('throws PluginCollisionError when two demuxers share a scheme', () => {
    const registry = new PluginRegistry();
    registry.register(demuxerPlugin('d1', ['video/x-flv'], ['flv']));
    expect(() => registry.register(demuxerPlugin('d2', ['video/mp4'], ['flv']))).toThrow(
      PluginCollisionError,
    );
  });

  it('throws PluginCollisionError when two demuxers share a mimeType', () => {
    const registry = new PluginRegistry();
    registry.register(demuxerPlugin('d1', ['video/x-flv'], ['flv']));
    expect(() => registry.register(demuxerPlugin('d2', ['video/x-flv'], ['mp4']))).toThrow(
      PluginCollisionError,
    );
  });

  it('matches schemes case-insensitively', () => {
    const registry = new PluginRegistry();
    registry.register(transportPlugin('t1', ['WS', 'WSS']));
    expect(registry.getTransport('ws')?.id).toBe('t1');
  });

  it('unregisters an existing id (true) and an unknown id (false)', () => {
    const registry = new PluginRegistry();
    registry.register(transportPlugin('t1', ['ws']));
    expect(registry.has('t1')).toBe(true);
    expect(registry.unregister('t1')).toBe(true);
    expect(registry.has('t1')).toBe(false);
    expect(registry.unregister('t1')).toBe(false);
  });

  it('resolves demuxer by scheme and by mimeType; unknown returns undefined', () => {
    const registry = new PluginRegistry();
    registry.register(demuxerPlugin('d1', ['video/x-flv'], ['flv']));
    expect(registry.getDemuxer('flv')?.id).toBe('d1');
    expect(registry.getDemuxer('video/x-flv')?.id).toBe('d1');
    expect(registry.getDemuxer('nope')).toBeUndefined();
  });

  it('throws PluginCollisionError whose code is PLUGIN_COLLISION', () => {
    const registry = new PluginRegistry();
    registry.register(demuxerPlugin('d1', ['video/x-flv'], ['flv']));
    let thrown: unknown;
    try {
      registry.register(demuxerPlugin('d1', ['video/mp4'], ['mp4']));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PluginCollisionError);
    expect(thrown).toMatchObject({ code: 'PLUGIN_COLLISION' });
  });
});