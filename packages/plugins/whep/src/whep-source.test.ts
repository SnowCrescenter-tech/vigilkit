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
