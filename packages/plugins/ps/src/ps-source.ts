import type { DemuxerEvent, MediaSource, SourceOptions } from '@vigilkit/plugin-sdk';
import { PsDemuxer } from './ps-demuxer.js';

/**
 * Minimal structural view of the WebSocket API the source relies on, so the
 * browser global and test doubles both satisfy it.
 */
export interface PsWebSocketLike {
  binaryType: string;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  close(code?: number, reason?: string): void;
}

export interface PsSourceOptions extends SourceOptions {
  /** Injectable fetch for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable WebSocket constructor for tests. Defaults to globalThis.WebSocket. */
  wsImpl?: new (url: string) => PsWebSocketLike;
}

type Listener = (event: DemuxerEvent) => void;

/**
 * PS media source for GB/T 28181 media channels. For `http(s)` URLs it
 * streams the response body through a `PsDemuxer`; for `ws(s)` URLs it feeds
 * incoming binary WebSocket frames (each frame is an RTP-payload or PS
 * segment — the demuxer resyncs across frame boundaries). Emits the SDK
 * `DemuxerEvent` union.
 */
export class PsSource implements MediaSource {
  private readonly url: string;
  private readonly options: Required<Pick<PsSourceOptions, 'fetchImpl'>> & { wsImpl?: new (url: string) => PsWebSocketLike } & PsSourceOptions;
  private readonly demuxer = new PsDemuxer();
  private readonly listeners = new Set<Listener>();
  private controller: AbortController | null = null;
  private ws: PsWebSocketLike | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private stopped = false;

  constructor(url: string, options: PsSourceOptions = {}) {
    this.url = url;
    this.options = {
      ...options,
      fetchImpl: options.fetchImpl ?? globalThis.fetch.bind(globalThis),
      wsImpl: options.wsImpl ?? (globalThis as { WebSocket?: new (url: string) => PsWebSocketLike }).WebSocket,
    };
    this.demuxer.onEvent((event) => this.dispatch(event));
  }

  start(): void {
    if (this.stopped) return;
    const scheme = this.scheme();
    if (scheme === 'ws' || scheme === 'wss') {
      this.openWebSocket();
      return;
    }
    void this.streamHttp().catch((error) => {
      if (this.stopped) return;
      this.dispatch({ type: 'error', error: { code: 'DEMUX', message: errorMessage(error) } });
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.controller !== null) this.controller.abort();
    if (this.ws !== null) {
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    if (this.reader !== null) {
      void this.reader.cancel().catch(() => {});
      this.reader = null;
    }
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private scheme(): string {
    try {
      return new URL(this.url).protocol.replace(/:$/, '').toLowerCase();
    } catch {
      return '';
    }
  }

  private async streamHttp(): Promise<void> {
    const scheme = this.scheme();
    if (scheme !== 'http' && scheme !== 'https') {
      throw new Error(`unsupported URL scheme '${this.url}'`);
    }
    this.controller = new AbortController();
    const response = await this.options.fetchImpl(this.url, { signal: this.controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${this.url}`);
    }
    if (response.body === null) {
      throw new Error(`no response body for ${this.url}`);
    }
    this.reader = response.body.getReader();
    for (;;) {
      const { done, value } = await this.reader.read();
      if (done) break;
      if (value !== undefined) this.demuxer.push(value);
    }
    this.reader = null;
    this.demuxer.flush();
  }

  private openWebSocket(): void {
    const Ws = this.options.wsImpl;
    if (Ws === undefined) {
      this.dispatch({
        type: 'error',
        error: { code: 'UNSUPPORTED', message: 'WebSocket is not available in this runtime' },
      });
      return;
    }
    const ws = new Ws(this.url);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (event) => {
      if (this.stopped) return;
      const data = event.data;
      if (data instanceof ArrayBuffer) {
        this.demuxer.push(new Uint8Array(data));
      } else if (data instanceof Uint8Array) {
        this.demuxer.push(data);
      } else if (ArrayBuffer.isView(data)) {
        this.demuxer.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
        void data.arrayBuffer().then((buffer) => {
          if (!this.stopped) this.demuxer.push(new Uint8Array(buffer));
        });
      }
    };
    ws.onerror = () => {
      if (this.stopped) return;
      this.dispatch({ type: 'error', error: { code: 'TRANSPORT', message: 'WebSocket error' } });
    };
    ws.onclose = () => {
      if (this.stopped) return;
      this.demuxer.flush();
    };
  }

  private dispatch(event: DemuxerEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
