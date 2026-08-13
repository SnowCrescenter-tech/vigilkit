import type { DemuxerEvent, MediaSource, SourceOptions } from '@vigilkit/plugin-sdk';
import { decryptSegment as decryptAes128, importAesKey, parseIv, sequenceNumberToIv } from './aes-cbc.js';
import type { Bytes } from './aes-cbc.js';
import { hlsError } from './errors.js';
import { parseM3u8 } from './m3u8/parser.js';
import type { KeyInfo, Playlist, Segment } from './m3u8/types.js';
import { TsDemuxer } from './ts/ts-demuxer.js';

const DEFAULT_RELOAD_MS = 3000;
const DEFAULT_MAX_BUFFERED_SEGMENTS = 120;

export interface HlsSourceOptions extends SourceOptions {
  /** Injectable fetch for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Live playlist reload period in ms (tests inject small values). */
  reloadIntervalMs?: number;
  /**
   * Injectable Web Crypto `subtle` for tests. Defaults to
   * `globalThis.crypto.subtle` (browsers and Node 22 both expose it).
   */
  subtle?: SubtleCrypto;
  /**
   * Live catch-up window: the maximum number of NEW segments the source
   * fetches in a single reload pass. A live playlist that bursts (post-stall
   * catch-up, or a server retaining deep history) then fills in over the next
   * reloads instead of fetching an unbounded tail. VOD playlists are never
   * capped (there is no reload to continue from). Defaults to 120.
   */
  maxBufferedSegments?: number;
}

/**
 * Self-contained HLS media source. Fetches the master playlist, selects a
 * variant, loads the media playlist and streams segments through a
 * `TsDemuxer`, emitting the SDK `DemuxerEvent` union.
 */
export class HlsSource implements MediaSource {
  private readonly url: string;
  private readonly options: Required<
    Pick<HlsSourceOptions, 'fetchImpl' | 'variant' | 'reloadIntervalMs' | 'subtle' | 'maxBufferedSegments'>
  > &
    HlsSourceOptions;
  private readonly demuxer = new TsDemuxer();
  private readonly listeners = new Set<(event: DemuxerEvent) => void>();
  private readonly keyCache = new Map<string, CryptoKey>();
  private aborted = false;
  private stopped = false;
  private controller: AbortController | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private loadedMediaSequence = -1;
  /**
   * Lowest media sequence the source will still fetch. Advances to each
   * reloaded playlist's media sequence, so a sliding live window prunes stale
   * segments from the source's awareness (they are never re-fetched).
   */
  private sequenceWindowStart = -1;

  constructor(url: string, options: HlsSourceOptions = {}) {
    this.url = url;
    this.options = {
      ...options,
      fetchImpl: options.fetchImpl ?? globalThis.fetch.bind(globalThis),
      variant: options.variant ?? 'lowest',
      reloadIntervalMs: options.reloadIntervalMs ?? DEFAULT_RELOAD_MS,
      maxBufferedSegments: options.maxBufferedSegments ?? DEFAULT_MAX_BUFFERED_SEGMENTS,
      subtle: options.subtle ?? globalThis.crypto.subtle,
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
    // A reloaded live playlist slides its media sequence forward: prune the
    // source's awareness of anything before the new edge so a deep-history
    // server cannot keep the fetch window anchored to stale segments.
    this.sequenceWindowStart = Math.max(this.sequenceWindowStart, playlist.mediaSequence);
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
    // Live catch-up window: never fetch more than `maxBufferedSegments` NEW
    // segments in a single pass, so a burst playlist (post-stall catch-up, or
    // a server retaining deep history) fills in over subsequent reloads
    // instead of fetching an unbounded tail. VOD plays every segment (there
    // is no reload to continue from) so the window is not applied there.
    const liveWindow = playlist.live ? this.options.maxBufferedSegments : Number.POSITIVE_INFINITY;
    let fetchedInPass = 0;
    for (let i = 0; i < segments.length; i++) {
      if (this.stopped) return;
      const segment = segments[i];
      if (segment === undefined) continue;
      const sequenceNumber = playlist.mediaSequence + i;
      if (sequenceNumber < this.sequenceWindowStart) continue; // stale: pruned by the sliding edge
      if (sequenceNumber <= this.loadedMediaSequence) continue; // already appended
      if (fetchedInPass >= liveWindow) break; // window full; resume on the next reload
      this.loadedMediaSequence = sequenceNumber;
      fetchedInPass++;
      const segmentUrl = resolveUrl(mediaUrl, segment.uri);
      let bytes = await this.fetchBytes(segmentUrl, segment);
      if (segment.key !== undefined && segment.key.method === 'AES-128') {
        bytes = await this.decryptSegmentBytes(mediaUrl, segment.key, sequenceNumber, bytes);
      }
      this.demuxer.push(bytes);
    }
    this.demuxer.flush();
  }

  /**
   * Fetches the key (once per key URL), imports it and AES-128-CBC decrypts
   * the segment. The IV is the segment's explicit `IV` attribute, or the
   * media sequence as a 128-bit big-endian integer when absent (RFC 8216
   * §5.2). Any failure — key fetch, import, decrypt — is a DEMUX error that
   * tears the source down.
   */
  private async decryptSegmentBytes(
    mediaUrl: string,
    key: KeyInfo,
    sequenceNumber: number,
    ciphertext: Bytes,
  ): Promise<Bytes> {
    const keyUri = key.uri;
    if (keyUri === undefined) {
      throw hlsError('DEMUX', 'AES-128 segment without a key URI');
    }
    const keyUrl = resolveUrl(mediaUrl, keyUri);
    let cryptoKey = this.keyCache.get(keyUrl);
    if (cryptoKey === undefined) {
      const keyBytes = await this.fetchBytes(keyUrl);
      cryptoKey = await importAesKey(this.options.subtle, keyUrl, keyBytes);
      this.keyCache.set(keyUrl, cryptoKey);
    }
    const iv = key.iv !== undefined ? parseIv(key.iv) : sequenceNumberToIv(sequenceNumber);
    return decryptAes128(this.options.subtle, cryptoKey, iv, ciphertext, `segment ${sequenceNumber}`);
  }

  private async fetchText(url: string): Promise<string> {
    const response = await this.options.fetchImpl(url, { signal: this.signal() });
    if (!response.ok) throw hlsError('DEMUX', `HTTP ${response.status} for ${url}`);
    return response.text();
  }

  private async fetchBytes(url: string, segment?: Segment): Promise<Bytes> {
    const headers: Record<string, string> = {};
    if (segment?.byterange !== undefined) {
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
