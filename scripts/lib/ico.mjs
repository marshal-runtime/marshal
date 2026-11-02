const ICONDIR_SIZE = 6;
const ENTRY_SIZE = 16;

export function buffersToIco(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("ICO requires at least one image");
  }

  const header = Buffer.alloc(ICONDIR_SIZE + ENTRY_SIZE * entries.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  let dataOffset = header.length;
  const images = [];
  entries.forEach(({ size, data }, index) => {
    if (!Number.isInteger(size) || size < 1 || size > 256) {
      throw new Error(`ICO frame size must be 1..256: ${size}`);
    }
    if (!Buffer.isBuffer(data) || data.length === 0) {
      throw new Error(`ICO frame ${size} must contain image data`);
    }

    const offset = ICONDIR_SIZE + index * ENTRY_SIZE;
    header[offset] = size === 256 ? 0 : size;
    header[offset + 1] = size === 256 ? 0 : size;
    header[offset + 2] = 0;
    header[offset + 3] = 0;
    header.writeUInt16LE(1, offset + 4);
    header.writeUInt16LE(32, offset + 6);
    header.writeUInt32LE(data.length, offset + 8);
    header.writeUInt32LE(dataOffset, offset + 12);
    dataOffset += data.length;
    images.push(data);
  });

  return Buffer.concat([header, ...images]);
}

export function parseIcoEntries(buffer) {
  if (buffer.length < ICONDIR_SIZE) throw new Error("ICO header is truncated");
  if (buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) {
    throw new Error("not an ICO file");
  }

  const count = buffer.readUInt16LE(4);
  const tableEnd = ICONDIR_SIZE + count * ENTRY_SIZE;
  if (buffer.length < tableEnd) throw new Error("ICO directory is truncated");

  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const offset = ICONDIR_SIZE + index * ENTRY_SIZE;
    const width = buffer[offset] || 256;
    const height = buffer[offset + 1] || 256;
    const bytes = buffer.readUInt32LE(offset + 8);
    const dataOffset = buffer.readUInt32LE(offset + 12);
    const dataEnd = dataOffset + bytes;
    if (dataOffset < tableEnd || dataEnd > buffer.length) {
      throw new Error(`ICO frame ${index} points outside the file`);
    }
    entries.push({
      width,
      height,
      colors: buffer[offset + 2],
      planes: buffer.readUInt16LE(offset + 4),
      bitDepth: buffer.readUInt16LE(offset + 6),
      data: buffer.subarray(dataOffset, dataEnd),
    });
  }
  return entries;
}
