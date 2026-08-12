import type {
  Demuxer,
  DemuxerEvent,
  DemuxerPlugin,
  MediaErrorInfo,
  Transport,
  TransportEvent,
  TransportPlugin,
} from '@vigilkit/plugin-sdk';
import { mediaError } from './errors.js';

const CONNECT_TIMEOUT_MS = 10_000;

export interface TransportPipelineCallbacks {
  /** Demuxer events are forwarded to the engine (decoder/scheduler wiring). */
  demuxerEvent(event: DemuxerEvent): void;
  /** The transport reported 'open'. */
  onOpen(): void;
  /** The transport reported 'close' (clean or while connecting). */
  onClose(): void;
  /** The transport reported an 'error'. */
  onError(info: MediaErrorInfo): void;
}

/**
 * Owns the transport → demuxer pipeline lifecycle: plugin create (with a
 * create() failure surfaced as a media error instead of an escaped throw),
 * event wiring, the connect-timeout, and teardown. The engine keeps one
 * instance and drives it from the transport path; state-dependent decisions
 * (open vs close-while-connecting) are delegated back through callbacks.
 */
export class TransportPipeline {
  private transport: Transport | null = null;
  private demuxer: Demuxer | null = null;
  private transportUnsub: (() => void) | null = null;
  private demuxerUnsub: (() => void) | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly callbacks: TransportPipelineCallbacks) {}

  /** Creates and connects the transport + demuxer. False when a create() threw
   * (the error has already been surfaced through onError). */
  start(transportPlugin: TransportPlugin, demuxerPlugin: DemuxerPlugin, url: string): boolean {
    const transport = this.tryCreate(
      () => transportPlugin.create(url),
      'TRANSPORT',
      'transport create failed',
    );
    if (transport === undefined) {
      return false;
    }
    const demuxer = this.tryCreate(
      () => demuxerPlugin.create(),
      'UNSUPPORTED',
      'demuxer create failed',
    );
    if (demuxer === undefined) {
      transport.close();
      return false;
    }
    this.transport = transport;
    this.demuxer = demuxer;
    this.transportUnsub = transport.onEvent((event) => this.handleTransportEvent(event));
    this.demuxerUnsub = demuxer.onEvent((event) => this.callbacks.demuxerEvent(event));
    this.startConnectTimeout();
    transport.connect();
    return true;
  }

  /** Stops the pipeline: clears the timeout, unsubscribes, closes the pair. */
  teardown(): void {
    this.clearConnectTimeout();
    this.unsubscribeAll();
    this.transport?.close();
    this.transport = null;
    this.demuxer?.close();
    this.demuxer = null;
  }

  private handleTransportEvent(event: TransportEvent): void {
    switch (event.type) {
      case 'open':
        this.clearConnectTimeout();
        this.callbacks.onOpen();
        break;
      case 'data':
        this.demuxer?.push(event.data);
        break;
      case 'close':
        this.clearConnectTimeout();
        this.callbacks.onClose();
        break;
      case 'error':
        this.callbacks.onError(event.error);
        break;
    }
  }

  private tryCreate<T>(
    factory: () => T,
    code: 'TRANSPORT' | 'UNSUPPORTED',
    fallback: string,
  ): T | undefined {
    try {
      return factory();
    } catch (error) {
      this.callbacks.onError(mediaError(code, error instanceof Error ? error.message : fallback));
      return undefined;
    }
  }

  private startConnectTimeout(): void {
    this.clearConnectTimeout();
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      this.callbacks.onError(mediaError('TRANSPORT', 'connect timeout'));
    }, CONNECT_TIMEOUT_MS);
  }

  private clearConnectTimeout(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private unsubscribeAll(): void {
    this.transportUnsub?.();
    this.transportUnsub = null;
    this.demuxerUnsub?.();
    this.demuxerUnsub = null;
  }
}
