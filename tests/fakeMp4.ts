/** A minimal mp4 whose header declares `seconds`, for tests that measure. */
export function fakeMp4(seconds: number, padBytes = 0): Buffer {
  const timescale = 1_000;
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt8(0, 0);
  mvhd.writeUInt32BE(timescale, 12);
  mvhd.writeUInt32BE(Math.round(seconds * timescale), 16);
  return Buffer.concat([
    box("ftyp", Buffer.from("isom")),
    box("moov", box("mvhd", mvhd)),
    box("mdat", Buffer.alloc(padBytes)),
  ]);
}

function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.byteLength + 8, 0);
  header.write(type, 4, "ascii");
  return Buffer.concat([header, payload]);
}
