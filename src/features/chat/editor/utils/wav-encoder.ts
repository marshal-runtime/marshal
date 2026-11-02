// Encode mono Float32 PCM samples into a 16-bit PCM WAV container.
// The transcription bridge expects WAV PCM 16kHz mono.

/**
 * Build a WAV (RIFF) file from mono Float32 samples.
 * @param samples mono PCM samples in [-1, 1].
 * @param sampleRate sample rate in Hz (e.g. 16000).
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytesPerSample = 2; // 16-bit
  const blockAlign = bytesPerSample; // mono
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  let offset = 0;
  const writeString = (s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset++, s.charCodeAt(i));
  };
  const writeUint32 = (v: number) => {
    view.setUint32(offset, v, true);
    offset += 4;
  };
  const writeUint16 = (v: number) => {
    view.setUint16(offset, v, true);
    offset += 2;
  };

  // RIFF header
  writeString("RIFF");
  writeUint32(36 + dataSize);
  writeString("WAVE");
  // fmt chunk
  writeString("fmt ");
  writeUint32(16); // PCM chunk size
  writeUint16(1); // PCM format
  writeUint16(1); // mono
  writeUint32(sampleRate);
  writeUint32(byteRate);
  writeUint16(blockAlign);
  writeUint16(8 * bytesPerSample); // bits per sample
  // data chunk
  writeString("data");
  writeUint32(dataSize);

  // PCM samples (clamped + scaled to int16)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}
