import { PluginRegistry } from '@vigilkit/plugin-sdk';
import type {
  DemuxerEvent,
  DemuxerPlugin,
  MediaErrorInfo,
  SourcePlugin,
  StreamMetadata,
} from '@vigilkit/plugin-sdk';
import { buildDecoder } from './decoder-chain.js';
import { nativeDecoderFactory } from './decoder.js';
import type { VideoCodecDecoder, VideoDecoderFactory } from './decoder.js';
import { Scheduler } from './scheduler.js';
import { SourceBranch } from './source-branch.js';
import { TransportPipeline } from './transport-pipeline.js';
import { Emitter } from './events.js';
import { mediaError } from './errors.js';
import { asMediaError, schemeOf } from './plugin-utils.js';
import { Pump } from './pump.js';
import type { Player, PlayerEvents, PlayerOptions, PlayerState, PlayerStats } from './types.js';

/**
 * Orchestrator: resolves plugins, drives either the transport → demuxer
 * pipeline or a source plugin pipeline, and owns the scheduler pump
 * (rAF in browsers, interval fallback elsewhere).
 */
export class Engine implements Player {
  private readonly options: PlayerOptions;
  private readonly registry = new PluginRegistry();
  private readonly emitter = new Emitter<PlayerEvents>();
  private readonly decoder: VideoCodecDecoder;
  private readonly scheduler: Scheduler;
  private readonly pump: Pump;
  private readonly errors: MediaErrorInfo[] = [];
  private readonly pipeline: TransportPipeline;
  private readonly sourceBranch = new SourceBranch();
  private state: PlayerState = 'idle';
  private destroyed = false;
  private pluginsRegistered = false;
  private metadata: StreamMetadata | null = null;

  constructor(options: PlayerOptions, decoderFactory?: VideoDecoderFactory) {
    this.options = options;
    this.decoder = buildDecoder({
      createWebCodecs: decoderFactory ?? nativeDecoderFactory,
      softFactory: options.softDecoder?.factory,
      forceSoft: options.forceSoft,
    });
    this.decoder.onError((info) => this.handleError(info));
    this.scheduler = new Scheduler(this.decoder, options.renderer, {
      onFrame: (frame, ptsUs) => this.emitter.emit('frame', { frame, ptsUs }),
      onError: (info) => this.handleError(info),
    });
    this.pump = new Pump(() => this.scheduler.tick(), { drivers: options.pump });
    this.pipeline = new TransportPipeline({
      demuxerEvent: (event) => this.handleDemuxerEvent(event),
      onOpen: () => {
        if (this.state === 'connecting') {
          this.setState('playing');
        }
      },
      onClose: () => this.handlePipelineClose(),
      onError: (info) => this.handleError(info),
    });
  }

  play(): void {
    if (this.destroyed) {
      return;
    }
    if (this.state === 'paused') {
      this.startPump();
      this.setState('playing');
      return;
    }
    if (this.state === 'idle' || this.state === 'error' || this.state === 'stopped') {
      this.start();
    }
  }

  pause(): void {
    if (this.state !== 'playing' && this.state !== 'connecting') {
      return;
    }
    // v0.2: pause stops the pump and state only; the source keeps buffering.
    this.stopPump();
    this.setState('paused');
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.stopPump();
    this.pump.destroy();
    this.pipeline.teardown();
    this.sourceBranch.disconnect();
    this.decoder.close();
    this.options.renderer?.destroy();
    this.state = 'stopped';
  }

  on<K extends keyof PlayerEvents>(type: K, cb: (payload: PlayerEvents[K]) => void): () => void {
    return this.emitter.on(type, cb);
  }

  getStats(): PlayerStats {
    const s = this.scheduler.getStats();
    return {
      state: this.state,
      framesDecoded: s.framesDecoded,
      framesDropped: s.framesDropped,
      fps: s.fps,
      errors: [...this.errors],
    };
  }

  private start(): void {
    if (this.state === 'connecting' || this.state === 'playing') {
      return;
    }
    this.setState('connecting');
    if (!this.pluginsRegistered) {
      for (const plugin of this.options.plugins) {
        try {
          this.registry.register(plugin);
        } catch (error) {
          this.handleError(asMediaError(error));
          return;
        }
      }
      this.pluginsRegistered = true;
    }
    const scheme = schemeOf(this.options.url);
    if (scheme === null) {
      this.handleError(mediaError('UNSUPPORTED', `cannot parse url "${this.options.url}"`));
      return;
    }
    const demuxerPlugin = this.registry.getDemuxer(this.options.demuxer);
    if (demuxerPlugin !== undefined) {
      this.startWithDemuxer(demuxerPlugin, scheme);
      return;
    }
    const sourcePlugin = this.resolveSourcePlugin(scheme);
    if (sourcePlugin === undefined) {
      this.handleError(
        mediaError('UNSUPPORTED', `no demuxer or source plugin for "${this.options.demuxer}"`),
      );
      return;
    }
    this.startWithSource(sourcePlugin);
  }

  private startWithDemuxer(demuxerPlugin: DemuxerPlugin, scheme: string): void {
    const transportPlugin = this.registry.getTransport(scheme);
    if (transportPlugin === undefined) {
      this.handleError(mediaError('UNSUPPORTED', `no transport plugin for url scheme "${scheme}"`));
      return;
    }
    if (!this.pipeline.start(transportPlugin, demuxerPlugin, this.options.url)) {
      // A plugin create() failed; the pipeline already surfaced the error.
      return;
    }
    this.startPump();
  }

  private startWithSource(sourcePlugin: SourcePlugin): void {
    try {
      this.sourceBranch.connect(
        sourcePlugin,
        this.options.url,
        this.options.sourceOptions,
        (event) => this.handleDemuxerEvent(event),
      );
    } catch (error) {
      this.sourceBranch.disconnect();
      this.handleError(asMediaError(error));
      return;
    }
    // A source plugin has no transport 'open' event: start() succeeding means
    // the stream is live.
    this.setState('playing');
    this.startPump();
  }

  private resolveSourcePlugin(scheme: string): SourcePlugin | undefined {
    return this.registry.getSource(this.options.demuxer) ?? this.registry.getSource(scheme);
  }

  /** A transport 'close': connect failure while connecting, clean stop otherwise. */
  private handlePipelineClose(): void {
    if (this.state === 'connecting') {
      // Closed before the handshake completed: treat it as a failed connect,
      // not a clean end-of-stream.
      this.handleError(mediaError('TRANSPORT', 'transport closed before connecting'));
      return;
    }
    this.stopPump();
    this.pipeline.teardown();
    this.setState('stopped');
  }

  private handleDemuxerEvent(event: DemuxerEvent): void {
    switch (event.type) {
      case 'metadata':
        this.metadata = event.metadata;
        break;
      case 'sequence-header':
        this.decoder.configure(event.config);
        break;
      case 'video':
        this.scheduler.enqueue(event.chunk);
        break;
      case 'audio':
        // v0.1 is video-only.
        break;
      case 'error':
        this.handleError(event.error);
        break;
    }
  }

  private handleError(info: MediaErrorInfo): void {
    if (this.state === 'error') {
      return;
    }
    this.errors.push(info);
    this.stopPump();
    this.pipeline.teardown();
    this.sourceBranch.disconnect();
    this.setState('error');
    this.emitter.emit('error', info);
  }

  private setState(state: PlayerState): void {
    this.state = state;
    this.emitter.emit('stats', this.getStats());
  }

  private startPump(): void {
    this.pump.start();
    this.options.renderer?.resize();
  }

  private stopPump(): void {
    this.pump.stop();
  }
}
