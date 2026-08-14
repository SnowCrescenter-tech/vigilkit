import type { SourcePlugin } from '@vigilkit/plugin-sdk';
import { PsSource } from './ps-source.js';

/**
 * GB/T 28181 PS media source plugin: handles `http(s)` URLs serving MPEG
 * Program Stream content and `ws(s)` URLs delivering PS (e.g. relayed RTP
 * payloads) over WebSocket. The engine resolves it when `demuxer: 'ps'` (or
 * the URL scheme matches).
 */
export function psSourcePlugin(): SourcePlugin {
  return {
    type: 'source',
    id: 'ps',
    mimeTypes: ['video/mp2p'],
    schemes: ['http', 'https', 'ws', 'wss'],
    create(url, options) {
      return new PsSource(url, options ?? {});
    },
  };
}
