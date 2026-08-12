import type { SourcePlugin } from '@vigilkit/plugin-sdk';
import { WhepSource } from './whep-source.js';

/**
 * WHEP (WebRTC-HTTP Egress Protocol) media source plugin. A WHEP resource URL
 * is any `http(s)` endpoint, so the plugin claims no URL schemes — `http` /
 * `https` belong to the HLS source. The engine resolves this plugin by its
 * source id `whep` (`demuxer: 'whep'`).
 */
export function whepSourcePlugin(): SourcePlugin {
  return {
    type: 'source',
    id: 'whep',
    mimeTypes: ['application/whep'],
    schemes: [],
    create(url, options) {
      return new WhepSource(url, options);
    },
  };
}
