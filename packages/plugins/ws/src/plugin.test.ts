import { describe, expect, it } from 'vitest';
import { PluginRegistry } from '@vigilkit/plugin-sdk';
import { WebSocketTransport, wsTransportPlugin } from '../src/index.js';

describe('wsTransportPlugin', () => {
  it('returns a transport plugin with id "ws" and schemes ws/wss', () => {
    const plugin = wsTransportPlugin();

    expect(plugin.type).toBe('transport');
    expect(plugin.id).toBe('ws');
    expect([...plugin.schemes]).toEqual(['ws', 'wss']);
  });

  it('create() returns a WebSocketTransport for the given url', () => {
    const plugin = wsTransportPlugin();

    expect(plugin.create('ws://localhost:9000')).toBeInstanceOf(WebSocketTransport);
  });

  it('resolves through the PluginRegistry by the "ws" scheme', () => {
    const registry = new PluginRegistry();
    registry.register(wsTransportPlugin());

    const plugin = registry.getTransport('ws');
    expect(plugin).toBeDefined();
    expect(plugin?.id).toBe('ws');
  });
});
