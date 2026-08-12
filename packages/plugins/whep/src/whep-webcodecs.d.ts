// MediaStreamTrackProcessor is not yet in the TypeScript DOM lib (TS 5.9).
// Declare the subset the WHEP source uses so `globalThis.MediaStreamTrackProcessor`
// type-checks; the public API of the plugin uses the structural TrackProcessorLike
// type instead, keeping the built d.ts free of non-DOM-lib references.

interface MediaStreamTrackProcessorInit {
  track: MediaStreamTrack;
  maxBufferSize?: number;
}

interface MediaStreamTrackProcessor {
  readonly readable: ReadableStream<VideoFrame>;
  destroy(): void;
}

declare var MediaStreamTrackProcessor: {
  prototype: MediaStreamTrackProcessor;
  new (init: MediaStreamTrackProcessorInit): MediaStreamTrackProcessor;
};
