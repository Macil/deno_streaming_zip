const GZIP_HEADER = Uint8Array.from([
  31,
  139, // gzip magic
  8, // deflate
  0, // no extra fields
  0,
  0,
  0,
  0, // mtime (n/a)
  0,
  0, // extra flags, OS
]);

/** This function is a workaround for DecompressionStream's lack of support for the "deflate-raw" format.
 * (https://github.com/WICG/compression/issues/25) */
export function decompressDeflateRaw(
  stream: ReadableStream<Uint8Array>,
  crc: number,
  uncompressedSize: number,
): ReadableStream<Uint8Array> {
  return stream.pipeThrough(
    new TransformStream({
      start(controller) {
        controller.enqueue(GZIP_HEADER);
      },
      flush(controller) {
        const tmp = new DataView(new ArrayBuffer(8));
        tmp.setUint32(0, crc, true);
        tmp.setUint32(4, uncompressedSize, true);
        controller.enqueue(new Uint8Array(tmp.buffer));
      },
    }),
  ).pipeThrough(new DecompressionStream("gzip"));
}
