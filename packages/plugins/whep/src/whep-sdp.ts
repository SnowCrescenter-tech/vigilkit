/**
 * True when the SDP advertises at least one video media section. WHEP
 * responses must negotiate video; a response without `m=video` is treated as
 * an SDP parse failure (surfaced as UNSUPPORTED by the source).
 */
export function hasVideoMedia(sdp: string): boolean {
  return sdp.split(/\r?\n/).some((line) => line.trim().startsWith('m=video'));
}

/**
 * The PATCH URL of a WHEP session: the POST response `Location` header when
 * present (resolved against `base`), otherwise the resource URL itself.
 */
export function resolvePatchUrl(location: string | null, base: string | undefined, fallback: string): string {
  if (location === null || location === '') {
    return fallback;
  }
  try {
    return new URL(location, base ?? fallback).href;
  } catch {
    return fallback;
  }
}

/** One audio/video media section of an SDP, with its negotiated codec. */
export interface SdpMedia {
  kind: 'audio' | 'video';
  codec: string;
  payloadType: number;
  sampleRate?: number;
  channels?: number;
  /** H.264 fmtp `sprop-parameter-sets` SPS/PPP as base64 (out-of-band config). */
  spsB64?: string;
  ppsB64?: string;
}

/**
 * Parses the audio/video media sections of an SDP: the negotiated payload
 * type, codec name, and clock rate (plus channel count) from `a=rtpmap`, and
 * the H.264 `sprop-parameter-sets` (out-of-band SPS/PPS) from `a=fmtp`. Media
 * sections without a recognized `rtpmap` are omitted. Used by the encoded
 * (insertable-streams) WHEP path to emit configs before the first frame.
 */
export function parseSdpMedia(sdp: string): SdpMedia[] {
  const media: SdpMedia[] = [];
  let current: SdpMedia | null = null;
  for (const rawLine of sdp.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('m=')) {
      if (line.startsWith('m=audio') || line.startsWith('m=video')) {
        current = { kind: line.startsWith('m=audio') ? 'audio' : 'video', codec: '', payloadType: -1 };
        media.push(current);
      } else {
        current = null;
      }
      continue;
    }
    if (current === null) continue;
    if (line.startsWith('a=rtpmap:')) {
      const match = /^a=rtpmap:(\d+) ([^/\s]+)\/(\d+)(?:\/(\d+))?$/.exec(line);
      if (match === null) continue;
      current.payloadType = Number(match[1]);
      current.codec = match[2] ?? '';
      current.sampleRate = Number(match[3]);
      const channels = match[4];
      if (channels !== undefined) current.channels = Number(channels);
    } else if (line.startsWith('a=fmtp:')) {
      const payloadType = Number.parseInt(line.slice('a=fmtp:'.length), 10);
      if (payloadType !== current.payloadType) continue;
      const sprop = /sprop-parameter-sets=([^;\s]+)/.exec(line);
      if (sprop !== null) {
        const [sps, pps] = (sprop[1] ?? '').split(',');
        if (sps !== undefined && sps !== '') current.spsB64 = sps;
        if (pps !== undefined && pps !== '') current.ppsB64 = pps;
      }
    }
  }
  return media.filter((entry) => entry.payloadType !== -1);
}
