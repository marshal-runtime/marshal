import { randomInt, randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const DIGITS = [
  ["01110", "11011", "11011", "11011", "11011", "11011", "01110"],
  ["00110", "01110", "00110", "00110", "00110", "00110", "11111"],
  ["01110", "11011", "00011", "00110", "01100", "11000", "11111"],
  ["11110", "00011", "00011", "01110", "00011", "00011", "11110"],
  ["11011", "11011", "11011", "11111", "00011", "00011", "00011"],
  ["11111", "11000", "11000", "11110", "00011", "00011", "11110"],
  ["01110", "11000", "11000", "11110", "11011", "11011", "01110"],
  ["11111", "00011", "00110", "00110", "01100", "01100", "01100"],
  ["01110", "11011", "11011", "01110", "11011", "11011", "01110"],
  ["01110", "11011", "11011", "01111", "00011", "00011", "01110"],
];

export function createVisualMarkerPng(code) {
  if (!/^\d{6}$/.test(code)) throw new Error("The visual marker must contain six digits.");
  const width = 1200;
  const height = 700;
  const stride = width * 3 + 1;
  const pixels = Buffer.alloc(stride * height, 255);
  for (let y = 0; y < height; y++) pixels[y * stride] = 0;
  function pixel(x, y, color) {
    const start = y * stride + 1 + x * 3;
    pixels[start] = color[0];
    pixels[start + 1] = color[1];
    pixels[start + 2] = color[2];
  }
  function rectangle(x, y, w, h, color) {
    for (let row = y; row < y + h; row++) {
      for (let column = x; column < x + w; column++) pixel(column, row, color);
    }
  }
  const scale = 25;
  for (const [position, digit] of [...code].entries()) {
    for (const [row, bits] of DIGITS[Number(digit)].entries()) {
      for (const [column, bit] of [...bits].entries()) {
        if (bit === "1")
          rectangle(
            95 + position * 175 + column * scale,
            105 + row * scale,
            scale,
            scale,
            [18, 24, 32],
          );
      }
    }
  }
  rectangle(70, 350, 1060, 3, [220, 224, 232]);
  for (const [center, color] of [
    [260, [232, 62, 62]],
    [600, [24, 168, 85]],
    [940, [53, 109, 232]],
  ]) {
    for (let y = 432; y <= 608; y++) {
      for (let x = center - 88; x <= center + 88; x++) {
        if ((x - center) ** 2 + (y - 520) ** 2 <= 88 ** 2) pixel(x, y, color);
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, bytes) {
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32BE(bytes.length, 0);
  prefix.write(type, 4, 4, "ascii");
  const payload = Buffer.concat([prefix.subarray(4), bytes]);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const suffix = Buffer.alloc(4);
  suffix.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([prefix, bytes, suffix]);
}

export async function writeVisualMarker(
  outputPath = path.join(tmpdir(), `marshal-visual-${randomUUID()}.png`),
  code = String(randomInt(0, 1_000_000)).padStart(6, "0"),
) {
  const bytes = createVisualMarkerPng(code);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, bytes, { flag: "wx", mode: 0o600 });
  return {
    path: outputPath,
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    expected: { code, middleCircleColor: "green" },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await writeVisualMarker(process.argv[2], process.argv[3]);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
