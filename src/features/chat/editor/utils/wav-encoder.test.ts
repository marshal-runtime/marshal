import { describe, expect, it } from "vitest";

import { encodeWav } from "./wav-encoder";

/** Read a little-endian ASCII tag from a WAV byte buffer. */
function tag(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

function readUint32LE(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

describe("encodeWav", () => {
  it("writes a valid RIFF/WAVE PCM header", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const wav = encodeWav(samples, 16000);
    const view = new DataView(wav.buffer);

    expect(tag(wav, 0)).toBe("RIFF");
    expect(tag(wav, 8)).toBe("WAVE");
    expect(tag(wav, 12)).toBe("fmt ");
    expect(tag(wav, 36)).toBe("data");

    expect(readUint32LE(view, 16)).toBe(16); // PCM fmt chunk size
    expect(view.getUint16(20, true)).toBe(1); // PCM format
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(readUint32LE(view, 24)).toBe(16000); // sample rate
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
  });

  it("sizes the data chunk to 2 bytes per sample", () => {
    const samples = new Float32Array(100);
    const wav = encodeWav(samples, 16000);
    const view = new DataView(wav.buffer);
    expect(readUint32LE(view, 40)).toBe(200); // data size = 100 * 2
    expect(wav.byteLength).toBe(44 + 200); // header + data
  });

  it("clamps and scales samples to int16 range", () => {
    const wav = encodeWav(new Float32Array([1, -1, 2, -2]), 16000);
    const view = new DataView(wav.buffer);
    // First sample at byte 44.
    expect(view.getInt16(44, true)).toBe(32767); // +1 -> max
    expect(view.getInt16(46, true)).toBe(-32768); // -1 -> min
    expect(view.getInt16(48, true)).toBe(32767); // +2 clamped to +1
    expect(view.getInt16(50, true)).toBe(-32768); // -2 clamped to -1
  });
});
