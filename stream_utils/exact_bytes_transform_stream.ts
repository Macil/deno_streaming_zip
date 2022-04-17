/** A TransformStream that will only read & enqueue `size` amount of bytes,
 * and will error if piped more or less than `size` bytes.
 *
 * ```ts
 * import { ExactBytesTransformStream } from "./exact_bytes_transform_stream.ts";
 * const fileUrl = new URL("./test.txt", import.meta.url);
 * const stat = await Deno.stat(fileUrl);
 * const res = await fetch(fileUrl.href);
 * const parts = res.body!
 *   .pipeThrough(new ExactBytesTransformStream(stat.size));
 * ```
 */
export class ExactBytesTransformStream
  extends TransformStream<Uint8Array, Uint8Array> {
  #read = 0;
  constructor(size: number) {
    super({
      transform: (chunk, controller) => {
        if ((this.#read + chunk.byteLength) > size) {
          throw new RangeError(`Exceeded byte size limit of '${size}'`);
        } else {
          this.#read += chunk.byteLength;
          controller.enqueue(chunk);
        }
      },
      flush: () => {
        if (this.#read < size) {
          throw new RangeError(`Did not receive expected size of '${size}'`);
        }
      },
    });
  }
}
