import { BitReader } from './bit-reader.js';
import { formatError } from './errors.js';

/** HEVC NAL units carry a two-byte header (type + layer/temporal fields). */
export const NAL_HEADER_LENGTH = 2;
export const VPS_NUT = 32;
export const SPS_NUT = 33;
export const PPS_NUT = 34;

/**
 * Removes emulation-prevention bytes (`0x03`) that follow two consecutive zero
 * bytes, restoring the RBSP byte stream. Returns a fresh copy.
 */
export function removeEmulationPrevention(rbsp: Uint8Array): Uint8Array {
  const out = new Uint8Array(rbsp.length);
  let write = 0;
  let zeros = 0;
  for (let i = 0; i < rbsp.length; i++) {
    const byte = rbsp[i] as number;
    if (zeros >= 2 && byte === 3) {
      zeros = 0;
      continue;
    }
    out[write] = byte;
    write += 1;
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return out.slice(0, write);
}

/** Fields extracted from an HEVC SPS (enough to build an hvcC record). */
export interface HevcSpsInfo {
  generalProfileSpace: number;
  generalTierFlag: number;
  generalProfileIdc: number;
  generalProfileCompatibilityFlags: number;
  generalConstraintIndicatorFlags: Uint8Array;
  generalLevelIdc: number;
  maxSubLayersMinus1: number;
  temporalIdNestingFlag: number;
  chromaFormatIdc: number;
  bitDepthLumaMinus8: number;
  bitDepthChromaMinus8: number;
}

/** The general profile/tier/level subset of `HevcSpsInfo`. */
export type GeneralFields = Pick<
  HevcSpsInfo,
  | 'generalProfileSpace'
  | 'generalTierFlag'
  | 'generalProfileIdc'
  | 'generalProfileCompatibilityFlags'
  | 'generalConstraintIndicatorFlags'
  | 'generalLevelIdc'
>;

/** Reads the general profile/tier/level block of a `profile_tier_level`. */
function readProfileTierLevelGeneral(br: BitReader): GeneralFields {
  const generalProfileSpace = br.readBits(2);
  const generalTierFlag = br.readBits(1);
  const generalProfileIdc = br.readBits(5);
  const generalProfileCompatibilityFlags = br.readBits(32);
  const generalConstraintIndicatorFlags = new Uint8Array(6);
  for (let i = 0; i < 6; i++) {
    generalConstraintIndicatorFlags[i] = br.readBits(8);
  }
  const generalLevelIdc = br.readBits(8);
  return {
    generalProfileSpace,
    generalTierFlag,
    generalProfileIdc,
    generalProfileCompatibilityFlags,
    generalConstraintIndicatorFlags,
    generalLevelIdc,
  };
}

/** Skips the per-layer reserved/presence flags of `profile_tier_level`. */
function skipSubLayerProfileFlags(br: BitReader, maxSubLayersMinus1: number): void {
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    br.readBits(2); // reserved_zero_2bits
    const profilePresent = br.readFlag();
    const levelPresent = br.readFlag();
    if (profilePresent) {
      readProfileTierLevelGeneral(br);
    }
    if (levelPresent) {
      br.readBits(8);
    }
  }
}

/**
 * Parses the general profile/tier/level fields of an HEVC VPS. `nal` includes
 * the two-byte NAL header; the header and emulation-prevention bytes are
 * stripped before the RBSP is decoded. Only the general fields are returned.
 */
export function parseHevcVps(nal: Uint8Array): GeneralFields {
  if (nal.length <= NAL_HEADER_LENGTH) {
    throw formatError('malformed VPS: shorter than the NAL header');
  }
  const br = new BitReader(removeEmulationPrevention(nal.subarray(NAL_HEADER_LENGTH)));
  br.readBits(4); // vps_video_parameter_set_id
  br.readBits(2); // vps_reserved_three_2bits
  br.readBits(6); // vps_max_layers_minus1
  const maxSubLayersMinus1 = br.readBits(3);
  br.readBits(1); // vps_temporal_id_nesting_flag
  br.readBits(16); // vps_reserved_0xffff_16bits
  skipSubLayerProfileFlags(br, maxSubLayersMinus1);
  return readProfileTierLevelGeneral(br);
}

/**
 * Parses an HEVC SPS. `nal` includes the two-byte NAL header; the header and
 * emulation-prevention bytes are stripped first. Reads the profile/tier/level
 * block plus the fields needed to build an hvcC record.
 */
export function parseHevcSps(nal: Uint8Array): HevcSpsInfo {
  if (nal.length <= NAL_HEADER_LENGTH) {
    throw formatError('malformed SPS: shorter than the NAL header');
  }
  const br = new BitReader(removeEmulationPrevention(nal.subarray(NAL_HEADER_LENGTH)));
  br.readBits(4); // sps_video_parameter_set_id
  const maxSubLayersMinus1 = br.readBits(3);
  const temporalIdNestingFlag = br.readBits(1);
  skipSubLayerProfileFlags(br, maxSubLayersMinus1);
  const general = readProfileTierLevelGeneral(br);
  br.readUe(); // sps_seq_parameter_set_id
  const chromaFormatIdc = br.readUe();
  if (chromaFormatIdc === 3) {
    br.readFlag(); // separate_colour_plane_flag
  }
  br.readUe(); // pic_width_in_luma_samples
  br.readUe(); // pic_height_in_luma_samples
  if (br.readFlag()) {
    // conformance_window_flag: four offsets
    br.readUe();
    br.readUe();
    br.readUe();
    br.readUe();
  }
  const bitDepthLumaMinus8 = br.readUe();
  const bitDepthChromaMinus8 = br.readUe();
  return {
    ...general,
    maxSubLayersMinus1,
    temporalIdNestingFlag,
    chromaFormatIdc,
    bitDepthLumaMinus8,
    bitDepthChromaMinus8,
  };
}

export { buildHvcC, codecStringFromHvcC, parseHvcC } from './hvcc.js';
export type { HvcCArray, HvcCInput, HvcCParsed } from './hvcc.js';
