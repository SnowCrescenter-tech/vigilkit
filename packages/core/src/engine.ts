import { PluginRegistry } from '@vigilkit/plugin-sdk';
import type {
  Demuxer,
  DemuxerEvent,
  DemuxerPlugin,
  MediaErrorInfo,
  SourcePlugin,
  StreamMetadata,
  Transport,
  TransportEvent,
} from '@vigilkit/plugin-sdk';
import { buildDecoder } from './decoder-chain.js';
import { nativeDecoderFactory } from './decoder.js';
import type { VideoCodecDecoder, VideoDecoderFactory } from './decoder.js';
import { Scheduler } from './scheduler.js';
import { SourceBranch } from './source-branch.js';
import { Emitter } from './events.js';
import { mediaError } from './errors.js';
import { asMediaError, schemeOf } from './plugin-utils.js';
import type { Player, PlayerEvents, PlayerOptions, PlayerState, PlayerStats } from './types.js';

const PUMP_INTERVAL_MS = 30;

/**
 * Internal orchestrator: resolves plugins, then drives either the
 * transport → demuxer pipeline or a source plugin pipeline, and owns the
 * scheduler pump. v0.1/v0.2 use a setInterval pump; rAF is a later step.
 */
export class Engine implements Player {
  private readonly options: PlayerOptions;
  private readonly registry = new PluginRegistry();
  private readonly emitter = new Emitter<PlayerEvents>();
  private readonly decoder: VideoCodecDecoder;
  private readonly scheduler: Scheduler;
  private readonly errors: MediaErrorInfo[] = [];
  private transport: Transport | null = null;
  private transportUnsub: (() => void) | null = null;
  private demuxer: Demuxer | null = null;
  private demuxerUnsub: (() => void) | null = null;
  private readonly sourceBranch = new SourceBranch();
  private pumpId: ReturnType<typeof setInterval> | null = null;
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
    // Minimal v0.2 behavior: pause stops the pump and state only. The source
    // keeps fetching/buffering (e.g. HLS) and resume is not yet in scope.
    this.stopPump();
    this.setState('paused');
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.stopPump();
    this.unsubscribeAll();
    this.transport?.close();
    this.transport = null;
    this.demuxer?.close();
    this.demuxer = null;
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
    const transport = transportPlugin.create(this.options.url);
    const demuxer = demuxerPlugin.create();
    this.transport = transport;
    this.demuxer = demuxer;
    this.transportUnsub = transport.onEvent((event) => this.handleTransportEvent(event));
    this.demuxerUnsub = demuxer.onEvent((event) => this.handleDemuxerEvent(event));
    transport.connect();
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
    const byDemuxer = this.registry.getSource(this.options.demuxer);
    if (byDemuxer !== undefined) {
      return byDemuxer;
    }
    return this.registry.getSource(scheme);
  }

  private handleTransportEvent(event: TransportEvent): void {
    switch (event.type) {
      case 'open':
        if (this.state === 'connecting') {
          this.setState('playing');
        }
        break;
      case 'data':
        this.demuxer?.push(event.data);
        break;
      case 'close':
        // v0.1: a clean close without a prior error ends the stream silently.
        break;
      case 'error':
        this.handleError(event.error);
        break;
    }
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
    this.unsubscribeAll();
    this.transport?.close();
    this.transport = null;
    this.demuxer?.close();
    this.demuxer = null;
    this.sourceBranch.disconnect();
    this.setState('error');
    this.emitter.emit('error', info);
  }

  private unsubscribeAll(): void {
    this.transportUnsub?.();
    this.transportUnsub = null;
    this.demuxerUnsub?.();
    this.demuxerUnsub = null;
  }

  private setState(state: PlayerState): void {
    this.state = state;
    this.emitter.emit('stats', this.getStats());
  }

  private startPump(): void {
    if (this.pumpId !== null) {
      return;
    }
    this.pumpId = setInterval(() => {
      this.scheduler.tick();
      this.emitter.emit('stats', this.getStats());
    }, PUMP_INTERVAL_MS);
  }

  private stopPump(): void {
    if (this.pumpId !== null) {
      clearInterval(this.pumpId);
      this.pumpId = null;
    }
  }
}
