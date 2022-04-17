import { decompressDeflateRaw } from "./_deflate_raw.ts";
import { ExactBytesTransformStream } from "./stream_utils/exact_bytes_transform_stream.ts";
import { PartialReader } from "./stream_utils/partial_reader.ts";
import { ExtendedTimestamps, parseExtraField } from "./_extra_field.ts";

export type ReadEntry = {
  type: "file";
  name: string;
  extendedTimestamps?: ExtendedTimestamps;
  size: number;
  body: OptionalStream;
} | {
  type: "directory";
  name: string;
  extendedTimestamps?: ExtendedTimestamps;
};

export interface OptionalStream {
  stream(): ReadableStream<Uint8Array>;
  autodrain(): void;
}

/** Each Entry's body must be consumed or canceled in order for read to
 * continue. TODO should we offer a way to get raw compressed data? */
export async function* read(
  stream: ReadableStream<Uint8Array>,
  options: { signal?: AbortSignal } = {},
): AsyncIterable<ReadEntry> {
  // TODO use abort signal
  const textDecoder = new TextDecoder();

  const partialReader = PartialReader.fromStream(stream);
  while (true) {
    const header = await partialReader.readUpToAmount(30);
    if (header.length === 0) {
      break;
    }
    if (header.length !== 30) {
      throw new Error("stream ended unexpectedly");
    }
    const headerDv = new DataView(
      header.buffer,
      header.byteOffset,
      header.byteLength,
    );
    const signature = headerDv.getInt32(0, true);
    if (signature === 0x02014b50) {
      // Central directory file header signature
      break;
    }
    if (signature !== 0x04034b50) {
      throw new Error(
        "Bad signature. The input may not be a zip file, or it may not start with a local file header, which read() requires.",
      );
    }

    const version = headerDv.getUint16(4, true);
    if (version > 45) {
      throw new Error(
        `File requires to high of version to extract (${version})`,
      );
    }

    const flags = headerDv.getUint16(6, true);
    if (flags & 0x1 || flags & 0x40) {
      throw new Error("Encrypted files are not supported");
    }
    if (flags & 0x8) {
      throw new Error(
        "read() does not support zip files using data descriptors",
      );
    }
    if (flags & 0x20) {
      throw new Error("Patch data is not supported");
    }

    const compressionMethod = headerDv.getUint16(8, true);

    // Not even bothering with the standard zip timestamps because they have weird precision
    // and their timezone isn't even defined.
    // const fileModificationTime = headerDv.getUint16(10, true);
    // const fileModificationDate = headerDv.getUint16(12, true);

    const crc = headerDv.getUint32(14, true);
    let compressedSize = headerDv.getUint32(18, true);
    let uncompressedSize = headerDv.getUint32(22, true);

    const fileNameLength = headerDv.getUint16(26, true);
    const extraFieldLength = headerDv.getUint16(28, true);
    const fileName = textDecoder.decode(
      await partialReader.exactRead(fileNameLength),
    );

    let type: ReadEntry["type"] | undefined;
    if (fileName.endsWith("/")) {
      type = "directory";
    } else {
      type = "file";
    }

    const extraFieldRaw = await partialReader.exactRead(extraFieldLength);
    const parsedExtraFields = parseExtraField(extraFieldRaw);

    if (parsedExtraFields.zip64) {
      compressedSize = parsedExtraFields.zip64.compressedSize;
      uncompressedSize = parsedExtraFields.zip64.originalSize;
    }

    let bodyMethodFinished: Promise<void> | undefined;
    const body: OptionalStream = {
      stream() {
        if (bodyMethodFinished) {
          throw new Error("body already used");
        }
        const bodyStream = partialReader.streamUpToAmount(compressedSize);
        bodyMethodFinished = bodyStream.onConsumed;

        let stream = bodyStream.stream.pipeThrough(
          new ExactBytesTransformStream(compressedSize),
        );
        switch (compressionMethod) {
          case 0:
            break;
          case 8: {
            stream = decompressDeflateRaw(stream, crc, uncompressedSize);
            break;
          }
          default: {
            throw new Error(`Unknown compression method: ${compressionMethod}`);
          }
        }
        return stream;
      },
      autodrain() {
        if (bodyMethodFinished) {
          throw new Error("body already used");
        }
        bodyMethodFinished = partialReader.skipUpToAmount(compressedSize);
      },
    };

    if (type !== undefined) {
      if (type === "file") {
        yield {
          type,
          name: fileName,
          extendedTimestamps: parsedExtraFields.extendedTimestamps,
          size: uncompressedSize,
          body,
        };
      } else {
        body.autodrain();
        yield {
          type,
          name: fileName,
          extendedTimestamps: parsedExtraFields.extendedTimestamps,
        };
      }
    } else {
      // don't yield entries for things we don't understand
      body.autodrain();
    }
    if (!bodyMethodFinished) {
      throw new Error(
        "The body property of entry must be streamed or autodrained before continuing iteration",
      );
    }
    await bodyMethodFinished;
  }
  await partialReader.cancel();
}
