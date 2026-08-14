import { describe, expect, it } from 'vitest';
import { PluginRegistry } from '@vigilkit/plugin-sdk';
import { WebSocketTransport, wsTransportPlugin, type WebSocketConstructor } from '../src/index.js';

interface RecordingSocket {
  binaryType: string;
  readyState: number;
  onopen: (() => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  close(): void;
  triggerOpen(): void;
  triggerClose(code: number): void;
}

function makeRecordingWebSocket(): WebSocketConstructor {
  const instances: RecordingSocket[] = [];
  const RecordingWebSocket = class {
    static instances: RecordingSocket[] = instances;
    binaryType = 'blob';
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(url: string) {
      void url;
      instances.push(this);
    }
    close(): void {
      this.readyState = 3;
    }
    triggerOpen(): void {
      this.onopen?.();
    }
    triggerClose(code: number): void {
      this.readyState = 3;
      this.onclose?.({ code });
    }
  };
  return RecordingWebSocket as unknown as WebSocketConstructor;
}

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

  it('forwards reconnect options to the transports it creates', () => {
    const WebSocketCtor = makeRecordingWebSocket();
    const plugin = wsTransportPlugin({ reconnect: true, WebSocketCtor });
    const transport = plugin.create('ws://localhost:9000') as WebSocketTransport;

    transport.connect();
    const socket = (WebSocketCtor as unknown as { instances: RecordingSocket[] }).instances[0];
    expect(socket).toBeDefined();
    socket?.triggerOpen();
    expect(transport.state).toBe('open');

    socket?.triggerClose(1006);
    expect(transport.state).toBe('reconnecting'); // reconnect option took effect

    transport.close(); // cancel the pending reconnect timer
    expect(transport.state).toBe('closed');
  });

  it('resolves through the PluginRegistry by the "ws" scheme', () => {
    const registry = new PluginRegistry();
    registry.register(wsTransportPlugin());

    const plugin = registry.getTransport('ws');
    expect(plugin).toBeDefined();
    expect(plugin?.id).toBe('ws');
  });
});
