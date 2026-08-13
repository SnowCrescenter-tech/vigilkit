import { describe, expect, it } from 'vitest';
import { PluginRegistry } from '@vigilkit/plugin-sdk';
import { hlsSourcePlugin } from '@vigilkit/plugin-hls';
import type { DemuxerEvent } from '@vigilkit/plugin-sdk';
import {
  ANSWER_SDP,
  CLIENT_ANSWER_SDP,
  FakeFrame,
  FakeRtc,
  NO_VIDEO_SDP,
  OFFER_SDP,
  RESOURCE_URL,
  fakeCandidate,
  fakeTrack,
  makeFetch,
  makeSource,
} from './whep-test-fixtures.js';
import {
  ENCODED_ANSWER_SDP,
  IDR,
  PPS,
  SPS,
  annexB,
  makeEncodedSource,
} from './whep-encoded-fixtures.js';
import { WhepSource } from './whep-source.js';
import { whepSourcePlugin } from './plugin.js';

function collectEvents(source: WhepSource): DemuxerEvent[] {
  const events: DemuxerEvent[] = [];
  source.onEvent((event) => events.push(event));
  return events;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function frameEvents(events: DemuxerEvent[]): FakeFrame[] {
  return events
    .filter((event) => event.type === 'frame')
    .map((event) => (event as { type: 'frame'; frame: VideoFrame }).frame as unknown as FakeFrame);
}

function errorEvents(events: DemuxerEvent[]): Array<{ code: string; message: string }> {
  return events
    .filter((event) => event.type === 'error')
    .map((event) => (event as { type: 'error'; error: { code: string; message: string } }).error);
}

type SeqEvent = Extract<DemuxerEvent, { type: 'sequence-header' }>;
type VideoEvent = Extract<DemuxerEvent, { type: 'video' }>;

describe('WhepSource', () => {
  it('answers a server counter-offer (406): POST offer, adopt SDP, createAnswer, PATCH the answer, then trickle candidates', async () => {
    const { fetchImpl, calls } = makeFetch({ postStatus: 406, answerSdp: ANSWER_SDP });
    const { source, rtc } = makeSource(fetchImpl);
    collectEvents(source);
    source.start();
    await flush();

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe(RESOURCE_URL);
    expect(calls[0]?.headers['Content-Type']).toBe('application/sdp');
    expect(calls[0]?.body).toBe(OFFER_SDP);

    expect(rtc.setRemoteDescription).toHaveBeenCalledWith({ type: 'offer', sdp: ANSWER_SDP });
    expect(rtc.createAnswer).toHaveBeenCalledOnce();
    expect(rtc.setLocalDescription).toHaveBeenCalledTimes(2); // offer + answer

    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch).toBeDefined();
    expect(patch?.url).toBe('https://whep.example/whep/session/1');
    expect(patch?.headers['Content-Type']).toBe('application/sdp');
    expect(patch?.headers['If-Match']).toBe('sess-1');
    expect(patch?.body).toBe(CLIENT_ANSWER_SDP);

    rtc.emitCandidate(fakeCandidate('candidate:1 1 udp 1 127.0.0.1 9 typ host'));
    await flush();
    const trickle = calls.filter((call) => call.method === 'PATCH').at(-1);
    expect(trickle?.headers['Content-Type']).toBe('application/trickle-ice-sdpfrag');
    expect(trickle?.headers['If-Match']).toBe('sess-1');
    expect(String(trickle?.body)).toContain('candidate');
    source.stop();
  });

  it('adopts a 201 answer and emits track frames as frame events in order', async () => {
    const { fetchImpl } = makeFetch({ postStatus: 201 });
    const { source, rtc, reader } = makeSource(fetchImpl);
    const events = collectEvents(source);
    source.start();
    await flush();

    expect(rtc.setRemoteDescription).toHaveBeenCalledWith({ type: 'answer', sdp: ANSWER_SDP });

    rtc.emitTrack(fakeTrack());
    const f1 = new FakeFrame(1);
    const f2 = new FakeFrame(2);
    const f3 = new FakeFrame(3);
    reader.pushFrame(f1);
    reader.pushFrame(f2);
    reader.pushFrame(f3);
    await flush();

    const frames = frameEvents(events);
    expect(frames.map((frame) => frame.id)).toEqual([1, 2, 3]);
    // The engine owns the frame: the source must not close what it emits.
    expect(f1.closed).toBe(false);
    expect(f2.closed).toBe(false);
    expect(f3.closed).toBe(false);
    expect(errorEvents(events)).toHaveLength(0);
    source.stop();
  });

  it('surfaces a TRANSPORT error event when the POST fails', async () => {
    const { fetchImpl } = makeFetch({ postStatus: 404 });
    const { source } = makeSource(fetchImpl);
    const events = collectEvents(source);
    source.start();
    await flush();
    const errors = errorEvents(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('TRANSPORT');
    expect(errors[0]?.message).toContain('404');
    source.stop();
  });

  it('surfaces an UNSUPPORTED error event when MediaStreamTrackProcessor is missing', async () => {
    const { fetchImpl } = makeFetch();
    const rtc = new FakeRtc();
    const source = new WhepSource(RESOURCE_URL, {
      fetchImpl,
      RTCPeerConnectionCtor: FakeRtc as unknown as new (configuration?: RTCConfiguration) => RTCPeerConnection,
    });
    const events = collectEvents(source);
    source.start();
    await flush();
    const errors = errorEvents(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('UNSUPPORTED');
    expect(rtc.close).not.toHaveBeenCalled();
  });

  it('surfaces an UNSUPPORTED error event for an answer without a video media section', async () => {
    const { fetchImpl } = makeFetch({ postStatus: 201, answerSdp: NO_VIDEO_SDP });
    const { source } = makeSource(fetchImpl);
    const events = collectEvents(source);
    source.start();
    await flush();
    const errors = errorEvents(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('UNSUPPORTED');
    source.stop();
  });

  it('stop() closes the peer connection and the reader and emits nothing afterwards', async () => {
    const { fetchImpl } = makeFetch({ postStatus: 201 });
    const { source, rtc, reader, processor } = makeSource(fetchImpl);
    const events = collectEvents(source);
    source.start();
    await flush();
    rtc.emitTrack(fakeTrack());
    reader.pushFrame(new FakeFrame(1));
    await flush();
    expect(frameEvents(events)).toHaveLength(1);

    source.stop();
    expect(rtc.close).toHaveBeenCalledOnce();
    expect(processor.destroy).toHaveBeenCalledOnce();
    expect(reader.cancel).toHaveBeenCalledOnce();

    // A frame pushed after stop() must never reach the listeners.
    reader.pushFrame(new FakeFrame(2));
    await flush();
    expect(frameEvents(events)).toHaveLength(1);
  });
});

describe('WhepSource encoded mode (insertable streams)', () => {
  it('adds recvonly audio and video transceivers before creating the offer', async () => {
    const { fetchImpl } = makeFetch({ postStatus: 201 });
    const { source, rtc } = makeEncodedSource(fetchImpl);
    source.start();
    await flush();

    expect(rtc.addTransceiver).toHaveBeenCalledWith('video', { direction: 'recvonly' });
    expect(rtc.addTransceiver).toHaveBeenCalledWith('audio', { direction: 'recvonly' });
    expect(rtc.createOffer).toHaveBeenCalledOnce();
    source.stop();
  });

  it('wires an RTCRtpScriptTransform on the receiver and routes worker messages through the assembler', async () => {
    const { fetchImpl } = makeFetch({ postStatus: 201 });
    const { source, rtc, worker, transform } = makeEncodedSource(fetchImpl);
    const events = collectEvents(source);
    source.start();
    await flush();

    rtc.emitTrack(fakeTrack());
    expect(rtc.receivers[0]?.transform).toBe(transform);
    expect(transform.worker).toBe(worker);
    expect(transform.options).toEqual({ operation: 'encoded' });

    // One access unit with in-band SPS/PPS + IDR keyframe → config + chunk.
    worker.emitMessage({
      kind: 'video',
      type: 'key',
      metadata: { rtpTimestamp: 90000, payloadType: 96, mimeType: 'video/H264' },
      data: annexB(SPS, PPS, IDR),
    });
    await flush();

    const seq = events.find((event): event is SeqEvent => event.type === 'sequence-header');
    expect(seq?.config.codec).toBe('avc1.42001f');
    const video = events.find((event): event is VideoEvent => event.type === 'video');
    expect(video?.chunk.type).toBe('key');
    expect(video?.chunk.timestamp).toBe(1_000_000);
    expect(errorEvents(events)).toHaveLength(0);
    source.stop();
  });

  it('emits a sequence-header from the SDP sprop-parameter-sets at connect, before any track', async () => {
    const { fetchImpl } = makeFetch({ postStatus: 201, answerSdp: ENCODED_ANSWER_SDP });
    const { source } = makeEncodedSource(fetchImpl);
    const events = collectEvents(source);
    source.start();
    await flush();

    const seq = events.find((event): event is SeqEvent => event.type === 'sequence-header');
    expect(seq?.config.codec).toBe('avc1.42001f');
    expect(seq?.config.description).toBeDefined();
    // audio-config is deferred to the first audio frame, not emitted at connect.
    expect(events.some((event) => event.type === 'audio-config')).toBe(false);
    source.stop();
  });

  it('stop() terminates the worker and detaches the receiver transform', async () => {
    const { fetchImpl } = makeFetch({ postStatus: 201 });
    const { source, rtc, worker } = makeEncodedSource(fetchImpl);
    source.start();
    await flush();
    rtc.emitTrack(fakeTrack());

    source.stop();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(rtc.receivers[0]?.transform).toBeNull();
  });

  it('never uses MediaStreamTrackProcessor in encoded mode', async () => {
    const { fetchImpl } = makeFetch({ postStatus: 201 });
    const { source, rtc } = makeEncodedSource(fetchImpl);
    const events = collectEvents(source);
    source.start();
    await flush();
    rtc.emitTrack(fakeTrack());
    await flush();

    expect(rtc.receivers[0]?.transform).toBeDefined();
    // Frames flow via worker messages, not the processor's decoded frames.
    expect(frameEvents(events)).toHaveLength(0);
    source.stop();
  });
});

describe('WhepSourcePlugin registry', () => {
  it('registers alongside the HLS source plugin without collision and resolves by id', () => {
    const registry = new PluginRegistry();
    expect(() => {
      registry.register(hlsSourcePlugin());
      registry.register(whepSourcePlugin());
    }).not.toThrow();
    expect(registry.getSource('whep')?.id).toBe('whep');
    expect(registry.getSource('hls')?.id).toBe('hls');
  });
});
