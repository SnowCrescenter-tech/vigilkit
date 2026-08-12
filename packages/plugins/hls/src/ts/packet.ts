/** Incremental TS packetizer: emits complete packets, resyncs on lost sync. */

const TS_PACKET_SIZE = 188;
const RS_PARITY_SIZE = 16; // trailing bytes of a 204-byte FEC packet
const SYNC_BYTE = 0x47;

export interface TsPacketizerOptions {
  /** Packet size in bytes: 188 (default) or 204 (16-byte RS parity). */
  packetSize?: 188 | 204;
  /** Called when a packet's continuity counter skips a value. */
  onError?: (message: string) => void;
}

export class TsPacketizer {
  private readonly packetSize: number;
  private readonly onError: ((message: string) => void) | undefined;
  private buffer = new Uint8Array(0);
  private synced = false;
  private readonly continuityByPid = new Map<number, number>();
  private trackedPids: ReadonlySet<number> | null = null;

  constructor(options: TsPacketizerOptions = {}) {
    this.packetSize = options.packetSize ?? TS_PACKET_SIZE;
    this.onError = options.onError;
  }

  /**
   * Restricts continuity-counter checking to the given PIDs (the PES video/
   * audio streams from the PMT). PSI PIDs (PAT/PMT) are excluded so their
   * muxer-specific retransmission cadence is never treated as stream loss.
   */
  setTrackedPids(pids: ReadonlySet<number>): void {
    this.trackedPids = pids;
  }

  /** Appends bytes and emits every complete TS packet to `emit`. */
  push(chunk: Uint8Array, emit: (packet: Uint8Array) => void): void {
    if (chunk.length === 0) return;
    const next = new Uint8Array(this.buffer.length + chunk.length);
    next.set(this.buffer, 0);
    next.set(chunk, this.buffer.length);
    this.buffer = next;
    this.parse(emit);
  }

  /** Drops any trailing partial packet and resets per-PID continuity state. */
  flush(): void {
    this.buffer = new Uint8Array(0);
    this.synced = false;
    this.continuityByPid.clear();
  }

  private parse(emit: (packet: Uint8Array) => void): void {
    let pos = 0;
    const length = this.buffer.length;
    while (pos + this.packetSize <= length) {
      if (!this.synced) {
        if (this.buffer[pos] !== SYNC_BYTE) {
          pos++;
          continue;
        }
        // Require a second 0x47 at the next packet boundary to avoid a
        // 1/256 false sync on random data.
        if (pos + this.packetSize < length && this.buffer[pos + this.packetSize] !== SYNC_BYTE) {
          pos++;
          continue;
        }
        this.synced = true;
      }
      const packet = this.buffer.slice(pos, pos + this.packetSize);
      if (packet[0] !== SYNC_BYTE) {
        // False sync: resync from the next byte.
        this.synced = false;
        pos++;
        continue;
      }
      emit(packet);
      this.trackContinuity(packet);
      pos += this.packetSize;
    }
    this.buffer = this.buffer.slice(pos);
    if (this.buffer.length === 0) this.synced = false;
  }

  /**
   * Tracks the MPEG-TS continuity counter per PID. A skipped value
   * (delta !== 1, with the 15→0 wrap treated as a normal step) reports through
   * `onError`; a repeated value (delta 0) is a legal retransmission and is
   * skipped silently. Only packets carrying a payload are counted (adaptation-
   * only packets do not increment the counter per spec), and only PIDs the
   * demuxer explicitly tracks (PES video/audio streams) are checked — PSI PIDs
   * (PAT/PMT) are retransmitted with muxer-specific cadence and must not be
   * treated as stream loss.
   */
  private trackContinuity(packet: Uint8Array): void {
    const header = packet[1] as number;
    if ((header & 0x80) !== 0) return; // transport_error_indicator
    const pid = ((header & 0x1f) << 8) | (packet[2] as number);
    if (this.trackedPids !== null && !this.trackedPids.has(pid)) return;
    const adaptationFieldControl = ((packet[3] as number) >> 4) & 0x03;
    if (adaptationFieldControl === 0b10) return; // adaptation-only: counter not incremented
    const continuity = (packet[3] as number) & 0x0f;
    const last = this.continuityByPid.get(pid);
    if (last !== undefined) {
      const delta = (continuity - last + 16) & 0x0f;
      if (delta === 0) {
        // Duplicate packet — legal, skip silently.
      } else if (delta !== 1) {
        this.onError?.(
          `continuity counter gap on PID ${pid}: expected ${(last + 1) & 0x0f}, got ${continuity}`,
        );
      }
    }
    this.continuityByPid.set(pid, continuity);
  }
}

export interface ParsedPacket {
  pid: number;
  payloadUnitStart: boolean;
  payload: Uint8Array;
  adaptationFieldLength: number;
}

/**
 * Parses one 188- or 204-byte packet. Returns `null` for a wrong size, bad
 * sync, or the TEI transport-error flag. adaptation_field_control: 0b10
 * adaptation only, 0b11 adaptation + payload, 0b01 payload only. The payload
 * never extends past the 188-byte packet body, so a 204-byte packet's trailing
 * RS-parity bytes are never part of it.
 */
export function parsePacket(packet: Uint8Array): ParsedPacket | null {
  if (
    (packet.length !== TS_PACKET_SIZE && packet.length !== TS_PACKET_SIZE + RS_PARITY_SIZE) ||
    packet[0] !== SYNC_BYTE
  ) {
    return null;
  }
  const header = packet[1] as number;
  if ((header & 0x80) !== 0) return null; // transport_error_indicator
  const payloadUnitStart = (header & 0x40) !== 0;
  const pid = ((header & 0x1f) << 8) | (packet[2] as number);
  const adaptationFieldControl = ((packet[3] as number) >> 4) & 0x03;
  let offset = 4;
  let adaptationFieldLength = 0;
  if (adaptationFieldControl === 0b10 || adaptationFieldControl === 0b11) {
    adaptationFieldLength = packet[4] as number;
    offset = 5 + adaptationFieldLength;
  }
  const empty = new Uint8Array(0);
  if (adaptationFieldControl === 0b10 || offset >= TS_PACKET_SIZE) {
    return { pid, payloadUnitStart, payload: empty, adaptationFieldLength };
  }
  return { pid, payloadUnitStart, payload: packet.slice(offset, TS_PACKET_SIZE), adaptationFieldLength };
}
