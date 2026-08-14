import type { TransportPlugin } from '@vigilkit/plugin-sdk';
import { WebSocketTransport, type WebSocketTransportOptions } from './ws-transport.js';

export function wsTransportPlugin(options?: WebSocketTransportOptions): TransportPlugin {
  return {
    type: 'transport',
    id: 'ws',
    schemes: ['ws', 'wss'],
    create(url: string): WebSocketTransport {
      return new WebSocketTransport(url, options);
    },
  };
}
