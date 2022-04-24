import { DeferredPromise } from "https://deno.land/x/deferred_promise@v1.0.0/mod.ts";

export interface StreamUpToAmountResult {
  stream: ReadableStream<Uint8Array>;
  consumed: boolean;
  onConsumed: Promise<void>;
}

// TODO throw if overlapping reads happen.
export abstract class PartialReader {
  /**
   * Construct a PartialReader from a ReadableStream.
   * Internally this will return a subclass of PartialReader based on whether the `stream`
   * supports byob mode ("bring your own buffer") readers, which are more efficient for some
   * use-cases.
   */
  static fromStream(stream: ReadableStream<Uint8Array>): PartialReader {
    try {
      return new BYOBPartialReader(stream.getReader({ mode: "byob" }));
    } catch (err: unknown) {
      if (err instanceof TypeError) {
        return new DefaultPartialReader(stream.getReader());
      } else {
        throw err;
      }
    }
  }

  /**
   * Cancel the ReadableStream reader. This will cause any in-progress or future reads to fail.
   */
  abstract cancel(reason?: unknown): Promise<void>;

  /**
   * Equivalent to {@link ReadableStreamDefaultReader.read} except that a maximum size is provided,
   * and if the underlying read() result is greater than the maximum size, then the extra data
   * will be buffered for later.
   * @returns A {@link ReadableStreamReadResult} of `maxSize` bytes or less.
   */
  abstract limitedRead(
    maxSize: number,
  ): Promise<ReadableStreamReadResult<Uint8Array>>;

  /**
   * Reads and returns `size` bytes from the stream, or less if the stream ends early.
   * @returns A Uint8Array of `size` bytes or less.
   */
  async readAmount(size: number): Promise<Uint8Array> {
    const firstPart = await this.limitedRead(size);
    if (firstPart.done) {
      return new Uint8Array(0);
    }
    if (firstPart.value.length < size) {
      const result = new Uint8Array(size);
      result.set(firstPart.value, 0);
      let bytesRead = firstPart.value.length;
      while (bytesRead < size) {
        const part = await this.limitedRead(size - bytesRead);
        if (part.done) {
          return result.subarray(0, bytesRead);
        }
        result.set(part.value, bytesRead);
        bytesRead += part.value.length;
      }
      return result;
    } else {
      return firstPart.value;
    }
  }

  /**
   * Reads and returns exactly `size` bytes from the stream.
   * Throws an error if the reader ends before filling the buffer.
   * @returns A Uint8Array of exactly `size` bytes.
   */
  async readAmountStrict(size: number): Promise<Uint8Array> {
    const data = await this.readAmount(size);
    if (data.byteLength < size) {
      throw new Error("Stream completed early during exactRead() call");
    }
    return data;
  }

  /** Skips `size` bytes of the stream by reading them and ignoring the result. */
  async skipAmount(size: number): Promise<void> {
    let bytesLeft = size;
    while (bytesLeft > 0) {
      const part = await this.limitedRead(bytesLeft);
      if (part.done) {
        break;
      }
      bytesLeft -= part.value.byteLength;
    }
  }

  /**
   * Returns a ReadableStream that the underlying reader is redirected to for the
   * next `size` bytes.
   * If you want to assert that the returned stream outputs `size` bytes without ending early,
   * then use `.pipeThrough(new ExactBytesTransformStream(size))` on the result.
   */
  streamAmount(size: number): StreamUpToAmountResult {
    const deferred = new DeferredPromise<void>();
    const result: StreamUpToAmountResult = {
      stream: null as unknown as ReadableStream<Uint8Array>,
      consumed: false,
      onConsumed: deferred.promise,
    };
    let bytesLeft = size;
    result.stream = new ReadableStream({
      pull: async (controller) => {
        try {
          const part = await this.limitedRead(bytesLeft);
          if (part.done) {
            result.consumed = true;
            deferred.resolve();
            controller.close();
          } else {
            bytesLeft -= part.value.byteLength;
            controller.enqueue(part.value);
            if (bytesLeft <= 0) {
              result.consumed = true;
              deferred.resolve();
              controller.close();
            }
          }
        } catch (err) {
          deferred.reject(err);
          throw err;
        }
      },
      cancel: async (_reason) => {
        try {
          await this.skipAmount(bytesLeft);
        } catch (err) {
          deferred.reject(err);
          throw err;
        }
        result.consumed = true;
        deferred.resolve();
      },
    });
    return result;
  }
}

export class DefaultPartialReader extends PartialReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #leftOvers: Uint8Array | undefined;

  /**
   * Manually constructs a DefaultPartialReader from a default mode reader.
   * Generally {@link PartialReader.fromStream} should be used instead of this which
   * will specially handle streams that support more powerful byob mode readers.
   */
  constructor(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ) {
    super();
    this.#reader = reader;
  }

  cancel(reason?: unknown): Promise<void> {
    return this.#reader.cancel(reason);
  }

  async limitedRead(
    maxSize: number,
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    let value: Uint8Array;
    if (this.#leftOvers) {
      value = this.#leftOvers;
      this.#leftOvers = undefined;
    } else {
      const result = await this.#reader.read();
      if (result.done) {
        return result;
      }
      value = result.value;
    }
    if (value.byteLength > maxSize) {
      this.#leftOvers = value.subarray(maxSize);
      value = value.subarray(0, maxSize);
    }
    return {
      done: false,
      value,
    };
  }
}

export class BYOBPartialReader extends PartialReader {
  readonly #reader: ReadableStreamBYOBReader;

  /**
   * Manually constructs a BYOBPartialReader from a byob mode reader.
   * Generally {@link PartialReader.fromStream} should be used instead of this which
   * will automatically handle streams that don't support byob mode readers.
   */
  constructor(
    reader: ReadableStreamBYOBReader,
  ) {
    super();
    this.#reader = reader;
  }

  cancel(reason?: unknown): Promise<void> {
    return this.#reader.cancel(reason);
  }

  async readAmount(size: number): Promise<Uint8Array> {
    let bytesRead = 0;
    let view = new Uint8Array(size);
    while (bytesRead < size) {
      // TODO use `atLeast` option if/when it gets implemented.
      // https://github.com/whatwg/streams/pull/1145
      const result = await this.#reader.read(view);
      if (result.done) {
        return new Uint8Array(view.buffer, 0, bytesRead);
      }
      bytesRead += result.value.byteLength;
      view = new Uint8Array(result.value.buffer, bytesRead);
    }
    return new Uint8Array(view.buffer);
  }

  limitedRead(maxSize: number): Promise<ReadableStreamReadResult<Uint8Array>> {
    return this.#reader.read(new Uint8Array(maxSize));
  }

  async skipAmount(size: number): Promise<void> {
    let bytesLeft = size;
    let trashBuffer = new Uint8Array(Math.min(bytesLeft, 2048));
    while (bytesLeft > 0) {
      const part = await this.#reader.read(trashBuffer);
      if (part.done) {
        break;
      }
      bytesLeft -= part.value.byteLength;
      trashBuffer = new Uint8Array(part.value.buffer);
      if (bytesLeft < trashBuffer.byteLength) {
        trashBuffer = trashBuffer.subarray(0, bytesLeft);
      }
    }
  }

  streamAmount(size: number): StreamUpToAmountResult {
    const deferred = new DeferredPromise<void>();
    const result: StreamUpToAmountResult = {
      stream: null as unknown as ReadableStream<Uint8Array>,
      consumed: false,
      onConsumed: deferred.promise,
    };

    let bytesLeft = size;
    result.stream = new ReadableStream({
      type: "bytes",
      autoAllocateChunkSize: 2048,
      pull: async (controller) => {
        try {
          if (bytesLeft <= 0) {
            result.consumed = true;
            deferred.resolve();
            controller.close();
            controller.byobRequest!.respond(0);
            return;
          }
          const view = controller.byobRequest!.view!;
          const dest = new Uint8Array(
            view.buffer,
            view.byteOffset,
            Math.min(
              view.byteLength,
              bytesLeft,
            ),
          );
          const part = await this.#reader.read(dest);
          if (part.done) {
            result.consumed = true;
            deferred.resolve();
            controller.close();
            controller.byobRequest!.respond(0);
          } else {
            bytesLeft -= part.value.byteLength;
            controller.byobRequest!.respondWithNewView(part.value);
          }
        } catch (err) {
          deferred.reject(err);
          throw err;
        }
      },
      cancel: async (_reason) => {
        try {
          await this.skipAmount(bytesLeft);
        } catch (err) {
          deferred.reject(err);
          throw err;
        }
        result.consumed = true;
        deferred.resolve();
      },
    });
    return result;
  }
}
