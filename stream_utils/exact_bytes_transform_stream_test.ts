import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.132.0/testing/asserts.ts";
import { Buffer } from "https://deno.land/std@0.132.0/streams/buffer.ts";
import { ExactBytesTransformStream } from "./exact_bytes_transform_stream.ts";

Deno.test("works", {
  permissions: {},
}, async () => {
  const buf = new Buffer();
  await testByteStream().pipeThrough(new ExactBytesTransformStream(9)).pipeTo(
    buf.writable,
  );
  assertEquals(
    buf.bytes(),
    new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
  );
});

Deno.test("fails when given too little", {
  permissions: {},
}, async () => {
  const buf = new Buffer();
  await assertRejects(async () => {
    await testByteStream().pipeThrough(new ExactBytesTransformStream(10))
      .pipeTo(buf.writable);
  });
});

Deno.test("fails when given too much", {
  permissions: {},
}, async () => {
  const buf = new Buffer();
  await assertRejects(async () => {
    await testByteStream().pipeThrough(new ExactBytesTransformStream(8))
      .pipeTo(buf.writable);
  });
});

/** Creates a ReadableStream that offers 3 byte chunks from [1,2,3],[4,5,6],[7,8,9]. */
function testByteStream(): ReadableStream<Uint8Array> {
  let index = 0;
  const max = 9;
  const chunkSize = 3;
  return new ReadableStream({
    type: "bytes",
    autoAllocateChunkSize: chunkSize,
    pull(controller) {
      const bytesLeft = max - index;
      if (bytesLeft <= 0) {
        controller.close();
        controller.byobRequest!.respond(0);
        return;
      }
      const amountLeftInChunk = chunkSize - (index % chunkSize);
      const view = controller.byobRequest!.view!;
      const dest = new Uint8Array(
        view.buffer,
        view.byteOffset,
        Math.min(
          view.byteLength,
          bytesLeft,
          amountLeftInChunk,
        ),
      );
      for (let i = 0; i < dest.length; i++) {
        dest[i] = index + i + 1;
      }
      index += dest.length;
      controller.byobRequest!.respondWithNewView(dest);
    },
  });
}
