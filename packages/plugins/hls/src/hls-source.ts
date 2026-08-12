import type { DemuxerEvent, MediaSource, SourceOptions } from '@vigilkit/plugin-sdk';
import { hlsError } from './errors.js';
import { parseM3u8 } from './m3u8/parser.js';
import type { Playlist, Segment } from './m3u8/types.js';
import { TsDemuxer } from './ts/ts-demuxer.js';

const DEFAULT_RELOAD_MS = 3000;

interface HlsSourceOptions extends SourceOptions {
  /** Injectable fetch for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Live playlist reload period in ms (tests inject small values). */
  reloadIntervalMs?: number;
}

/**
 * Self-contained HLS media source. Fetches the master playlist, selects a
 * variant, loads the media playlist and streams segments through a
 * `TsDemuxer`, emitting the SDK `DemuxerEvent` union.
 */
export class HlsSource implements MediaSource {
  private readonly url: string;
  private readonly options: Required<Pick<HlsSourceOptions, 'fetchImpl' | 'variant' | 'reloadIntervalMs'>> & HlsSourceOptions;
  private readonly demuxer = new TsDemuxer();
  private readonly listeners = new Set<(event: DemuxerEvent) => void>();
  private aborted = false;
  private stopped = false;
  private controller: AbortController | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private loadedMediaSequence = -1;

  constructor(url: string, options: HlsSourceOptions = {}) {
    this.url = url;
    this.options = {
      fetchImpl: options.fetchImpl ?? globalThis.fetch.bind(globalThis),
      variant: options.variant ?? 'lowest',
      reloadIntervalMs: options.reloadIntervalMs ?? DEFAULT_RELOAD_MS,
      ...options,
    };
    this.demuxer.onEvent((event) => this.dispatch(event));
  }

  start(): void {
    if (this.stopped) return;
    void this.bootstrap().catch((error) => {
      if (this.stopped) return;
      this.dispatch({ type: 'error', error: { code: 'DEMUX', message: errorMessage(error) } });
    });
  }

  stop(): void {
    this.stopped = true;
    this.aborted = true;
    if (this.controller !== null) this.controller.abort();
    if (this.reloadTimer !== null) clearTimeout(this.reloadTimer);
    this.reloadTimer = null;
  }

  onEvent(listener: (event: DemuxerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async bootstrap(): Promise<void> {
    const text = await this.fetchText(this.url);
    const playlist = parseM3u8(text);
    const mediaUrl =
      playlist.type === 'master' ? resolveUrl(this.url, this.selectVariant(playlist).uri) : this.url;
    await this.loadMedia(mediaUrl, true);
  }

  private selectVariant(playlist: Playlist): { uri: string } {
    const variants = playlist.variants;
    if (variants.length === 0) throw hlsError('DEMUX', 'master playlist has no variants');
    if (typeof this.options.variant === 'number') {
      const chosen = variants[this.options.variant];
      if (chosen === undefined) throw hlsError('DEMUX', 'variant index out of range');
      return chosen;
    }
    let best = variants[0];
    for (const candidate of variants) {
      if (best === undefined || candidate === undefined) continue;
      const bestBandwidth = best.bandwidth ?? 0;
      const candidateBandwidth = candidate.bandwidth ?? 0;
      const better = this.options.variant === 'lowest' ? candidateBandwidth < bestBandwidth : candidateBandwidth > bestBandwidth;
      if (better) best = candidate;
    }
    if (best === undefined) throw hlsError('DEMUX', 'no variant selected');
    return best;
  }

  private async loadMedia(mediaUrl: string, first: boolean): Promise<void> {
    if (this.stopped) return;
    const text = await this.fetchText(mediaUrl);
    const playlist = parseM3u8(text);
    await this.streamSegments(mediaUrl, playlist);
    if (!playlist.endList && !this.stopped) {
      this.scheduleReload(mediaUrl);
    } else if (first && playlist.live) {
      this.scheduleReload(mediaUrl);
    }
  }

  private scheduleReload(mediaUrl: string): void {
    if (this.reloadTimer !== null) return;
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      void this.loadMedia(mediaUrl, false).catch((error) => {
        if (this.stopped) return;
        this.dispatch({ type: 'error', error: { code: 'DEMUX', message: errorMessage(error) } });
      });
    }, this.options.reloadIntervalMs);
  }

  private async streamSegments(mediaUrl: string, playlist: Playlist): Promise<void> {
    const segments = playlist.segments;
    for (let i = 0; i < segments.length; i++) {
      if (this.stopped) return;
      const segment = segments[i];
      if (segment === undefined) continue;
      const sequenceNumber = playlist.mediaSequence + i;
      if (sequenceNumber < this.loadedMediaSequence) continue;
      this.loadedMediaSequence = sequenceNumber;
      const segmentUrl = resolveUrl(mediaUrl, segment.uri);
      const bytes = await this.fetchBytes(segmentUrl, segment);
      this.demuxer.push(bytes);
    }
    this.demuxer.flush();
  }

  private async fetchText(url: string): Promise<string> {
    const response = await this.options.fetchImpl(url, { signal: this.signal() });
    if (!response.ok) throw hlsError('DEMUX', `HTTP ${response.status} for ${url}`);
    return response.text();
  }

  private async fetchBytes(url: string, segment: Segment): Promise<Uint8Array> {
    const headers: Record<string, string> = {};
    if (segment.byterange !== undefined) {
      const { length, offset } = segment.byterange;
      if (!(length > 0 && offset >= 0)) {
        throw hlsError('DEMUX', `invalid byterange ${length}@${offset}`);
      }
      headers['Range'] = `bytes=${offset}-${offset + length - 1}`;
    }
    const response = await this.options.fetchImpl(url, { signal: this.signal(), headers });
    if (!response.ok) throw hlsError('DEMUX', `HTTP ${response.status} for ${url}`);
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  private signal(): AbortSignal | undefined {
    if (this.controller === null) this.controller = new AbortController();
    return this.controller.signal;
  }

  private dispatch(event: DemuxerEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function resolveUrl(base: string, uri: string): string {
  let resolved: URL;
  try {
    resolved = new URL(uri, base);
  } catch {
    throw hlsError('DEMUX', `cannot resolve segment URI ${uri} against ${base}`);
  }
  // Only http(s) segment/variant URIs are acceptable; a playlist must not be
  // able to redirect the client at other schemes (javascript:, data:, file:).
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    throw hlsError('DEMUX', `unsupported URL scheme ${resolved.protocol}`);
  }
  return resolved.href;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
