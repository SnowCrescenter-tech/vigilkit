/**
 * GB/T 28181 SIP dialog session state machine.
 *
 * Drives the REGISTER → INVITE → (media) → BYE lifecycle and produces the
 * media connection info an RTP-over-WebSocket client needs from the INVITE
 * 200-OK answer. This package intentionally does NOT send SIP or receive RTP:
 * the caller transports the serialized messages (SIP-over-WebSocket, TCP or
 * UDP) and feeds responses back through `handleMessage` — see
 * docs/gb28181-manual-qa.md for the real-platform flow.
 *
 * States: IDLE → REGISTERING → INVITING → PLAYING → STOPPING → TERMINATED,
 * with ERROR reached from any 4xx/5xx (except 401/407, which feed the digest
 * challenge for a retried REGISTER).
 */
import { generateSipAuthorization, parseDigestChallenge } from './digest.js';
import type { DigestChallenge } from './digest.js';
import { buildSdpOffer, parseSdp, sdpMediaInfo } from './sdp.js';
import type { SdpMediaInfo } from './sdp.js';
import { parseCSeq, parseHeaderParams, parseSipMessage, sipError, sipHeader } from './sip.js';
import type { SipMessage } from './sip.js';

export type SessionState =
  | 'IDLE'
  | 'REGISTERING'
  | 'INVITING'
  | 'PLAYING'
  | 'STOPPING'
  | 'TERMINATED'
  | 'ERROR';

export interface Gb28181SessionOptions {
  /**
   * SIP server: `host:port`, `sip:host:port`, or `sip:user@host:port`
   * (proxy style). The host is the REGISTER target; INVITE Request-URIs are
   * `sip:<deviceId>@<host>`.
   */
  server: string;
  /** 20-digit GB/T 28181 device/camera ID (e.g. 34020000001320000001). */
  deviceId: string;
  /** Digest username; defaults to `deviceId`. */
  username?: string;
  /** Digest password; omit to skip Authorization entirely. */
  password?: string;
  /** Local IP advertised in Via/Contact/SDP. */
  localIp: string;
  /** Local SIP port advertised in Via/Contact. Defaults to 0. */
  localPort?: number;
  /** SIP transport token for the Via header ('udp' | 'tcp' | 'ws'). */
  transport?: 'udp' | 'tcp' | 'ws';
  /** Default SSRC (10-digit decimal per GB/T 28181). */
  ssrc?: number;
  /** Injectable clock for branch/Call-ID generation (tests). */
  now?: () => Date;
}

/** Media connection info for an RTP-over-WebSocket client. */
export interface MediaConnectionInfo {
  /** Source/destination IP from the 200-OK answer (c= or o=). */
  ip: string;
  /** RTP port from the answer's m= line. */
  port: number;
  /** SSRC from the answer (a=ssrc) or the y= SIP header. */
  ssrc?: number;
  payloadTypes: number[];
  /** Payload type → encoding name from a=rtpmap. */
  rtpmap: Record<number, string>;
}

interface ServerTarget {
  host: string;
  port?: number;
  user?: string;
}

let callCounter = 0;

/**
 * A REGISTER/INVITE/BYE dialog session against a GB/T 28181 platform.
 * Not transport-bound: `register()`, `invite()` and `bye()` return the
 * serializable `SipMessage`s; `handleMessage()` consumes responses.
 */
export class Gb28181Session {
  private readonly options: Required<Pick<Gb28181SessionOptions, 'deviceId' | 'localIp' | 'server' | 'transport' | 'now'>> &
    Gb28181SessionOptions;
  private readonly target: ServerTarget;
  private state: SessionState = 'IDLE';
  private registered = false;
  private challengeValue: DigestChallenge | null = null;
  private mediaInfoValue: MediaConnectionInfo | null = null;
  private lastErrorValue: string | null = null;
  private readonly cseq = new Map<string, number>();
  private readonly callId: string;
  private readonly fromTag: string;
  private readonly toTagValue = 'gb28181';
  private toTag: string | null = null;

  constructor(options: Gb28181SessionOptions) {
    this.options = {
      ...options,
      username: options.username ?? options.deviceId,
      transport: options.transport ?? 'udp',
      now: options.now ?? (() => new Date()),
    };
    this.target = parseServerTarget(options.server);
    const now = this.options.now();
    this.callId = `${now.getTime().toString(16)}-${(callCounter++).toString(16)}@${options.localIp}`;
    this.fromTag = `tag${now.getTime().toString(16)}${(callCounter++).toString(16)}`;
  }

  get currentState(): SessionState {
    return this.state;
  }

  get isRegistered(): boolean {
    return this.registered;
  }

  /** The digest challenge from the last 401/407, or null. */
  get challenge(): DigestChallenge | null {
    return this.challengeValue;
  }

  /** Media connection info from the INVITE 200-OK answer, or null. */
  get mediaInfo(): MediaConnectionInfo | null {
    return this.mediaInfoValue;
  }

  /** Human-readable last error (e.g. '486 Busy Here'), or null. */
  get lastError(): string | null {
    return this.lastErrorValue;
  }

  /**
   * Builds the REGISTER request. With a `challenge` (from a previous 401/407)
   * the message carries the digest `Authorization` header; without one it is
   * the initial unauthenticated REGISTER. Returns the message for the caller
   * to transport; does not send anything.
   */
  register(challenge?: DigestChallenge): SipMessage {
    if (this.state === 'ERROR' || this.state === 'TERMINATED') {
      throw sipError('STATE', `cannot register from state ${this.state}`);
    }
    if (this.state === 'REGISTERING' && challenge === undefined) {
      throw sipError('STATE', 'already registering; retry with the digest challenge from the 401/407');
    }
    if (this.state === 'REGISTERING' && challenge !== undefined) {
      this.challengeValue = challenge;
    } else {
      this.state = 'REGISTERING';
    }
    const uri = this.serverUri();
    const headers: Array<[string, string]> = [
      ['Via', this.viaHeader()],
      ['From', `<sip:${this.options.deviceId}@${this.serverHostPort()}>;tag=${this.fromTag}`],
      ['To', `<sip:${this.options.deviceId}@${this.serverHostPort()}>`],
      ['Call-ID', this.callId],
      ['CSeq', `${this.nextCSeq('REGISTER')} REGISTER`],
      ['Contact', `<sip:${this.options.deviceId}@${this.options.localIp}:${this.localSipPort()}>`],
      ['Expires', '3600'],
    ];
    if (challenge !== undefined) {
      const username = this.options.username ?? this.options.deviceId;
      const password = this.options.password;
      if (password !== undefined) {
        headers.push([
          'Authorization',
          generateSipAuthorization(username, password, 'REGISTER', uri, challenge),
        ]);
      }
    }
    headers.push(['User-Agent', 'vigilkit-gb28181/0.3.0']);
    headers.push(['Content-Length', '0']);
    return { startLine: { method: 'REGISTER', uri, version: 'SIP/2.0' }, headers: headers.map(([name, value]) => ({ name, value })), body: '' };
  }

  /**
   * Builds the INVITE request with the SDP offer (PS payload, SSRC) and the
   * GB/T 28181 `y=` SSRC header. Requires a completed REGISTER dialog.
   */
  invite(ssrc?: number): SipMessage {
    if (this.state !== 'IDLE') {
      throw sipError('STATE', `cannot INVITE from state ${this.state}`);
    }
    if (!this.registered) {
      throw sipError('STATE', 'must REGISTER (and receive 200 OK) before INVITE');
    }
    this.state = 'INVITING';
    this.mediaInfoValue = null;
    const resolvedSsrc = this.resolveSsrc(ssrc);
    const uri = `sip:${this.options.deviceId}@${this.serverHostPort()}`;
    const sdp = buildSdpOffer({
      ip: this.options.localIp,
      port: this.options.localPort ?? 0,
      ssrc: resolvedSsrc,
      username: this.options.deviceId,
    });
    const headers: Array<[string, string]> = [
      ['Via', this.viaHeader()],
      ['From', `<sip:${this.options.deviceId}@${this.serverHostPort()}>;tag=${this.fromTag}`],
      ['To', `<sip:${this.options.deviceId}@${this.serverHostPort()}>`],
      ['Call-ID', this.callId],
      ['CSeq', `${this.nextCSeq('INVITE')} INVITE`],
      ['Contact', `<sip:${this.options.deviceId}@${this.options.localIp}:${this.localSipPort()}>`],
      ['Max-Forwards', '70'],
      ['Content-Type', 'application/sdp'],
      ['y', this.formatSsrc(resolvedSsrc)],
      ['f', 'v/2/5/25/1/128/0/0'],
      ['Content-Length', String(utf8Length(sdp))],
    ];
    return { startLine: { method: 'INVITE', uri, version: 'SIP/2.0' }, headers: headers.map(([name, value]) => ({ name, value })), body: sdp };
  }

  /** Builds the BYE request (requires a PLAYING dialog). */
  bye(): SipMessage {
    if (this.state !== 'PLAYING') {
      throw sipError('STATE', `cannot BYE from state ${this.state}`);
    }
    this.state = 'STOPPING';
    const uri = `sip:${this.options.deviceId}@${this.serverHostPort()}`;
    const headers: Array<[string, string]> = [
      ['Via', this.viaHeader()],
      ['From', `<sip:${this.options.deviceId}@${this.serverHostPort()}>;tag=${this.fromTag}`],
      ['To', `<sip:${this.options.deviceId}@${this.serverHostPort()}>${this.toTag !== null ? `;tag=${this.toTag}` : ''}`],
      ['Call-ID', this.callId],
      ['CSeq', `${this.nextCSeq('BYE')} BYE`],
      ['Max-Forwards', '70'],
      ['Content-Length', '0'],
    ];
    return { startLine: { method: 'BYE', uri, version: 'SIP/2.0' }, headers: headers.map(([name, value]) => ({ name, value })), body: '' };
  }

  /** Terminates the dialog without sending BYE (caller-driven teardown). */
  terminate(): void {
    if (this.state !== 'TERMINATED' && this.state !== 'ERROR') {
      this.state = 'TERMINATED';
    }
  }

  /**
   * Consumes an incoming SIP message (typically a response to a message this
   * session produced). Advances the state machine and fills `mediaInfo`.
   * Malformed responses are best-effort ignored; 4xx/5xx move to ERROR.
   */
  handleMessage(message: SipMessage): void {
    if (message.startLine === undefined || !('statusCode' in message.startLine)) return;
    const statusCode = message.startLine.statusCode;
    const cseq = safeCSeq(message);

    if (statusCode === 401 || statusCode === 407) {
      // Digest challenge: keep REGISTERING so the caller can retry with the
      // challenge in hand.
      try {
        this.challengeValue = parseDigestChallenge(sipHeader(message, 'WWW-Authenticate'));
      } catch (error) {
        this.lastErrorValue = error instanceof Error ? error.message : String(error);
        this.challengeValue = null;
        this.state = 'ERROR';
      }
      return;
    }

    if (statusCode >= 400) {
      this.lastErrorValue = `${statusCode} ${message.startLine.reasonPhrase}`.trim();
      this.state = 'ERROR';
      return;
    }

    if (statusCode >= 200 && statusCode < 300) {
      if (cseq === null) return;
      if (cseq.method === 'REGISTER' && this.state === 'REGISTERING') {
        this.registered = true;
        this.state = 'IDLE';
        return;
      }
      if (cseq.method === 'INVITE' && this.state === 'INVITING') {
        this.captureToTag(message);
        this.mediaInfoValue = this.extractMediaInfo(message);
        this.state = 'PLAYING';
        return;
      }
      if (cseq.method === 'BYE' && this.state === 'STOPPING') {
        this.state = 'TERMINATED';
      }
    }
  }

  /** Parses a raw wire response (never throws) and feeds it to the machine. */
  handleResponse(text: string): void {
    let message: SipMessage;
    try {
      message = parseSipMessage(text);
    } catch {
      return;
    }
    this.handleMessage(message);
  }

  private captureToTag(message: SipMessage): void {
    const to = sipHeader(message, 'To');
    if (to === undefined) return;
    for (const param of parseHeaderParams(to)) {
      if (param.key === 'tag' && param.value !== undefined) {
        this.toTag = param.value;
        return;
      }
    }
  }

  private extractMediaInfo(message: SipMessage): MediaConnectionInfo | null {
    if (message.body.trim().length === 0) {
      this.lastErrorValue = '200 OK to INVITE without an SDP answer';
      return null;
    }
    let info: SdpMediaInfo | null;
    try {
      info = sdpMediaInfo(parseSdp(message.body));
    } catch (error) {
      this.lastErrorValue = error instanceof Error ? error.message : String(error);
      return null;
    }
    if (info === null) {
      this.lastErrorValue = 'SDP answer has no media line';
      return null;
    }
    const y = sipHeader(message, 'y');
    const ySsrc = y !== undefined ? Number(y.trim()) : NaN;
    return {
      ip: info.ip,
      port: info.port,
      ...(info.ssrc !== undefined ? { ssrc: info.ssrc } : Number.isInteger(ySsrc) && ySsrc > 0 ? { ssrc: ySsrc } : {}),
      payloadTypes: info.payloadTypes,
      rtpmap: info.rtpmap,
    };
  }

  private resolveSsrc(ssrc: number | undefined): number {
    if (ssrc !== undefined) return ssrc;
    if (this.options.ssrc !== undefined) return this.options.ssrc;
    return 0x0100000000 + Math.floor(Math.random() * 0x3b9ac9ff); // 10-digit range
  }

  private formatSsrc(ssrc: number): string {
    return String(ssrc).padStart(10, '0').slice(-10);
  }

  private nextCSeq(method: string): number {
    const next = (this.cseq.get(method) ?? 0) + 1;
    this.cseq.set(method, next);
    return next;
  }

  private viaHeader(): string {
    const port = this.localSipPort();
    return `SIP/2.0/${this.options.transport.toUpperCase()} ${this.options.localIp}:${port};branch=${this.branch()};rport`;
  }

  private branch(): string {
    const now = this.options.now();
    return `z9hG4bK${now.getTime().toString(16)}${(callCounter++).toString(16)}`;
  }

  private localSipPort(): number {
    return this.options.localPort ?? 0;
  }

  private serverHostPort(): string {
    const port = this.target.port !== undefined ? `:${this.target.port}` : '';
    return `${this.target.host}${port}`;
  }

  /** The REGISTER Request-URI (and digest uri): sip:<host>[:port]. */
  private serverUri(): string {
    return `sip:${this.serverHostPort()}`;
  }
}

function parseServerTarget(server: string): ServerTarget {
  let rest = server.trim();
  if (rest.startsWith('sip:')) rest = rest.slice(4);
  const at = rest.lastIndexOf('@');
  const user = at !== -1 ? rest.slice(0, at) : undefined;
  const hostPort = at !== -1 ? rest.slice(at + 1) : rest;
  const colon = hostPort.lastIndexOf(':');
  if (colon !== -1 && !hostPort.includes(']')) {
    const port = Number(hostPort.slice(colon + 1));
    return { host: hostPort.slice(0, colon), port: Number.isInteger(port) && port > 0 ? port : undefined, user };
  }
  return { host: hostPort, user };
}

function safeCSeq(message: SipMessage): { sequence: number; method: string } | null {
  try {
    return parseCSeq(sipHeader(message, 'CSeq'));
  } catch {
    return null;
  }
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}
