import { describe, expect, it } from 'vitest';
import { SectionAssembler, parsePat, parsePmt } from './psi.js';

function section(tableId: number, body: number[]): Uint8Array {
  const sectionLength = body.length + 4;
  const out = new Uint8Array(3 + body.length + 4);
  out[0] = tableId;
  out[1] = 0xb0 | ((sectionLength >> 8) & 0x0f);
  out[2] = sectionLength & 0xff;
  out.set(body, 3);
  return out;
}

describe('parsePat', () => {
  it('extracts (programNumber, PMT PID) entries', () => {
    const pat = section(0x00, [
      0x00, 0x01, // transport_stream_id
      0xc1, 0x00, 0x00, // version/current/section
      0x00, 0x01, // program_number
      0xe1, 0x00, // PMT PID 0x100
    ]);
    expect(parsePat(pat)).toEqual([{ programNumber: 1, pmtPid: 0x100 }]);
  });

  it('skips program_number 0 (network PID) and the CRC', () => {
    const pat = section(0x00, [
      0x00, 0x01,
      0xc1, 0x00, 0x00,
      0x00, 0x00, // network entry
      0xe0, 0x10,
      0x00, 0x01,
      0xe1, 0x00,
    ]);
    const entries = parsePat(pat);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ programNumber: 1, pmtPid: 0x100 });
  });
});

describe('parsePmt', () => {
  it('extracts stream types and PIDs', () => {
    const pmt = section(0x02, [
      0x00, 0x01, // program_number
      0xc1, 0x00, 0x00,
      0xe1, 0x00, // PCR PID
      0xf0, 0x00, // program_info_length 0
      0x1b, 0xe1, 0x01, 0xf0, 0x00, // H.264 video PID 0x101
      0x0f, 0xe1, 0x02, 0xf0, 0x00, // AAC audio PID 0x102
    ]);
    const entries = parsePmt(pmt);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ streamType: 0x1b, pid: 0x101 });
    expect(entries[1]).toMatchObject({ streamType: 0x0f, pid: 0x102 });
  });
});

describe('SectionAssembler', () => {
  it('reassembles a section split across packets', () => {
    const pat = section(0x00, [0, 1, 0xc1, 0, 0, 0, 1, 0xe1, 0]);
    const half = Math.floor(pat.length / 2);
    const assembler = new SectionAssembler();
    // First packet: pointer_field 0 + first half
    const first = new Uint8Array([0, ...pat.slice(0, half)]);
    expect(assembler.push(first, true)).toBeNull();
    const second = pat.slice(half);
    const result = assembler.push(second, false);
    expect(result).not.toBeNull();
    expect(parsePat(result as Uint8Array)).toHaveLength(1);
  });

  it('resyncs on a fresh section start', () => {
    const assembler = new SectionAssembler();
    assembler.push(new Uint8Array([0, 0x02, 0xb0]), true); // partial garbage
    const pat = section(0x00, [0, 1, 0xc1, 0, 0, 0, 1, 0xe1, 0]);
    const result = assembler.push(new Uint8Array([0, ...pat]), true);
    expect(result).not.toBeNull();
  });
});
