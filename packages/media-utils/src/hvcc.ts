import { ByteReader } from './byte-reader.js';
import { formatError } from './errors.js';
import { parseHevcSps, PPS_NUT, SPS_NUT, VPS_NUT } from './hevc.js';

/** Input for `buildHvcC`: complete VPS/SPS/PPS NAL units (headers included). */
export interface HvcCInput {
  vps: Uint8Array;
  sps: Uint8Array;
  pps: Uint8Array;
  lengthSizeMinusOne?: number;
}

/** A parameter-set array inside an HEVCDecoderConfigurationRecord. */
export interface HvcCArray {
  naluType: number;
  nalus: Uint8Array[];
}

/** The parsed contents of an HEVCDecoderConfigurationRecord. */
export interface HvcCParsed {
  codec: string;
  description: Uint8Array;
  profileIdc: number;
  levelIdc: number;
  lengthSizeMinusOne: number;
  arrays: HvcCArray[];
}

/**
 * Builds a byte-exact HEVCDecoderConfigurationRecord (hvcC) from VPS/SPS/PPS
 * NAL units, storing the parameter-set arrays in the order [32, 33, 34].
 * The general profile/tier/level fields are taken from the SPS.
 */
export function buildHvcC(input: HvcCInput): Uint8Array {
  const { vps, sps, pps } = input;
  const lengthSizeMinusOne = input.lengthSizeMinusOne ?? 3;
  const info = parseHevcSps(sps);
  const arrays: Array<{ type: number; nalus: Uint8Array[] }> = [
    { type: VPS_NUT, nalus: [vps] },
    { type: SPS_NUT, nalus: [sps] },
    { type: PPS_NUT, nalus: [pps] },
  ];
  const numTemporalLayers = info.maxSubLayersMinus1 + 1;
  const byte21 =
    (numTemporalLayers << 3) | (info.temporalIdNestingFlag << 2) | (lengthSizeMinusOne & 0x03);

  let size = 23; // fixed header
  for (const array of arrays) {
    size += 1 + 2; // array header + numNalus
    for (const nalu of array.nalus) size += 2 + nalu.length;
  }
  const out = new Uint8Array(size);
  let pos = 0;
  out[pos++] = 1; // configurationVersion
  out[pos++] =
    (info.generalProfileSpace << 6) |
    (info.generalTierFlag << 5) |
    (info.generalProfileIdc & 0x1f);
  out[pos++] = (info.generalProfileCompatibilityFlags >>> 24) & 0xff;
  out[pos++] = (info.generalProfileCompatibilityFlags >>> 16) & 0xff;
  out[pos++] = (info.generalProfileCompatibilityFlags >>> 8) & 0xff;
  out[pos++] = info.generalProfileCompatibilityFlags & 0xff;
  out.set(info.generalConstraintIndicatorFlags, pos);
  pos += 6;
  out[pos++] = info.generalLevelIdc;
  out[pos++] = 0xf0; // reserved(4) | min_spatial_segmentation_idc(12) = 0
  out[pos++] = 0x00;
  out[pos++] = 0xfc; // reserved(6) | parallelismType(2) = 0
  out[pos++] = 0xfc | (info.chromaFormatIdc & 0x03);
  out[pos++] = 0xf8 | (info.bitDepthLumaMinus8 & 0x07);
  out[pos++] = 0xf8 | (info.bitDepthChromaMinus8 & 0x07);
  out[pos++] = 0x00; // avgFrameRate (high)
  out[pos++] = 0x00; // avgFrameRate (low)
  out[pos++] = byte21;
  out[pos++] = arrays.length; // numOfArrays
  for (const array of arrays) {
    out[pos++] = 0x80 | array.type; // array_completeness | reserved(1) | NAL_unit_type
    out[pos++] = (array.nalus.length >> 8) & 0xff;
    out[pos++] = array.nalus.length & 0xff;
    for (const nalu of array.nalus) {
      out[pos++] = (nalu.length >> 8) & 0xff;
      out[pos++] = nalu.length & 0xff;
      out.set(nalu, pos);
      pos += nalu.length;
    }
  }
  return out;
}

/**
 * Parses an HEVCDecoderConfigurationRecord into its header fields, parameter
 * arrays and the `hvc1` codec string.
 */
export function parseHvcC(hvcC: Uint8Array): HvcCParsed {
  if (hvcC.length < 23) {
    throw formatError(`malformed hvcC: shorter than 23 bytes (${hvcC.length})`);
  }
  const reader = new ByteReader(hvcC);
  const configurationVersion = reader.readU8();
  if (configurationVersion !== 1) {
    throw formatError(`malformed hvcC: configurationVersion ${configurationVersion}`);
  }
  const byte1 = reader.readU8();
  const generalTierFlag = (byte1 >> 5) & 1;
  const generalProfileIdc = byte1 & 0x1f;
  const generalProfileCompatibilityFlags = reader.readU32();
  const generalConstraintIndicatorFlags = reader.readBytes(6);
  const generalLevelIdc = reader.readU8();
  reader.skip(2); // min_spatial_segmentation_idc
  reader.readU8(); // parallelismType
  reader.readU8(); // chromaFormat
  reader.readU8(); // bitDepthLumaMinus8
  reader.readU8(); // bitDepthChromaMinus8
  reader.skip(2); // avgFrameRate
  const lengthSizeMinusOne = reader.readU8() & 0x03;
  const numOfArrays = reader.readU8();
  if (numOfArrays > 32) {
    throw formatError(`malformed hvcC: numOfArrays ${numOfArrays}`);
  }
  const arrays: HvcCArray[] = [];
  for (let i = 0; i < numOfArrays; i++) {
    const naluType = reader.readU8() & 0x3f;
    const numNalus = reader.readU16();
    if (numNalus > 1024) {
      throw formatError(`malformed hvcC: numNalus ${numNalus}`);
    }
    const nalus: Uint8Array[] = [];
    for (let j = 0; j < numNalus; j++) {
      nalus.push(reader.readBytes(reader.readU16()));
    }
    arrays.push({ naluType, nalus });
  }
  return {
    codec: codecStringFromFields(
      generalProfileIdc,
      generalTierFlag,
      generalProfileCompatibilityFlags,
      generalConstraintIndicatorFlags,
      generalLevelIdc,
    ),
    description: hvcC.slice(),
    profileIdc: generalProfileIdc,
    levelIdc: generalLevelIdc,
    lengthSizeMinusOne,
    arrays,
  };
}

/**
 * Derives the `hvc1` codec string from an HEVCDecoderConfigurationRecord
 * (ISO/IEC 14496-15 §E.3): profile, compatibility flags, tier/level and
 * constraint bytes, with leading/trailing zero components omitted.
 */
export function codecStringFromHvcC(hvcC: Uint8Array): string {
  if (hvcC.length < 23) {
    throw formatError(`malformed hvcC: shorter than 23 bytes (${hvcC.length})`);
  }
  const byte1 = hvcC[1] as number;
  const compat =
    ((((hvcC[2] as number) << 24) |
      ((hvcC[3] as number) << 16) |
      ((hvcC[4] as number) << 8) |
      (hvcC[5] as number)) >>>
      0);
  return codecStringFromFields(
    byte1 & 0x1f,
    (byte1 >> 5) & 1,
    compat,
    hvcC.slice(6, 12),
    hvcC[12] as number,
  );
}

/** Reverses the bit order of a 32-bit value. */
function reverseBits32(value: number): number {
  let reversed = 0;
  for (let i = 0; i < 32; i++) {
    reversed = (reversed << 1) | (value & 1);
    value >>>= 1;
  }
  return reversed >>> 0;
}

function codecStringFromFields(
  profileIdc: number,
  tierFlag: number,
  compatibilityFlags: number,
  constraint: Uint8Array,
  levelIdc: number,
): string {
  const compatHex = reverseBits32(compatibilityFlags).toString(16).replace(/^0+/, '') || '0';
  let start = 0;
  let end = constraint.length;
  while (start < end && (constraint[start] as number) === 0) start += 1;
  while (end > start && (constraint[end - 1] as number) === 0) end -= 1;
  let constraintPart = '';
  if (start < end) {
    const bytes: string[] = [];
    for (let i = start; i < end; i++) {
      bytes.push((constraint[i] as number).toString(16).padStart(2, '0').toUpperCase());
    }
    constraintPart = `.${bytes.join('.')}`;
  }
  return `hvc1.${profileIdc}.${compatHex}.${tierFlag ? 'H' : 'L'}${levelIdc}${constraintPart}`;
}
