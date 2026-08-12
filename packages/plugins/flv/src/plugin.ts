import type { DemuxerPlugin } from '@vigilkit/plugin-sdk';
import { FlvDemuxer } from './flv-demuxer.js';

/** Creates the `@vigilkit/plugin-flv` demuxer plugin for the plugin registry. */
export function flvDemuxerPlugin(): DemuxerPlugin {
  return {
    type: 'demuxer',
    id: 'flv',
    mimeTypes: ['video/x-flv'],
    schemes: ['flv'],
    create: () => new FlvDemuxer(),
  };
}
