// Self-contained HEVC soft-decode demo (mode: ?source=hevc).
//
// The engine's demuxer/source resolution has no HEVC source plugin yet, so the
// demo bypasses createPlayer: it fetches the Annex-B fixture itself, splits it
// on start codes, and feeds the chunks to a HevcSoftDecoder running in a Vite
// module worker. The worker copies I420 planes into a transferable buffer; the
// main thread builds the VideoFrame and draws it. If the worker path fails
// (e.g. no VideoFrame in the worker), the main thread decodes directly via
// the soft factory.

import type { RendererSurface, SoftVideoDecoderFactory, VideoCodecDecoder } from 'vigilkit';
import { createHevcSoftFactory } from '@vigilkit/plugin-hevc-wasm';
import type { HevcWorkerOutboundMessage } from './hevc-worker';

export interface ErrorInfo {
  code: string;
  message: string;
}

export interface HevcDemo {
  /** Live counters; main.ts exposes the same object as window.__vigilkit.hevc. */
  readonly stats: { framesDecoded: number; errors: number };
  start(): Promise<void>;
  stop(): void;
}

const HEVC_URL = `http://${location.host}/hevc/paired_fields.hevc`;

/** Vendored libde265 artifacts, served by server.mjs under /vendor (not bundled). */
const VENDOR_ESM_URL = '/vendor/libde265-esm.js';
const VENDOR_WASM_URL = '/vendor/libde265.wasm';
/** Pinned SHA-256 of libde265.wasm (vendor/README.md); verified before instantiation. */
const WASM_SHA256 = '440c6bbc60af222e72141583ce583423b0b8dd3fe0b53e823fa2e99988eca5b8';

const FRAME_INTERVAL_US = 40_000; // 25 fps pacing for raw-stream chunk timestamps
const STATE_STOPPED = 'stopped / 已断开';

function requiredElement<T extends HTMLElement>(id: string, ctor: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof ctor)) {
    throw new Error(`#${id}: expected a <${ctor.name}> element in the DOM`);
  }
  return el;
}

/** Splits an Annex-B stream into NAL-aligned chunks on 00 00 01 / 00 00 00 01 start codes. */
function splitAnnexB(bytes: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let start = 0;
  for (let i = 2; i < bytes.length - 1; i += 1) {
    const isStartCode =
      bytes[i] === 1 && bytes[i - 1] === 0 && bytes[i - 2] === 0 && (i < 3 || bytes[i - 3] === 0);
    if (isStartCode) {
      if (i > start) {
        chunks.push(bytes.subarray(start, i));
      }
      start = i;
    }
  }
  if (start < bytes.length) {
    chunks.push(bytes.subarray(start));
  }
  return chunks;
}

export function createHevcDemo(renderer: RendererSurface, onError: (info: ErrorInfo) => void): HevcDemo {
  const statusEl = requiredElement('status', HTMLSpanElement);
  const fpsEl = requiredElement('fps', HTMLSpanElement);
  const framesEl = requiredElement('frames', HTMLSpanElement);

  const stats = { framesDecoded: 0, errors: 0 };
  let worker: Worker | null = null;
  let decoder: VideoCodecDecoder | null = null;
  let frameTimes: number[] = [];

  function pushFrameTime(now: number): void {
    frameTimes.push(now);
    const cutoff = now - 1000;
    while (frameTimes.length > 0 && (frameTimes[0] ?? 0) < cutoff) {
      frameTimes.shift();
    }
  }

  function updateReadout(): void {
    fpsEl.textContent = `${frameTimes.length}`;
    framesEl.textContent = `${stats.framesDecoded} frames`;
  }

  /** Feeds the fixture to the worker; resolves true when the worker path completed with frames. */
  function runWorkerPath(chunks: Uint8Array[]): Promise<boolean> {
    return new Promise((resolve) => {
      const instance = new Worker(new URL('./hevc-worker.ts', import.meta.url), { type: 'module' });
      worker = instance;
      let ready = false;
      let flushed = false;
      let gotFrame = false;
      let chunkIndex = 0;

      const finish = (ok: boolean): void => {
        instance.terminate();
        worker = null;
        resolve(ok);
      };

      const feedNext = (): void => {
        if (!ready || flushed) {
          return;
        }
        const chunk = chunks[chunkIndex];
        if (chunk !== undefined) {
          instance.postMessage({ type: 'chunk', chunk });
          chunkIndex += 1;
        } else {
          flushed = true;
          instance.postMessage({ type: 'flush' });
        }
      };

      instance.onmessage = (event: MessageEvent<HevcWorkerOutboundMessage>) => {
        const message = event.data;
        switch (message.type) {
          case 'ready':
            ready = true;
            feedNext();
            break;
          case 'frame': {
            gotFrame = true;
            const frame = new VideoFrame(message.frameBuffer, {
              format: 'I420',
              codedWidth: message.width,
              codedHeight: message.height,
              timestamp: message.ptsUs,
              layout: message.layout,
            });
            renderer.draw(frame);
            stats.framesDecoded += 1;
            pushFrameTime(performance.now());
            updateReadout();
            break;
          }
          case 'error':
            stats.errors += 1;
            onError({ code: message.code, message: `hevc worker: ${message.message}` });
            break;
          case 'done':
            finish(gotFrame);
            break;
          case 'init-error':
            onError({ code: 'UNSUPPORTED', message: `hevc worker init: ${message.message}` });
            finish(false);
            break;
        }
      };
      instance.onerror = (event) => {
        onError({ code: 'UNSUPPORTED', message: `hevc worker error: ${event.message}` });
        finish(false);
      };

      instance.postMessage({ type: 'init' });
    });
  }

  /** Fallback: decode on the main thread through the soft factory. */
  async function runMainPath(chunks: Uint8Array[], softFactory: SoftVideoDecoderFactory): Promise<void> {
    const instance = softFactory.create();
    decoder = instance;
    instance.onError((info) => {
      stats.errors += 1;
      onError(info);
    });
    instance.onOutput((frame) => {
      renderer.draw(frame);
      stats.framesDecoded += 1;
      pushFrameTime(performance.now());
      updateReadout();
    });
    let chunkIndex = 0;
    for (const chunk of chunks) {
      instance.decode({ type: 'delta', timestamp: chunkIndex * FRAME_INTERVAL_US, data: chunk });
      chunkIndex += 1;
      await new Promise((resolve) => setTimeout(resolve, 0)); // keep the UI responsive
    }
    await instance.flush();
    statusEl.textContent = `hevc: done (main) — ${stats.framesDecoded} frames`;
  }

  async function start(): Promise<void> {
    if (typeof VideoFrame === 'undefined') {
      onError({
        code: 'UNSUPPORTED',
        message: 'WebCodecs VideoFrame unavailable; the HEVC demo needs a WebCodecs-capable browser',
      });
      return;
    }
    statusEl.textContent = 'hevc: loading…';
    stats.framesDecoded = 0;
    stats.errors = 0;
    frameTimes.length = 0;
    try {
      const response = await fetch(HEVC_URL);
      if (!response.ok) {
        throw new Error(`failed to fetch ${HEVC_URL} (${response.status})`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      // Prove the pinned wasm load up front; the factory is reused by the
      // main-thread fallback path.
      const softFactory = await createHevcSoftFactory({
        esmUrl: VENDOR_ESM_URL,
        wasmUrl: VENDOR_WASM_URL,
        sha256: WASM_SHA256,
      });
      const chunks = splitAnnexB(bytes);
      const workerOk = await runWorkerPath(chunks);
      if (!workerOk) {
        console.warn('[vigilkit] hevc worker path failed; falling back to main-thread decode');
        await runMainPath(chunks, softFactory);
      } else {
        statusEl.textContent = `hevc: done (worker) — ${stats.framesDecoded} frames`;
      }
    } catch (err) {
      onError({ code: 'TRANSPORT', message: err instanceof Error ? err.message : String(err) });
      statusEl.textContent = 'error / 错误';
    }
  }

  function stop(): void {
    if (worker !== null) {
      worker.terminate();
      worker = null;
    }
    if (decoder !== null) {
      decoder.close();
      decoder = null;
    }
    statusEl.textContent = STATE_STOPPED;
    fpsEl.textContent = '-';
    framesEl.textContent = '0';
  }

  return { stats, start, stop };
}
