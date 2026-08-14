/**
 * PCM passthrough codec: 16-bit signed little-endian PCM is the vigilkit
 * soft-audio intermediate format. The "codec" is the identity on Int16 ↔ bytes.
 */

/** Encodes Int16 PCM samples as little-endian 16-bit bytes. */
export function pcmEncodeInt16(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i]!, true);
  return out;
}

/** Decodes little-endian 16-bit bytes into Int16 PCM samples. */
export function pcmDecodeInt16(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(Math.floor(bytes.length / 2));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}
