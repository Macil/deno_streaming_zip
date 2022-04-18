import { assertEquals } from "https://deno.land/std@0.135.0/testing/asserts.ts";
import {
  BYOBPartialReader,
  DefaultPartialReader,
  PartialReader,
} from "./partial_reader.ts";

interface BasicTests {
  [name: string]: (s: ReadableStream) => PartialReader;
}

const tests: BasicTests = {
  DefaultPartialReader: (s) => new DefaultPartialReader(s.getReader()),
  BYOBPartialReader: (s) =>
    new BYOBPartialReader(s.getReader({ mode: "byob" })),
  "PartialReader.fromStream": (s) => PartialReader.fromStream(s),
};

for (const [name, factory] of Object.entries(tests)) {
  Deno.test(name, { permissions: {} }, async () => {
    const originalStream = testByteStream();
    const ps = factory(originalStream);
    assertEquals(await ps.readAmountStrict(2), new Uint8Array([1, 2]));
    assertEquals(await ps.readAmount(5), new Uint8Array([3, 4, 5, 6, 7]));
    assertEquals(await ps.readAmountStrict(2), new Uint8Array([8, 9]));
    assertEquals(await ps.readAmountStrict(1), new Uint8Array([10]));

    {
      const streamResult = ps.streamAmount(7);
      const pssIt = streamResult.stream[Symbol.asyncIterator]();
      assertEquals(await pssIt.next(), {
        done: false,
        value: new Uint8Array([11, 12]),
      });
      assertEquals(await pssIt.next(), {
        done: false,
        value: new Uint8Array([13, 14, 15]),
      });
      assertEquals(streamResult.consumed, false);
      assertEquals(await pssIt.next(), {
        done: false,
        value: new Uint8Array([16, 17]),
      });
      assertEquals(await pssIt.next(), {
        done: true,
        value: undefined,
      });
      assertEquals(streamResult.consumed, true);
    }

    {
      const streamResult = ps.streamAmount(7);
      const pssIt = streamResult.stream[Symbol.asyncIterator]();
      assertEquals(streamResult.consumed, false);
      assertEquals(await pssIt.next(), {
        done: false,
        value: new Uint8Array([18]),
      });
      assertEquals(await pssIt.next(), {
        done: true,
        value: undefined,
      });
      assertEquals(streamResult.consumed, true);
    }
  });

  Deno.test(
    `${name} - streamAmount cancel`,
    { permissions: {} },
    async () => {
      const originalStream = testByteStream();
      const ps = factory(originalStream);

      const streamResult = ps.streamAmount(7);

      let streamConsumed = false;
      streamResult.onConsumed.then(() => {
        streamConsumed = true;
      });

      assertEquals(streamResult.consumed, false);
      assertEquals(streamConsumed, false);
      await streamResult.stream.cancel();
      assertEquals(streamResult.consumed, true);
      assertEquals(streamConsumed, true);

      assertEquals(await ps.limitedRead(5), {
        done: false,
        value: new Uint8Array([8, 9]),
      });
    },
  );

  Deno.test(
    `${name} - streamAmount reader cancel`,
    { permissions: {} },
    async () => {
      const originalStream = testByteStream();
      const ps = factory(originalStream);

      const streamResult = ps.streamAmount(7);

      let streamConsumed = false;
      streamResult.onConsumed.then(() => {
        streamConsumed = true;
      });

      const streamResultReader = streamResult.stream.getReader();
      assertEquals(await streamResultReader.read(), {
        done: false,
        value: new Uint8Array([1, 2, 3]),
      });

      assertEquals(streamResult.consumed, false);
      assertEquals(streamConsumed, false);
      await streamResultReader.cancel();
      assertEquals(streamResult.consumed, true);
      assertEquals(streamConsumed, true);

      assertEquals(await ps.limitedRead(5), {
        done: false,
        value: new Uint8Array([8, 9]),
      });
    },
  );

  Deno.test(`${name} - readAmount`, { permissions: {} }, async () => {
    const originalStream = testByteStream();
    const ps = factory(originalStream);
    const read = await ps.readAmount(30);
    assertEquals(read.length, 18);
    const read2 = await ps.readAmount(30);
    assertEquals(read2.length, 0);
  });
}

/** Creates a ReadableStream that offers 3 byte chunks from [1,2,3],[4,5,6],...[16,17,18]. */
function testByteStream(): ReadableStream<Uint8Array> {
  let index = 0;
  const max = 18;
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
