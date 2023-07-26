import { decompressDeflateRaw } from "./_deflate_raw.ts";
import { ExactBytesTransformStream } from "https://deno.land/x/stream_slicing@v1.1.0/exact_bytes_transform_stream.ts";
import { PartialReader } from "https://deno.land/x/stream_slicing@v1.1.0/partial_reader.ts";
import { ExtendedTimestamps, parseExtraField } from "./_read_extra_field.ts";

export type ReadEntry = {
  type: "file";
  name: string;
  extendedTimestamps?: ExtendedTimestamps;
  originalSize: number;
  compressedSize: number;
  crc: number;
  body: OptionalStream;
} | {
  type: "directory";
  name: string;
  extendedTimestamps?: ExtendedTimestamps;
};

// TODO method to get raw compressed data
export interface OptionalStream {
  stream(): ReadableStream<Uint8Array>;
  autodrain(): void;
}

export interface ReadOptions {
  signal?: AbortSignal;
}

// TODO should we offer a way to get raw compressed data?
// TODO should we make ReadEntry objects be compatible with the WriteEntry
// type accepted by write()?

/** Each Entry's body must be consumed or canceled in order for read to
 * continue. */
export async function* read(
  stream: ReadableStream<Uint8Array> | PartialReader,
  options: ReadOptions = {},
): AsyncIterable<ReadEntry> {
  const { signal } = options;
  const textDecoder = new TextDecoder();

  const partialReader = stream instanceof ReadableStream
    ? PartialReader.fromStream(stream)
    : stream;

  const cancelPartialReader = (err: unknown) => {
    partialReader.cancel(err);
  };
  signal?.addEventListener("abort", cancelPartialReader, { once: true });

  try {
    while (true) {
      signal?.throwIfAborted();
      const header = await partialReader.readAmount(30);
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
        await partialReader.readAmountStrict(fileNameLength),
      );

      let type: ReadEntry["type"] | undefined;
      if (fileName.endsWith("/")) {
        type = "directory";
      } else {
        type = "file";
      }

      const extraFieldRaw = await partialReader.readAmountStrict(
        extraFieldLength,
      );
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
          const bodyStream = partialReader.streamAmount(compressedSize);
          bodyMethodFinished = bodyStream.onConsumed;

          let stream = bodyStream.stream.pipeThrough(
            new ExactBytesTransformStream(compressedSize),
            { signal },
          );
          switch (compressionMethod) {
            case 0:
              break;
            case 8: {
              stream = decompressDeflateRaw(stream, crc, uncompressedSize);
              break;
            }
            default: {
              throw new Error(
                `Unknown compression method: ${compressionMethod}`,
              );
            }
          }
          return stream;
        },
        autodrain() {
          if (bodyMethodFinished) {
            throw new Error("body already used");
          }
          bodyMethodFinished = partialReader.skipAmount(compressedSize);
        },
      };

      signal?.throwIfAborted();

      if (type !== undefined) {
        if (type === "file") {
          yield {
            type,
            name: fileName,
            extendedTimestamps: parsedExtraFields.extendedTimestamps,
            originalSize: uncompressedSize,
            compressedSize,
            crc,
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
  } catch (err) {
    await partialReader.cancel(err);
    throw err;
  } finally {
    signal?.removeEventListener("abort", cancelPartialReader);
  }
  // Don't let this function end successfully if we might've read truncated data because
  // of an abort.
  signal?.throwIfAborted();
}
