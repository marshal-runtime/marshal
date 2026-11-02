// Marshal-owned path
// Minimal ICNS container encoder/parser.
// ICNS layout: "icns" magic + UInt32BE total length, then entries of
// [4-byte OSType][UInt32BE length incl. 8-byte header][data]. Modern OSTypes
// (ic07..ic14) accept raw PNG data, which is what we write.

const MAGIC = "icns";

export function buffersToIcns(entries) {
  const chunks = [];
  let bodyLen = 0;
  for (const { type, data } of entries) {
    if (typeof type !== "string" || type.length !== 4) {
      throw new Error(`OSType must be exactly 4 characters: "${type}"`);
    }
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, "ascii");
    header.writeUInt32BE(data.length + 8, 4);
    chunks.push(header, data);
    bodyLen += data.length + 8;
  }
  const fileHeader = Buffer.alloc(8);
  fileHeader.write(MAGIC, 0, 4, "ascii");
  fileHeader.writeUInt32BE(bodyLen + 8, 4);
  return Buffer.concat([fileHeader, ...chunks]);
}

export function parseIcnsEntries(buf) {
  if (buf.toString("ascii", 0, 4) !== MAGIC) {
    throw new Error("not an icns file");
  }
  const total = buf.readUInt32BE(4);
  const entries = [];
  let offset = 8;
  while (offset < total) {
    const type = buf.toString("ascii", offset, offset + 4);
    const len = buf.readUInt32BE(offset + 4);
    entries.push({ type, data: buf.subarray(offset + 8, offset + len) });
    offset += len;
  }
  return { total, entries };
}
