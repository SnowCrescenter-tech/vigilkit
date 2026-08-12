import type { SourcePlugin } from '@vigilkit/plugin-sdk';
import { HlsSource } from './hls-source.js';

/**
 * HLS media source plugin: handles `http(s)` URLs with m3u8 content. The
 * engine resolves it when `demuxer: 'hls'` (or the URL scheme matches).
 */
export function hlsSourcePlugin(): SourcePlugin {
  return {
    type: 'source',
    id: 'hls',
    mimeTypes: ['application/vnd.apple.mpegurl', 'application/x-mpegURL'],
    schemes: ['http', 'https'],
    create(url, options) {
      return new HlsSource(url, options ?? {});
    },
  };
}
