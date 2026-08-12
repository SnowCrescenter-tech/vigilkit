/**
 * MPEG-TS PSI (Program Specific Information) parsing: PAT + PMT sections and
 * the `SectionAssembler` that reassembles sections split across TS packets.
 */

/** Accumulates one PSI section across TS payloads. */
export class SectionAssembler {
  private buffer = new Uint8Array(0);

  /**
   * Feeds a TS payload. `payloadUnitStart` marks the first packet of a
   * section (its first byte is the pointer_field). Returns a complete
   * section (table_id .. CRC, CRC unchecked) once enough bytes have
   * accumulated, otherwise `null`. A fresh section start resyncs any partial
   * section left over from a continuity gap.
   */
  push(payload: Uint8Array, payloadUnitStart: boolean): Uint8Array | null {
    if (payloadUnitStart) {
      const pointer = payload[0] as number;
      if (pointer > payload.length - 1) return null;
      this.buffer = new Uint8Array(0);
      return this.append(payload.subarray(1 + pointer));
    }
    if (this.buffer.length === 0) return null;
    return this.append(payload);
  }

  private append(data: Uint8Array): Uint8Array | null {
    const next = new Uint8Array(this.buffer.length + data.length);
    next.set(this.buffer, 0);
    next.set(data, this.buffer.length);
    this.buffer = next;
    if (this.buffer.length < 3) return null;
    const sectionLength = (((this.buffer[1] as number) & 0x0f) << 8) | (this.buffer[2] as number);
    const total = 3 + sectionLength;
    if (this.buffer.length < total) return null;
    const section = this.buffer.slice(0, total);
    this.buffer = this.buffer.slice(total);
    return section;
  }
}

export interface PatEntry {
  programNumber: number;
  pmtPid: number;
}

export interface PmtEntry {
  streamType: number;
  pid: number;
  programInfo: Uint8Array;
}

/** Parses a complete PAT section into (programNumber, PMT PID) entries. */
export function parsePat(section: Uint8Array): PatEntry[] {
  if (section.length < 12) return [];
  const entries: PatEntry[] = [];
  let pos = 8; // table_id(1) + section_length(2) + tsid(2) + version/section(3)
  while (pos + 4 <= section.length - 4) {
    const programNumber = ((section[pos] as number) << 8) | (section[pos + 1] as number);
    const pmtPid = (((section[pos + 2] as number) & 0x1f) << 8) | (section[pos + 3] as number);
    if (programNumber !== 0) entries.push({ programNumber, pmtPid });
    pos += 4;
  }
  return entries;
}

/** Parses a complete PMT section into (streamType, PID, programInfo) entries. */
export function parsePmt(section: Uint8Array): PmtEntry[] {
  if (section.length < 16) return [];
  let pos = 12; // table_id(1) + section_length(2) + program_number(2) + version/section(3) + PCR_PID(2) + program_info_length(2)
  const programInfoLength = (((section[pos - 2] as number) & 0x0f) << 8) | (section[pos - 1] as number);
  const programInfo = section.slice(pos, pos + programInfoLength);
  pos += programInfoLength;
  const entries: PmtEntry[] = [];
  while (pos + 5 <= section.length - 4) {
    const streamType = section[pos] as number;
    const pid = (((section[pos + 1] as number) & 0x1f) << 8) | (section[pos + 2] as number);
    const esInfoLength = (((section[pos + 3] as number) & 0x0f) << 8) | (section[pos + 4] as number);
    entries.push({ streamType, pid, programInfo: programInfo.slice() });
    pos += 5 + esInfoLength;
  }
  return entries;
}
