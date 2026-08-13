// generate-hevc-fixtures.mjs
// Generates examples/basic/hevc-fixtures/flv-hevc.flv — an Enhanced-RTMP
// (veovera) FLV with an H.265 stream — from the committed Annex-B HEVC
// elementary stream (paired_fields.hevc).
//
//   FLV header + onMetaData (constants 640x360@30) + one HEVC SequenceStart
//   tag (box-wrapped hvcC, the ffmpeg/SRS de-facto layout) + one CodedFrames
//   tag per VCL access unit (SI24 CTS + length-prefixed NALUs).
//
//   node scripts/generate-hevc-fixtures.mjs [--verify]
//
// `--verify` re-demuxes the generated file with the plugin's own demuxer
// (imported from dist; rebuild the plugin first) and asserts a sequence
// header, at least one video chunk and zero errors. Idempotent.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHvcC, codecStringFromHvcC, splitAnnexBNalus } from '../packages/media-utils/dist/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const inputPath = join(root, 'examples', 'basic', 'hevc-fixtures', 'paired_fields.hevc');
const outputPath = join(root, 'examples', 'basic', 'hevc-fixtures', 'flv-hevc.flv');

// onMetaData constants (documented; not derived from the SPS).
const WIDTH = 640;
const HEIGHT = 360;
const FRAMERATE = 30;

const VPS_NUT = 32;
const SPS_NUT = 33;
const PPS_NUT = 34;

// --- byte helpers ---------------------------------------------------------------

function u16(n) {
  return [(n >> 8) & 0xff, n & 0xff];
}

function u24(n) {
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function u32(n) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function f64(n) {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, n, false);
  return [...new Uint8Array(buf)];
}

function concat(...parts) {
  const out = Buffer.alloc(parts.reduce((sum, p) => sum + p.length, 0));
  let off = 0;
  for (const part of parts) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}

/** AMF0 string value: marker 0x02 + u16 length + UTF-8 bytes. */
function amfString(value) {
  const bytes = new TextEncoder().encode(value);
  return Buffer.from([0x02, ...u16(bytes.length), ...bytes]);
}

/** AMF0 number value: marker 0x00 + big-endian double. */
function amfNumber(value) {
  return Buffer.from([0x00, ...f64(value)]);
}

function onMetaDataTag() {
  const entries = [
    ['width', amfNumber(WIDTH)],
    ['height', amfNumber(HEIGHT)],
    ['framerate', amfNumber(FRAMERATE)],
  ];
  const body = Buffer.concat([
    amfString('onMetaData'),
    Buffer.from([0x08, ...u32(entries.length)]),
    ...entries.flatMap(([key, value]) => {
      const keyBytes = new TextEncoder().encode(key);
      return [Buffer.from([...u16(keyBytes.length), ...keyBytes]), value];
    }),
    Buffer.from([0x00, 0x00, 0x09]), // end-of-object marker
  ]);
  return craftTag(18, body);
}

/** Full FLV tag: 11-byte header + payload + 4-byte prevTagSize. */
function craftTag(tagType, payload, timestamp = 0) {
  return concat(
    Buffer.from([tagType, ...u24(payload.length), ...u24(timestamp & 0xffffff), (timestamp >>> 24) & 0xff, 0, 0, 0]),
    payload,
    Buffer.from(u32(11 + payload.length)),
  );
}

/** Enhanced-RTMP HEVC SequenceStart tag with a box-wrapped hvcC record. */
function hevcSeqTag(record) {
  const box = concat(Buffer.from(u32(4 + record.length)), Buffer.from('hvcc', 'ascii'), record);
  return craftTag(9, concat(Buffer.from([0x10, 0x80]), Buffer.from('hvc1', 'ascii'), box));
}

/** Enhanced-RTMP HEVC CodedFrames tag: SI24 CTS + length-prefixed NALUs. */
function hevcCodedFramesTag(nalu, frameType, timestamp) {
  const frameNibble = frameType === 'key' ? 1 : 2;
  return craftTag(
    9,
    concat(
      Buffer.from([(frameNibble << 4) | 1, 0x80]), // frameType | packetType=1, IsExHeader
      Buffer.from('hvc1', 'ascii'),
      Buffer.from([0x00, 0x00, 0x00]), // SI24 composition time = 0
      Buffer.from([...u32(nalu.length), ...nalu]),
    ),
    timestamp,
  );
}

function naluType(nal) {
  return (nal[0] >> 1) & 0x3f;
}

/** HEVC keyframe = IRAP NAL unit: any NAL type in the 16..23 range. */
function isIrap(nal) {
  const type = naluType(nal);
  return type >= 16 && type <= 23;
}

function buildFlv() {
  const es = readFileSync(inputPath);
  const nalus = splitAnnexBNalus(es);
  const vps = nalus.find((n) => naluType(n) === VPS_NUT);
  const sps = nalus.find((n) => naluType(n) === SPS_NUT);
  const pps = nalus.find((n) => naluType(n) === PPS_NUT);
  if (!vps || !sps || !pps) {
    throw new Error('paired_fields.hevc lacks VPS/SPS/PPS parameter sets');
  }

  const hvcC = buildHvcC({ vps, sps, pps });
  const codec = codecStringFromHvcC(hvcC);

  const vcl = nalus.filter((n) => naluType(n) <= 31);
  const header = Buffer.from([0x46, 0x4c, 0x56, 0x01, 0x05, 0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00, 0x00]);
  const parts = [header, onMetaDataTag(), hevcSeqTag(hvcC)];
  for (let i = 0; i < vcl.length; i++) {
    const timestamp = Math.round(i * (1000 / FRAMERATE));
    parts.push(hevcCodedFramesTag(vcl[i], isIrap(vcl[i]) ? 'key' : 'delta', timestamp));
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, concat(...parts));
  return { codec, frames: vcl.length, bytes: Buffer.byteLength(concat(...parts)) };
}

async function verify() {
  const { FlvDemuxer } = await import('../packages/plugins/flv/dist/index.js');
  const file = readFileSync(outputPath);
  const demuxer = new FlvDemuxer();
  const events = [];
  demuxer.onEvent((event) => events.push(event));
  const chunkSize = 64 * 1024;
  for (let i = 0; i < file.length; i += chunkSize) {
    demuxer.push(file.subarray(i, i + chunkSize));
  }
  demuxer.flush();
  const seqs = events.filter((e) => e.type === 'sequence-header');
  const videos = events.filter((e) => e.type === 'video');
  const errors = events.filter((e) => e.type === 'error');
  if (seqs.length < 1 || videos.length < 1 || errors.length > 0) {
    console.error('VERIFY FAILED', { seqs: seqs.length, videos: videos.length, errors });
    process.exit(1);
  }
  console.log(`verify: ${seqs.length} sequence-header(s), ${videos.length} video chunks, 0 errors`);
  console.log(`codec:  ${seqs[0].config.codec}`);
}

// ============================================================================
// MPEG-TS section (T-A2: TS-HEVC demuxing).
// Builds examples/basic/hls-fixtures/hevc-seg-0.ts as a real MPEG-TS carrying
// the same HEVC ES: PAT (pid 0) + PMT (stream_type 0x24, pid 0x101) + one PES
// per access unit (PUSI first packet, PTS = frameIndex * 90000 / 30). Also
// writes the VOD playlist hevc.m3u8 (10 x hevc-seg-0.ts, EXTINF 1.0).
// ============================================================================

const TS_PACKET_SIZE = 188;
const TS_PAYLOAD_SIZE = 184;
const HLS_FIXTURES_DIR = join(root, 'examples', 'basic', 'hls-fixtures');
const TS_OUTPUT = join(HLS_FIXTURES_DIR, 'hevc-seg-0.ts');
const M3U8_OUTPUT = join(HLS_FIXTURES_DIR, 'hevc.m3u8');

/** 5-byte MPEG-TS PTS/DTS encoding (marker: 2 = PTS, 1 = DTS). */
function tsTimestamp(value, marker) {
  return [
    0x01 | (marker << 4) | ((Math.floor(value / 0x40000000) & 7) << 1),
    Math.floor(value / 0x400000) & 0xff,
    0x01 | ((Math.floor(value / 0x8000) & 0x7f) << 1),
    Math.floor(value / 0x80) & 0xff,
    0x01 | ((value & 0x7f) << 1),
  ];
}

/** PES header with PTS (14 bytes): start code + stream id + length 0 + flags. */
function pesHeader(streamId, pts) {
  return concat(
    Buffer.from([0x00, 0x00, 0x01, streamId, 0x00, 0x00]),
    Buffer.from([0x80 | 0x20, 0x00, 0x05]),
    Buffer.from(tsTimestamp(pts, 2)),
  );
}

/** One 188-byte TS packet. `adaptation` pads a short tail payload with stuffing. */
function tsPacket(pid, payload, pusi, cc, adaptation) {
  const out = Buffer.alloc(TS_PACKET_SIZE);
  out[0] = 0x47;
  out[1] = (pusi ? 0x40 : 0) | ((pid >> 8) & 0x1f);
  out[2] = pid & 0xff;
  if (adaptation) {
    const stuffing = TS_PAYLOAD_SIZE - payload.length - 1;
    out[3] = 0x30 | (cc & 0x0f);
    out[4] = stuffing;
    out.fill(0xff, 5, 5 + stuffing);
    out.set(payload, 5 + stuffing);
  } else {
    out[3] = 0x10 | (cc & 0x0f);
    out.set(payload, 4);
  }
  return out;
}

/** PSI section: table_id + section_length + body. */
function psiSection(tableId, body) {
  const sectionLength = body.length + 4;
  const out = Buffer.alloc(3 + body.length + 4);
  out[0] = tableId;
  out[1] = 0xb0 | ((sectionLength >> 8) & 0x0f);
  out[2] = sectionLength & 0xff;
  out.set(body, 3);
  return out;
}

function patSection(pmtPid) {
  return psiSection(
    0x00,
    Buffer.from([
      0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01,
      (0xe000 | pmtPid) >> 8, (0xe000 | pmtPid) & 0xff,
    ]),
  );
}

function pmtHevcSection(videoPid) {
  return psiSection(
    0x02,
    Buffer.from([
      0x00, 0x01, 0xc1, 0x00, 0x00, 0xe0, 0x00, 0xf0, 0x00,
      0x24, (0xe000 | videoPid) >> 8, (0xe000 | videoPid) & 0xff, 0xf0, 0x00,
    ]),
  );
}

/** PSI packet: pointer_field + section, padded to a full TS payload. */
function psiPackets(pid, section, cc) {
  const payload = Buffer.alloc(TS_PAYLOAD_SIZE, 0xff);
  payload[0] = 0x00; // pointer_field
  payload.set(section, 1);
  return tsPacket(pid, payload, true, cc, false);
}

/** Annex-B frame for one NALU: 4-byte start code + payload. */
function annexBNalu(nalu) {
  return concat(Buffer.from([0x00, 0x00, 0x00, 0x01]), nalu);
}

/**
 * Packetizes a PES payload into TS packets. The first packet carries the PUSI
 * flag; a short tail packet is adaptation-stuffed so no padding leaks into the
 * ES. Returns { packets, cc } with the next continuity counter.
 */
function pesPackets(pid, payload, pts, cc) {
  const body = concat(pesHeader(0xe0, pts), payload);
  const packets = [];
  let offset = 0;
  while (offset < body.length) {
    const take = Math.min(TS_PAYLOAD_SIZE, body.length - offset);
    const chunk = body.subarray(offset, offset + take);
    const last = offset + take === body.length;
    packets.push(tsPacket(pid, chunk, offset === 0, cc, last && take < TS_PAYLOAD_SIZE));
    cc = (cc + 1) & 0x0f;
    offset += take;
  }
  return { packets, cc };
}

function buildM3u8() {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:1',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
  ];
  for (let i = 0; i < 10; i++) lines.push('#EXTINF:1.0,', 'hevc-seg-0.ts');
  lines.push('#EXT-X-ENDLIST', '');
  return lines.join('\n');
}

/**
 * Muxes paired_fields.hevc into a single MPEG-TS segment: the first access
 * unit carries VPS/SPS/PPS + the leading IRAP, every following PES carries one
 * VCL NALU (PTS = frameIndex * 90000 / 30).
 */
function buildTs() {
  const es = readFileSync(inputPath);
  const nalus = splitAnnexBNalus(es);
  const vps = nalus.find((n) => naluType(n) === VPS_NUT);
  const sps = nalus.find((n) => naluType(n) === SPS_NUT);
  const pps = nalus.find((n) => naluType(n) === PPS_NUT);
  if (!vps || !sps || !pps) {
    throw new Error('paired_fields.hevc lacks VPS/SPS/PPS parameter sets');
  }
  const vcl = nalus.filter((n) => naluType(n) <= 31);

  const pmtPid = 0x100;
  const videoPid = 0x101;
  let cc = 0;
  const packets = [];
  packets.push(psiPackets(0, patSection(pmtPid), cc));
  cc = (cc + 1) & 0x0f;
  packets.push(psiPackets(pmtPid, pmtHevcSection(videoPid), cc));
  cc = (cc + 1) & 0x0f;

  let frameIndex = 0;
  for (let i = 0; i < vcl.length; i++) {
    const accessUnit = i === 0 ? [vps, sps, pps, vcl[0]] : [vcl[i]];
    const esData = concat(...accessUnit.map((n) => annexBNalu(n)));
    const pts = Math.round((frameIndex * 90000) / 30);
    const p = pesPackets(videoPid, esData, pts, cc);
    cc = p.cc;
    packets.push(...p.packets);
    frameIndex++;
  }

  const segment = concat(...packets);
  mkdirSync(HLS_FIXTURES_DIR, { recursive: true });
  writeFileSync(TS_OUTPUT, segment);
  writeFileSync(M3U8_OUTPUT, buildM3u8());
  return { frames: vcl.length, bytes: segment.length };
}

/** Demuxes the generated TS with the plugin's demuxer (dist) and asserts the
 * TS-HEVC contract: >= 1 hvcC sequence header + >= 1 video chunk + 0 errors. */
async function verifyTs() {
  if (!existsSync(TS_OUTPUT)) {
    throw new Error(`missing ${TS_OUTPUT}; run the generator first`);
  }
  const { TsDemuxer } = await import('../packages/plugins/hls/dist/index.js');
  const bytes = readFileSync(TS_OUTPUT);
  const demuxer = new TsDemuxer();
  const events = [];
  demuxer.onEvent((event) => events.push(event));
  const chunkSize = 7 * 1024;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    demuxer.push(bytes.subarray(i, i + chunkSize));
  }
  demuxer.flush();
  const seqs = events.filter((e) => e.type === 'sequence-header');
  const videos = events.filter((e) => e.type === 'video');
  const errors = events.filter((e) => e.type === 'error');
  const seq = seqs[0];
  if (!seq || typeof seq.config.codec !== 'string' || !/^hvc1\./.test(seq.config.codec)) {
    throw new Error('no hvc1 sequence header emitted');
  }
  if (!seq.config.description || seq.config.description.length < 23) {
    throw new Error('sequence header lacks a real hvcC description');
  }
  if (videos.length < 1) throw new Error('no video chunks emitted');
  if (errors.length > 0) {
    throw new Error(`demux errors: ${JSON.stringify(errors.map((e) => e.error))}`);
  }
  console.log(`TS verify: ${seqs.length} sequence-header(s), ${videos.length} video chunks, 0 errors`);
  console.log(`TS codec:  ${seq.config.codec}`);
}

const isVerify = process.argv.includes('--verify') || process.argv.includes('--verify-ts');

if (isVerify) {
  // Verify modes must NOT rewrite committed fixtures: they validate the
  // existing on-disk files (the generator's output diverges from the
  // committed playlist — hevc-seg-0..9 in the repo, seg-0×10 in buildTs()).
  if (process.argv.includes('--verify-ts') || process.argv.includes('--verify')) {
    await verifyTs();
  }
  if (process.argv.includes('--verify')) {
    await verify();
  }
} else {
  const { codec, frames, bytes } = buildFlv();
  console.log(`source: ${inputPath}`);
  console.log(`target: ${outputPath}`);
  console.log(`codec:  ${codec}`);
  console.log(`frames: ${frames} VCL access units`);
  console.log(`size:   ${bytes} bytes`);

  const tsInfo = buildTs();
  console.log(`ts-target:   ${TS_OUTPUT} (${tsInfo.bytes} bytes, ${tsInfo.frames} access units)`);
  console.log(`ts-playlist: ${M3U8_OUTPUT}`);
}
