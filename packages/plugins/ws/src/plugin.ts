import type { TransportPlugin } from '@vigilkit/plugin-sdk';
import { WebSocketTransport } from './ws-transport.js';

export function wsTransportPlugin(): TransportPlugin {
  return {
    type: 'transport',
    id: 'ws',
    schemes: ['ws', 'wss'],
    create(url: string): WebSocketTransport {
      return new WebSocketTransport(url);
    },
  };
}
