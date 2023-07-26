import { ExactBytesTransformStream } from "https://deno.land/x/stream_slicing@v1.1.0/exact_bytes_transform_stream.ts";
import type { ExtendedTimestamps } from "./_read_extra_field.ts";

export type WriteBody = {
  compressed?: null;
  originalSize: number;
  originalCrc: number;
  stream: ReadableStream<Uint8Array>;
} | {
  compressed: "deflate";
  originalSize: number;
  compressedSize: number;
  originalCrc: number;
  stream: ReadableStream<Uint8Array>;
};

export type WriteEntry = {
  type: "file";
  name: string;
  extendedTimestamps?: ExtendedTimestamps;
  body: WriteBody;
} | {
  type: "directory";
  name: string;
  extendedTimestamps?: ExtendedTimestamps;
};

export interface WriteOptions {
  signal?: AbortSignal;
  /** If set to true, then the zip central directory entries will not be included.
   * Only use this if the output is only intended to be read by a streaming decoder that only
   * needs the local file entries, such as this library's read() function. */
  omitCentralDirectory?: boolean;
}

export function write(
  entries: Iterable<WriteEntry> | AsyncIterable<WriteEntry>,
  options: WriteOptions = {},
): ReadableStream<Uint8Array> {
  const { signal } = options;
  const ts = new TransformStream<Uint8Array>();

  async function run() {
    const centralDirectoryFileHeaders: Uint8Array[] = [];
    let totalBytesWritten = 0;
    let totalFilesWritten = 0;

    for await (const entry of entries) {
      signal?.throwIfAborted();
      const result = await writeLocalFileEntry(
        entry,
        ts.writable,
        totalBytesWritten,
        signal,
      );
      if (!options.omitCentralDirectory) {
        centralDirectoryFileHeaders.push(
          ...result.centralDirectoryFileHeaders(),
        );
      }
      totalBytesWritten += result.bytesWritten;
      totalFilesWritten += 1;
    }

    const writer = ts.writable.getWriter();
    try {
      if (!options.omitCentralDirectory) {
        // This page is useful for describing the central directory file headers with zip64 extensions:
        // https://blog.yaakov.online/zip64-go-big-or-go-home/
        const offsetOfCentralDirectory = totalBytesWritten;

        for (const part of centralDirectoryFileHeaders) {
          signal?.throwIfAborted();
          await writer.ready;
          await writer.write(part);
          totalBytesWritten += part.byteLength;
        }
        signal?.throwIfAborted();
        await writer.ready;

        const zip64EndOfCentralDirectoryRecordSize = 56;
        const zip64EndOfCentralDirectoryLocatorSize = 20;
        const endOfCentralDirectoryRecordSize = 22;

        const ending = new Uint8Array(
          zip64EndOfCentralDirectoryRecordSize +
            zip64EndOfCentralDirectoryLocatorSize +
            endOfCentralDirectoryRecordSize,
        );

        // zip64 end of central directory record
        const zip64EndOfCentralDirectoryRecord = new DataView(
          ending.buffer,
          0,
          zip64EndOfCentralDirectoryRecordSize,
        );
        zip64EndOfCentralDirectoryRecord.setUint32(0, 0x06064b50, true);
        zip64EndOfCentralDirectoryRecord.setBigUint64(
          4,
          BigInt(zip64EndOfCentralDirectoryRecordSize - 12),
          true,
        );
        zip64EndOfCentralDirectoryRecord.setUint16(12, 45, true);
        zip64EndOfCentralDirectoryRecord.setUint16(14, 45, true);

        zip64EndOfCentralDirectoryRecord.setBigUint64(
          24,
          BigInt(totalFilesWritten),
          true,
        );
        zip64EndOfCentralDirectoryRecord.setBigUint64(
          32,
          BigInt(totalFilesWritten),
          true,
        );
        const sizeOfCentralDirectory = totalBytesWritten -
          offsetOfCentralDirectory;
        zip64EndOfCentralDirectoryRecord.setBigUint64(
          40,
          BigInt(sizeOfCentralDirectory),
          true,
        );
        zip64EndOfCentralDirectoryRecord.setBigUint64(
          48,
          BigInt(offsetOfCentralDirectory),
          true,
        );

        // zip64 end of central directory locator
        const zip64EndOfCentralDirectoryLocator = new DataView(
          ending.buffer,
          zip64EndOfCentralDirectoryRecordSize,
          zip64EndOfCentralDirectoryLocatorSize,
        );
        zip64EndOfCentralDirectoryLocator.setUint32(0, 0x07064b50, true);
        const offsetOfZip64EndOfCentralDirectoryRecord = totalBytesWritten;
        zip64EndOfCentralDirectoryLocator.setBigUint64(
          8,
          BigInt(offsetOfZip64EndOfCentralDirectoryRecord),
          true,
        );
        zip64EndOfCentralDirectoryLocator.setUint32(16, 1, true);

        // end of central directory record
        const endOfCentralDirectoryRecord = new DataView(
          ending.buffer,
          zip64EndOfCentralDirectoryRecordSize +
            zip64EndOfCentralDirectoryLocatorSize,
          endOfCentralDirectoryRecordSize,
        );
        endOfCentralDirectoryRecord.setUint32(0, 0x06054b50, true);
        endOfCentralDirectoryRecord.setUint16(8, 0xffff, true);
        endOfCentralDirectoryRecord.setUint16(10, 0xffff, true);
        endOfCentralDirectoryRecord.setUint32(12, 0xffffffff, true);
        endOfCentralDirectoryRecord.setUint32(16, 0xffffffff, true);

        await writer.write(ending);
      }

      // we're all done writing
      signal?.throwIfAborted();
      await writer.ready;
      await writer.close();
    } finally {
      writer.releaseLock();
    }
  }

  run().catch((err) => {
    ts.writable.abort(err);
  });

  return ts.readable;
}

interface WriteLocalFileEntryResult {
  bytesWritten: number;
  centralDirectoryFileHeaders(): Uint8Array[];
}

/** Returns a callback for data to later be put into the central file directory headers. */
async function writeLocalFileEntry(
  entry: WriteEntry,
  writable: WritableStream<Uint8Array>,
  lfhOffset: number,
  signal?: AbortSignal,
): Promise<WriteLocalFileEntryResult> {
  let bytesWritten = 0;
  let fileName: Uint8Array;

  const writer = writable.getWriter();
  try {
    await writer.ready;
    const localFileHeaderStart = new Uint8Array(30);

    const headerDv = new DataView(
      localFileHeaderStart.buffer,
      localFileHeaderStart.byteOffset,
      localFileHeaderStart.byteLength,
    );
    headerDv.setUint32(0, 0x04034b50, true);

    const versionNeeded = 45;
    headerDv.setUint16(4, versionNeeded, true);

    if (entry.type === "file" && entry.body.compressed) {
      headerDv.setUint16(8, 8, true);
    }

    // We're not even bothering setting the regular zip file timestamps.
    // We're only using the extended timestamps out of laziness.

    if (entry.type === "file") {
      headerDv.setUint32(14, entry.body.originalCrc, true);
    }

    // We're always enabling zip64
    headerDv.setUint32(18, 0xffffffff, true);
    headerDv.setUint32(22, 0xffffffff, true);

    fileName = new TextEncoder().encode(entry.name);
    if (fileName.byteLength >= 2 ** 16) {
      throw new Error(`Filename is too long (${fileName.byteLength} bytes)`);
    }
    headerDv.setUint16(26, fileName.byteLength, true);

    const extraField = createExtraField(entry);
    headerDv.setUint16(28, extraField?.byteLength ?? 0, true);

    bytesWritten += localFileHeaderStart.byteLength + fileName.byteLength;
    await writer.write(localFileHeaderStart);
    await writer.write(fileName);
    if (extraField) {
      bytesWritten += extraField.byteLength;
      await writer.write(extraField);
    }
  } finally {
    writer.releaseLock();
  }

  if (entry.type === "file") {
    const len = entry.body.compressed
      ? entry.body.compressedSize
      : entry.body.originalSize;
    await entry.body.stream
      .pipeThrough(
        new ExactBytesTransformStream(len),
        { signal },
      ).pipeTo(
        writable,
        { preventClose: true, signal },
      );
    bytesWritten += len;
  }

  // thunk for creating central directory file headers.
  const centralDirectoryFileHeaders = () => {
    const centralHeader = new Uint8Array(46);
    const centralHeaderDv = new DataView(
      centralHeader.buffer,
      centralHeader.byteOffset,
      centralHeader.byteLength,
    );
    centralHeaderDv.setUint32(0, 0x02014b50, true);
    const versionMadeBy = 45;
    centralHeaderDv.setUint16(4, versionMadeBy, true);
    const versionNeeded = 45;
    centralHeaderDv.setUint16(6, versionNeeded, true);
    const flags = 0;
    centralHeaderDv.setUint16(8, flags, true);
    if (entry.type === "file" && entry.body.compressed) {
      centralHeaderDv.setUint16(10, 8, true);
    }
    // also skipping vanilla zip timestamps here
    if (entry.type === "file") {
      centralHeaderDv.setUint32(16, entry.body.originalCrc, true);
    }

    // We're always enabling zip64
    centralHeaderDv.setUint32(20, 0xffffffff, true);
    centralHeaderDv.setUint32(24, 0xffffffff, true);

    centralHeaderDv.setUint16(28, fileName.byteLength, true);

    const centralHeaderExtraField = createExtraField(entry, lfhOffset);
    centralHeaderDv.setUint16(
      30,
      centralHeaderExtraField?.byteLength ?? 0,
      true,
    );

    // We're using the zip64 extra field to store lfh offset instead of this.
    centralHeaderDv.setUint32(42, 0xffffffff, true);

    const result = [centralHeader, fileName];
    if (centralHeaderExtraField) {
      result.push(centralHeaderExtraField);
    }
    return result;
  };

  return { bytesWritten, centralDirectoryFileHeaders };
}

/** `lfhOffset` should only be passed in for central directory file header. */
function createExtraField(
  entry: WriteEntry,
  lfhOffset?: number,
): Uint8Array | undefined {
  const originalSize = entry.type === "file" ? entry.body.originalSize : 0;
  const compressedSize = entry.type === "file"
    ? (entry.body.compressed
      ? entry.body.compressedSize
      : entry.body.originalSize)
    : 0;

  const result = new Uint8Array(4 + 16 + (lfhOffset == null ? 0 : 8) + 4 + 13);
  const resultDv = new DataView(
    result.buffer,
    result.byteOffset,
    result.byteLength,
  );

  let pos = 0;

  // zip64
  resultDv.setUint16(0, 0x1, true);
  resultDv.setBigUint64(4, BigInt(originalSize), true);
  resultDv.setBigUint64(12, BigInt(compressedSize), true);

  if (lfhOffset == null) {
    resultDv.setUint16(2, 16, true);
    pos = 20;
  } else {
    resultDv.setUint16(2, 24, true);
    resultDv.setBigUint64(20, BigInt(lfhOffset), true);
    pos = 28;
  }

  // extended timestamps
  if (entry.extendedTimestamps) {
    resultDv.setUint16(pos, 0x5455, true);
    let xLen = 1;
    let flags = 0;
    if (entry.extendedTimestamps.modifyTime) {
      flags |= 0x1;
      resultDv.setUint32(
        pos + 4 + xLen,
        entry.extendedTimestamps.modifyTime.getTime() / 1000,
        true,
      );
      xLen += 4;
    }
    if (entry.extendedTimestamps.accessTime) {
      flags |= 0x2;
      resultDv.setUint32(
        pos + 4 + xLen,
        entry.extendedTimestamps.accessTime.getTime() / 1000,
        true,
      );
      xLen += 4;
    }
    if (entry.extendedTimestamps.createTime) {
      flags |= 0x4;
      resultDv.setUint32(
        pos + 4 + xLen,
        entry.extendedTimestamps.createTime.getTime() / 1000,
        true,
      );
      xLen += 4;
    }
    resultDv.setUint16(pos + 2, xLen, true);
    resultDv.setUint8(pos + 4, flags);
    pos += 4 + xLen;
  }

  if (pos === 0) {
    return undefined;
  }
  return result.slice(0, pos);
}
