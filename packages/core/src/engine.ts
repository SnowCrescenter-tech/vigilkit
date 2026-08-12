import { PluginRegistry } from '@vigilkit/plugin-sdk';
import type {
  Demuxer,
  DemuxerEvent,
  MediaErrorInfo,
  StreamMetadata,
  Transport,
  TransportEvent,
} from '@vigilkit/plugin-sdk';
import { nativeDecoderFactory, VideoDecoderWrapper } from './decoder.js';
import type { VideoDecoderFactory } from './decoder.js';
import { Scheduler } from './scheduler.js';
import { Emitter } from './events.js';
import { mediaError } from './errors.js';
import { asMediaError, schemeOf } from './plugin-utils.js';
import type {
  Player,
  PlayerEvents,
  PlayerOptions,
  PlayerState,
  PlayerStats,
} from './types.js';

const PUMP_INTERVAL_MS = 30;

/**
 * Internal orchestrator: resolves plugins by scheme, connects the transport,
 * pipes demuxer events into the pipeline and drives the scheduler pump.
 * v0.1 uses a setInterval pump (~30ms); rAF integration is a later
 * optimization.
 */
export class Engine implements Player {
  private readonly options: PlayerOptions;
  private readonly registry = new PluginRegistry();
  private readonly emitter = new Emitter<PlayerEvents>();
  private readonly decoder: VideoDecoderWrapper;
  private readonly scheduler: Scheduler;
  private readonly errors: MediaErrorInfo[] = [];
  private transport: Transport | null = null;
  private transportUnsub: (() => void) | null = null;
  private demuxer: Demuxer | null = null;
  private demuxerUnsub: (() => void) | null = null;
  private pumpId: ReturnType<typeof setInterval> | null = null;
  private state: PlayerState = 'idle';
  private destroyed = false;
  private pluginsRegistered = false;
  private metadata: StreamMetadata | null = null;

  constructor(options: PlayerOptions, decoderFactory?: VideoDecoderFactory) {
    this.options = options;
    this.decoder = new VideoDecoderWrapper(decoderFactory ?? nativeDecoderFactory);
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
    this.stopPump();
    this.setState('paused');
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.stopPump();
    this.transportUnsub?.();
    this.transportUnsub = null;
    this.demuxerUnsub?.();
    this.demuxerUnsub = null;
    this.transport?.close();
    this.transport = null;
    this.demuxer?.close();
    this.demuxer = null;
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
    const transportPlugin = this.registry.getTransport(scheme);
    if (transportPlugin === undefined) {
      this.handleError(mediaError('UNSUPPORTED', `no transport plugin for url scheme "${scheme}"`));
      return;
    }
    const demuxerPlugin = this.registry.getDemuxer(this.options.demuxer);
    if (demuxerPlugin === undefined) {
      this.handleError(mediaError('UNSUPPORTED', `no demuxer plugin for "${this.options.demuxer}"`));
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
    this.transportUnsub?.();
    this.transportUnsub = null;
    this.demuxerUnsub?.();
    this.demuxerUnsub = null;
    this.transport?.close();
    this.transport = null;
    this.demuxer?.close();
    this.demuxer = null;
    this.setState('error');
    this.emitter.emit('error', info);
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
