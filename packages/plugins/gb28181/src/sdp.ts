/**
 * Minimal RFC 4566 SDP builder/parser for GB/T 28181 media sessions.
 *
 * GB/T 28181-2016 uses the standard RTP payload-type mappings:
 *   PS     96   (H.264 video also commonly rides on 96/97)
 *   H.264  96
 *   H.265  98
 *   G.711A  8   (PCMA)
 *   G.711U  0   (PCMU)
 *   G.726  104  (G726-32)
 *
 * `parseSdp` is tolerant: it throws `SdpError` only when no `v=` line is
 * present (i.e. the payload is not SDP at all); unknown lines are skipped.
 */

/** Typed SDP error, thrown by the parser and media-info extraction. */
export class SdpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SdpError';
  }
}

/** GB/T 28181-2016 RTP payload-type mappings (common public values). */
export const GB28181_PAYLOAD_TYPES = {
  PS: 96,
  H264: 96,
  H265: 98,
  G711A: 8,
  G711U: 0,
  G726: 104,
} as const;

/**
 * RTP payload-type → encoding name (as used in `a=rtpmap`). PT 96 is the
 * canonical GB/T 28181 PS type; some platforms also run H.264 on 96/97, so
 * the offer builder's name for 96 is 'PS' (callers offering H.264 explicitly
 * pass their own payload types and rtpmap names).
 */
export const GB28181_RTPMAP_NAMES: Record<number, string> = {
  0: 'PCMU',
  8: 'PCMA',
  96: 'PS',
  98: 'H265',
  104: 'G726-32',
};

export interface SdpOrigin {
  username: string;
  sessionId: string;
  sessionVersion: string;
  netType: string;
  addrType: string;
  unicastAddress: string;
}

export interface SdpConnection {
  netType: string;
  addrType: string;
  address: string;
}

export interface SdpRtpmap {
  pt: number;
  encodingName: string;
  clockRate: number;
  encodingParams?: string;
}

export interface SdpMedia {
  type: 'video' | 'audio';
  port: number;
  proto: string;
  /** Payload type numbers from the `m=` line. */
  fmt: number[];
  rtpmap: SdpRtpmap[];
  connection?: SdpConnection;
  ssrc?: number;
  fmtp: Map<number, string>;
  sendonly: boolean;
  recvonly: boolean;
}

export interface SdpSession {
  version: number;
  origin: SdpOrigin;
  sessionName: string;
  connection?: SdpConnection;
  /** Raw `t=` value, e.g. '0 0'. */
  timing: string;
  media: SdpMedia[];
}

export interface SdpOfferOptions {
  /** Address for the session-level `c=` line (and `o=` unicast address). */
  ip: string;
  /** RTP receive port advertised in `m=video`. Defaults to 0. */
  port?: number;
  /** SSRC; emitted as an `a=ssrc:` line when provided. */
  ssrc?: number;
  /** Device id used as the `o=` username. */
  username?: string;
  /** Payload types to offer; defaults to `[PS, H265]` (96 98). */
  payloadTypes?: number[];
  sessionName?: string;
}

/** Builds a GB/T 28181 INVITE SDP offer (video, PS payload). */
export function buildSdpOffer(options: SdpOfferOptions): string {
  const sessionId = '0';
  const port = options.port ?? 0;
  const payloadTypes = options.payloadTypes ?? [GB28181_PAYLOAD_TYPES.PS, GB28181_PAYLOAD_TYPES.H265];
  const lines = [
    'v=0',
    `o=${options.username ?? '-'} ${sessionId} 0 IN IP4 ${options.ip}`,
    `s=${options.sessionName ?? 'Play'}`,
    `c=IN IP4 ${options.ip}`,
    't=0 0',
    `m=video ${port} RTP/AVP ${payloadTypes.join(' ')}`,
  ];
  for (const pt of payloadTypes) {
    const name = GB28181_RTPMAP_NAMES[pt];
    if (name !== undefined) {
      const clockRate = pt === GB28181_PAYLOAD_TYPES.G711A || pt === GB28181_PAYLOAD_TYPES.G711U ? 8000 : 90000;
      lines.push(`a=rtpmap:${pt} ${name}/${clockRate}`);
    }
  }
  lines.push('a=recvonly');
  if (options.ssrc !== undefined) lines.push(`a=ssrc:${options.ssrc}`);
  // LF line endings: the SIP parser normalizes body newlines to '\n', so LF
  // keeps serialize → parse round-trips byte-exact (RFC 4566 allows both).
  return lines.join('\n');
}

/**
 * Parses SDP text into a typed session. Throws `SdpError` when the `v=` line
 * is missing; every other malformed line is skipped (best effort).
 */
export function parseSdp(text: string): SdpSession {
  if (typeof text !== 'string' || text.trim().length === 0 || !text.split(/\r?\n/).some((line) => line.startsWith('v='))) {
    throw new SdpError('not an SDP session (missing v= line)');
  }
  const session: SdpSession = {
    version: 0,
    origin: { username: '-', sessionId: '0', sessionVersion: '0', netType: 'IN', addrType: 'IP4', unicastAddress: '0.0.0.0' },
    sessionName: '',
    timing: '0 0',
    media: [],
  };
  let current: SdpMedia | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '');
    if (line.length < 2 || line[1] !== '=') continue;
    const [key, value] = [line[0] as string, line.slice(2)];
    switch (key) {
      case 'v':
        session.version = Number(value) || 0;
        break;
      case 'o': {
        const fields = value.trim().split(/\s+/);
        session.origin = {
          username: fields[0] ?? '-',
          sessionId: fields[1] ?? '0',
          sessionVersion: fields[2] ?? '0',
          netType: fields[3] ?? 'IN',
          addrType: fields[4] ?? 'IP4',
          unicastAddress: fields[5] ?? '0.0.0.0',
        };
        break;
      }
      case 's':
        session.sessionName = value;
        break;
      case 'c':
        session.connection = parseConnection(value);
        if (current !== null) current.connection = parseConnection(value);
        break;
      case 't':
        session.timing = value;
        break;
      case 'm': {
        const fields = value.trim().split(/\s+/);
        current = {
          type: (fields[0] as string) === 'audio' ? 'audio' : 'video',
          port: Number(fields[1]) || 0,
          proto: fields[2] ?? 'RTP/AVP',
          fmt: fields.slice(3).map((f) => Number(f) || 0),
          rtpmap: [],
          fmtp: new Map(),
          sendonly: false,
          recvonly: false,
        };
        session.media.push(current);
        break;
      }
      case 'a': {
        if (current === null) break;
        const [attr, ...rest] = value.split(':');
        const attrValue = rest.join(':');
        if (attr === 'rtpmap') {
          const [pt, encoding] = attrValue.split(/\s+/);
          const encodingFields = (encoding ?? '').split('/');
          const rtpmap: SdpRtpmap = {
            pt: Number(pt) || 0,
            encodingName: encodingFields[0] ?? '',
            clockRate: Number(encodingFields[1]) || 0,
          };
          if (encodingFields.length > 2 && encodingFields[2] !== undefined) rtpmap.encodingParams = encodingFields[2];
          current.rtpmap.push(rtpmap);
        } else if (attr === 'fmtp') {
          const [pt, ...fmtpRest] = attrValue.split(/\s+/);
          current.fmtp.set(Number(pt) || 0, fmtpRest.join(' '));
        } else if (attr === 'ssrc') {
          const ssrc = Number(attrValue.split(/\s+/)[0]);
          if (Number.isInteger(ssrc)) current.ssrc = ssrc;
        } else if (attr === 'sendonly') {
          current.sendonly = true;
        } else if (attr === 'recvonly') {
          current.recvonly = true;
        }
        break;
      }
      default:
        break; // best effort: skip unknown lines
    }
  }
  return session;
}

function parseConnection(value: string): SdpConnection {
  const fields = value.trim().split(/\s+/);
  return { netType: fields[0] ?? 'IN', addrType: fields[1] ?? 'IP4', address: fields[2] ?? '' };
}

export interface SdpMediaInfo {
  ip: string;
  port: number;
  ssrc?: number;
  /** Payload type numbers offered/accepted by the media line. */
  payloadTypes: number[];
  /** Payload type → encoding name, from `a=rtpmap`. */
  rtpmap: Record<number, string>;
}

/**
 * Extracts the media connection info an RTP client needs from a parsed SDP
 * session (typically the 200-OK answer): the media line's `c=` (falling back
 * to the session `c=`, then the `o=` unicast address), port, SSRC and
 * payload-type map. Returns null when the session has no media lines.
 */
export function sdpMediaInfo(session: SdpSession): SdpMediaInfo | null {
  const media = session.media[0];
  if (media === undefined) return null;
  const connection = media.connection ?? session.connection;
  const ip =
    connection?.address ??
    (session.origin.addrType === 'IP4' || session.origin.addrType === 'IP6' ? session.origin.unicastAddress : undefined);
  const rtpmap: Record<number, string> = {};
  for (const entry of media.rtpmap) rtpmap[entry.pt] = entry.encodingName;
  if (ip === undefined || ip.length === 0) return null;
  return {
    ip,
    port: media.port,
    ...(media.ssrc !== undefined ? { ssrc: media.ssrc } : {}),
    payloadTypes: media.fmt,
    rtpmap,
  };
}
