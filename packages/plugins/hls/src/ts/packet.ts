/** Incremental TS packetizer: emits complete 188-byte packets, resyncs on lost sync. */

const TS_PACKET_SIZE = 188;
const SYNC_BYTE = 0x47;

export class TsPacketizer {
  private buffer = new Uint8Array(0);
  private synced = false;

  /** Appends bytes and emits every complete TS packet to `emit`. */
  push(chunk: Uint8Array, emit: (packet: Uint8Array) => void): void {
    if (chunk.length === 0) return;
    const next = new Uint8Array(this.buffer.length + chunk.length);
    next.set(this.buffer, 0);
    next.set(chunk, this.buffer.length);
    this.buffer = next;
    this.parse(emit);
  }

  /** Drops any trailing partial packet. */
  flush(): void {
    this.buffer = new Uint8Array(0);
    this.synced = false;
  }

  private parse(emit: (packet: Uint8Array) => void): void {
    let pos = 0;
    const length = this.buffer.length;
    while (pos + TS_PACKET_SIZE <= length) {
      if (!this.synced) {
        if (this.buffer[pos] !== SYNC_BYTE) {
          pos++;
          continue;
        }
        // Require a second 0x47 at the next packet boundary to avoid a
        // 1/256 false sync on random data.
        if (pos + TS_PACKET_SIZE < length && this.buffer[pos + TS_PACKET_SIZE] !== SYNC_BYTE) {
          pos++;
          continue;
        }
        this.synced = true;
      }
      const packet = this.buffer.slice(pos, pos + TS_PACKET_SIZE);
      if (packet[0] !== SYNC_BYTE) {
        // False sync: resync from the next byte.
        this.synced = false;
        pos++;
        continue;
      }
      emit(packet);
      pos += TS_PACKET_SIZE;
    }
    this.buffer = this.buffer.slice(pos);
    if (this.buffer.length === 0) this.synced = false;
  }
}

export interface ParsedPacket {
  pid: number;
  payloadUnitStart: boolean;
  payload: Uint8Array;
  adaptationFieldLength: number;
}

/**
 * Parses one 188-byte packet. Returns `null` for bad sync or the TEI
 * transport-error flag. adaptation_field_control: 0b10 adaptation only,
 * 0b11 adaptation + payload, 0b01 payload only.
 */
export function parsePacket(packet: Uint8Array): ParsedPacket | null {
  if (packet.length < TS_PACKET_SIZE || packet[0] !== SYNC_BYTE) return null;
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
  if (adaptationFieldControl === 0b10 || offset >= packet.length) {
    return { pid, payloadUnitStart, payload: empty, adaptationFieldLength };
  }
  return { pid, payloadUnitStart, payload: packet.slice(offset), adaptationFieldLength };
}
