/**
 * WAV assembly. The device streams raw PCM in 10-second chunks; a finished
 * take is those chunks in order behind a standard 44-byte RIFF header.
 */

// Must match the firmware's capture settings.
export const SAMPLE_RATE = 16_000;
export const CHANNELS = 1;
export const BITS_PER_SAMPLE = 16;

/** Bytes of PCM in one full chunk: 10 s of 16 kHz mono 16-bit audio. */
export const CHUNK_BYTES = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8) * 10;

/** Most chunks one take may have: 2,000 × 10 s is over five hours. */
export const MAX_CHUNKS = 2000;

/** The 44-byte header for a WAV file holding `dataBytes` bytes of PCM. */
export function wavHeader(dataBytes: number): Uint8Array {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const ascii = (offset: number, text: string) =>
    header.set(new TextEncoder().encode(text), offset);
  const blockAlign = CHANNELS * (BITS_PER_SAMPLE / 8);

  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true); // size of everything after this field
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size for PCM
  view.setUint16(20, 1, true); // format: linear PCM
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  return header;
}

/** Concatenates PCM chunks (already in order) into one WAV file. */
export function assembleWav(chunks: readonly Uint8Array[]): Uint8Array {
  const dataBytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const wav = new Uint8Array(44 + dataBytes);
  wav.set(wavHeader(dataBytes), 0);
  let offset = 44;
  for (const chunk of chunks) {
    wav.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return wav;
}

/** Whole seconds of audio in `dataBytes` bytes of PCM. */
export function durationSeconds(dataBytes: number): number {
  return Math.round(dataBytes / (SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8)));
}
