// Worker-side surface of WebRTC insertable streams (RTCRtpScriptTransform).
// TS 5.9's DOM lib already declares the main-thread side — RTCEncodedVideoFrame,
// RTCEncodedAudioFrame, RTCEncodedFrameMetadata (+ video/audio subclasses),
// RTCRtpScriptTransform and RTCRtpReceiver.transform — so this file only adds
// the pieces that run inside the transform worker (the `rtctransform` event
// and its RTCRtpScriptTransformer), following the whep-webcodecs.d.ts ambient
// declaration pattern. The worker script itself lives as a string in
// whep-source.ts; these types document the surface it runs against.

interface RTCRtpScriptTransformerOptions {
  /** Arbitrary structured-cloneable options from the RTCRtpScriptTransform. */
  [key: string]: unknown;
}

interface RTCRtpScriptTransformer {
  /** Inbound encoded frames from the depacketizer (receiver) or codec (sender). */
  readonly readable: ReadableStream<RTCEncodedVideoFrame | RTCEncodedAudioFrame>;
  readonly writable: WritableStream<RTCEncodedVideoFrame | RTCEncodedAudioFrame>;
  readonly options: RTCRtpScriptTransformerOptions;
  sendKeyFrameRequest(): void;
}

interface RTCTransformEvent {
  readonly transformer: RTCRtpScriptTransformer;
}

/** Worker-global `rtctransform` event handler (fired once per transform, then per frame). */
declare var onrtctransform: ((event: RTCTransformEvent) => void) | null;
