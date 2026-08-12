// HEVC soft-decode worker (Vite module worker, see main.ts).
//
// Proves the worker path end-to-end: the vendored libde265 ESM is loaded with
// a runtime dynamic import (the file lives outside the Vite bundle), its wasm
// binary is fetched from /vendor and SHA-256 pinned via crypto.subtle, and a
// HevcSoftDecoder instance decodes Annex-B chunks posted from the main thread.
//
// VideoFrame split: libde265 picture construction in `HevcSoftDecoder` builds
// a VideoFrame on globalThis — which may not exist in every worker. Instead
// the worker copies the I420 planes out of each decoded frame into a
// transferable ArrayBuffer and the MAIN thread constructs the VideoFrame and
// draws it. If VideoFrame is missing in the worker, init reports failure and
// main.ts falls back to main-thread decoding.

import { HevcSoftDecoder } from '@vigilkit/plugin-hevc-wasm';
import type { Libde265Module } from '@vigilkit/plugin-hevc-wasm';

/** Pinned SHA-256 of examples/basic/vendor/libde265.wasm (see vendor/README.md). */
const WASM_SHA256 = '440c6bbc60af222e72141583ce583423b0b8dd3fe0b53e823fa2e99988eca5b8';
/** Pinned SHA-256 of libde265-esm.js (vendor/libde265.sha256). */
const ESM_SHA256 = '3d431114c87569ff71b3a8f434c3a67ba8239fbef18cea80e2f22e5049d7b0ab';
/** Runtime URL, served by server.mjs — NOT part of the Vite bundle. */
const VENDOR_ESM_URL = '/vendor/libde265-esm.js';
const VENDOR_WASM_URL = '/vendor/libde265.wasm';

const FRAME_INTERVAL_US = 40_000; // 25 fps pacing for chunk timestamps

// ---- message protocol (shared with main.ts) ---------------------------------

export type HevcWorkerInboundMessage =
  | { type: 'init' }
  | { type: 'chunk'; chunk: Uint8Array }
  | { type: 'flush' }
  | { type: 'close' };

export type HevcWorkerOutboundMessage =
  | { type: 'ready' }
  | { type: 'init-error'; message: string }
  | { type: 'frame'; ptsUs: number; frameBuffer: ArrayBuffer; width: number; height: number; layout: { offset: number; stride: number }[] }
  | { type: 'error'; code: string; message: string }
  | { type: 'done' };

// ---- minimal worker-scope typing --------------------------------------------
//
// The shared tsconfig compiles with the DOM lib (Window `self`); cast the
// global scope to the two members the worker actually uses so the file
// typechecks without dragging in lib.webworker (which clashes with lib.dom).

interface WorkerScope {
  onmessage: ((event: MessageEvent<HevcWorkerInboundMessage>) => void) | null;
  postMessage(message: HevcWorkerOutboundMessage, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

// ---- decoder plumbing --------------------------------------------------------

let decoder: HevcSoftDecoder | null = null;
let chunkIndex = 0;
/** Serializes async copyTo work so frames are posted in decode order. */
let outputChain: Promise<void> = Promise.resolve();

function post(message: HevcWorkerOutboundMessage, transfer?: Transferable[]): void {
  scope.postMessage(message, transfer);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function loadLibde265Module(): Promise<Libde265Module> {
  const wasmResponse = await fetch(VENDOR_WASM_URL);
  if (!wasmResponse.ok) {
    throw new Error(`failed to fetch wasm from ${VENDOR_WASM_URL}`);
  }
  const wasmBytes = new Uint8Array(await wasmResponse.arrayBuffer());
  const wasmDigest = await crypto.subtle.digest('SHA-256', wasmBytes);
  if (hex(new Uint8Array(wasmDigest)) !== WASM_SHA256) {
    throw new Error('libde265 wasm sha256 mismatch');
  }
  // Verify the ESM wrapper bytes before any code from it executes; then load
  // from a blob URL so the verified bytes are the exact ones evaluated.
  const esmResponse = await fetch(VENDOR_ESM_URL);
  if (!esmResponse.ok) {
    throw new Error(`failed to fetch esm from ${VENDOR_ESM_URL}`);
  }
  const esmBytes = new Uint8Array(await esmResponse.arrayBuffer());
  const esmDigest = await crypto.subtle.digest('SHA-256', esmBytes);
  if (hex(new Uint8Array(esmDigest)) !== ESM_SHA256) {
    throw new Error('libde265 esm sha256 mismatch');
  }
  const blobUrl = URL.createObjectURL(new Blob([esmBytes], { type: 'text/javascript' }));
  try {
    const factory = (await import(/* @vite-ignore */ blobUrl)) as unknown as {
      default: (options: { wasmBinary: ArrayBuffer }) => Promise<Libde265Module>;
    };
    return factory.default({ wasmBinary: wasmBytes.buffer });
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

async function copyOut(frame: VideoFrame, ptsUs: number): Promise<void> {
  try {
    // No explicit format: dedicated workers reject copyTo() with a non-RGB
    // format argument; the frame's native format (I420 from libde265) is
    // copied as-is.
    const size = frame.allocationSize();
    const buffer = new ArrayBuffer(size);
    const layout = await frame.copyTo(buffer);
    const width = frame.codedWidth;
    const height = frame.codedHeight;
    frame.close();
    post({ type: 'frame', ptsUs, frameBuffer: buffer, width, height, layout }, [buffer]);
  } catch (err) {
    frame.close();
    post({ type: 'error', code: 'DECODE', message: err instanceof Error ? err.message : String(err) });
  }
}

function onFrame(frame: VideoFrame, ptsUs: number): void {
  outputChain = outputChain.then(() => copyOut(frame, ptsUs));
}

// ---- message handlers ---------------------------------------------------------

async function handleInit(): Promise<void> {
  try {
    if (typeof VideoFrame === 'undefined') {
      throw new Error('VideoFrame unavailable in this worker');
    }
    const module = await loadLibde265Module();
    decoder = new HevcSoftDecoder(module);
    decoder.onOutput(onFrame);
    decoder.onError((info) => post({ type: 'error', code: info.code, message: info.message }));
    post({ type: 'ready' });
  } catch (err) {
    post({ type: 'init-error', message: err instanceof Error ? err.message : String(err) });
  }
}

function handleChunk(chunk: Uint8Array): void {
  if (decoder === null) {
    return;
  }
  decoder.decode({ type: 'delta', timestamp: chunkIndex * FRAME_INTERVAL_US, data: chunk });
  chunkIndex += 1;
}

async function handleFlush(): Promise<void> {
  if (decoder === null) {
    post({ type: 'done' });
    return;
  }
  await decoder.flush();
  await outputChain; // all pending frame messages are posted before 'done'
  post({ type: 'done' });
}

function handleClose(): void {
  decoder?.close();
  decoder = null;
}

scope.onmessage = (event) => {
  const message = event.data;
  switch (message.type) {
    case 'init':
      void handleInit();
      break;
    case 'chunk':
      handleChunk(message.chunk);
      break;
    case 'flush':
      void handleFlush();
      break;
    case 'close':
      handleClose();
      break;
  }
};
