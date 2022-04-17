export interface ExtendedTimestamps {
  modifyTime?: Date;
  accessTime?: Date;
  createTime?: Date;
}

export interface Zip64ExtendedInformation {
  originalSize: number;
  compressedSize: number;
}

export interface ParsedExtraFields {
  zip64?: Zip64ExtendedInformation;
  extendedTimestamps?: ExtendedTimestamps;
}

export function parseExtraField(extraField: Uint8Array): ParsedExtraFields {
  const result: ParsedExtraFields = {};
  for (const { tag, data } of splitExtraFieldParts(extraField)) {
    switch (tag) {
      case 0x1: { // zip64
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const originalSize = Number(dv.getBigUint64(0, true));
        const compressedSize = Number(dv.getBigUint64(8, true));
        result.zip64 = { originalSize, compressedSize };
        break;
      }
      case 0x5455: { // extended timestamp
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const flags = dv.getUint8(0);
        const timestamps: ExtendedTimestamps = {};
        let pos = 1;
        if (flags & 0x1) {
          timestamps.modifyTime = new Date(dv.getInt32(pos, true) * 1000);
          pos += 4;
        }
        if (flags & 0x2) {
          timestamps.accessTime = new Date(dv.getInt32(pos, true) * 1000);
          pos += 4;
        }
        if (flags & 0x4) {
          timestamps.createTime = new Date(dv.getInt32(pos, true) * 1000);
          pos += 4;
        }
        result.extendedTimestamps = timestamps;
        break;
      }
    }
  }
  return result;
}

interface ExtraFieldPart {
  tag: number;
  data: Uint8Array;
}

function* splitExtraFieldParts(
  extraField: Uint8Array,
): Generator<ExtraFieldPart> {
  const dv = new DataView(
    extraField.buffer,
    extraField.byteOffset,
    extraField.byteLength,
  );
  let pos = 0;
  while (extraField.length >= pos + 4) {
    const tag = dv.getUint16(pos, true);
    const len = dv.getUint16(pos + 2, true);
    if (pos + 4 + len > extraField.length) {
      throw new Error("Invalid extra field");
    }
    const data = extraField.subarray(pos + 4, pos + 4 + len);
    yield { tag, data };
    pos += 4 + len;
  }
}
