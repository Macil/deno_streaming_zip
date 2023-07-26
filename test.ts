import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.195.0/assert/mod.ts";
import { Buffer } from "https://deno.land/std@0.195.0/streams/buffer.ts";
import { Crc32Stream } from "https://deno.land/x/crc32@v0.2.2/mod.ts";
import { partialReaderFromDenoFsFile } from "https://deno.land/x/stream_slicing@v1.1.0/deno_helpers.ts";
import type { PartialReader } from "https://deno.land/x/stream_slicing@v1.1.0/partial_reader.ts";
import { read, ReadEntry, write, WriteEntry } from "./mod.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

async function crcStream(stream: ReadableStream<Uint8Array>): Promise<number> {
  const c = new Crc32Stream();
  for await (const part of stream) {
    c.append(part);
  }
  return parseInt(c.crc32, 16);
}

Deno.test("write -> read", { permissions: {} }, async () => {
  async function* entryGenerator(): AsyncGenerator<WriteEntry> {
    yield {
      type: "directory",
      name: "some-subdir/",
      extendedTimestamps: {
        createTime: new Date("2022-03-28T05:37:04.000Z"),
        accessTime: new Date("2022-03-29T05:37:04.000Z"),
      },
    };
    for (let i = 0; i < 5; i++) {
      const text = `Contents of item-${i} here!`;
      const buf = textEncoder.encode(text);
      const stream = () => {
        return ReadableStream.from([
          buf.slice(0, 4),
          buf.slice(4, 11),
          buf.slice(11),
        ]);
      };
      yield {
        type: "file",
        name: `item-${i}`,
        body: {
          originalSize: buf.byteLength,
          originalCrc: await crcStream(stream()),
          stream: stream(),
        },
        extendedTimestamps: i == 0
          ? {
            modifyTime: new Date("2022-03-28T06:37:04.000Z"),
          }
          : undefined,
      };
    }
  }

  const stream = write(entryGenerator());
  const iterable = read(stream);
  const readEntries: { entry: ReadEntry; contents?: string }[] = [];
  for await (const entry of iterable) {
    if (entry.type === "file") {
      const buffer = new Buffer();
      await entry.body.stream().pipeTo(buffer.writable);
      const contents = textDecoder.decode(buffer.bytes({ copy: false }));
      readEntries.push({ entry, contents });
    } else {
      readEntries.push({ entry });
    }
  }

  assertEquals(
    readEntries.map((r) => ({
      ...r,
      entry: { ...r.entry, body: undefined },
    })),
    [
      {
        entry: {
          body: undefined,
          extendedTimestamps: {
            createTime: new Date("2022-03-28T05:37:04.000Z"),
            accessTime: new Date("2022-03-29T05:37:04.000Z"),
          },
          name: "some-subdir/",
          type: "directory",
        },
      },
      {
        contents: "Contents of item-0 here!",
        entry: {
          body: undefined,
          compressedSize: 24,
          crc: 3715165676,
          extendedTimestamps: {
            modifyTime: new Date("2022-03-28T06:37:04.000Z"),
          },
          name: "item-0",
          originalSize: 24,
          type: "file",
        },
      },
      {
        contents: "Contents of item-1 here!",
        entry: {
          body: undefined,
          compressedSize: 24,
          crc: 2064115288,
          extendedTimestamps: undefined,
          name: "item-1",
          originalSize: 24,
          type: "file",
        },
      },
      {
        contents: "Contents of item-2 here!",
        entry: {
          body: undefined,
          compressedSize: 24,
          crc: 1257241797,
          extendedTimestamps: undefined,
          name: "item-2",
          originalSize: 24,
          type: "file",
        },
      },
      {
        contents: "Contents of item-3 here!",
        entry: {
          body: undefined,
          compressedSize: 24,
          crc: 3969447793,
          extendedTimestamps: undefined,
          name: "item-3",
          originalSize: 24,
          type: "file",
        },
      },
      {
        contents: "Contents of item-4 here!",
        entry: {
          body: undefined,
          compressedSize: 24,
          crc: 692046335,
          extendedTimestamps: undefined,
          name: "item-4",
          originalSize: 24,
          type: "file",
        },
      },
    ],
  );
});

const testZipUrl = new URL("./test.zip", import.meta.url);

Deno.test("can read test.zip using fetch", {
  permissions: { read: [testZipUrl] },
}, async () => {
  const req = await fetch(testZipUrl);
  assert(req.ok);
  await readTestZip(req.body!);
});

Deno.test("can read test.zip using Deno.FsFile", {
  permissions: { read: [testZipUrl] },
}, async () => {
  const partialReader = partialReaderFromDenoFsFile(
    await Deno.open(testZipUrl),
  );
  await readTestZip(partialReader);
});

async function readTestZip(stream: ReadableStream<Uint8Array> | PartialReader) {
  const readEntries: { entry: ReadEntry; contents?: string }[] = [];

  for await (const entry of read(stream)) {
    if (entry.type === "file") {
      if (entry.name.endsWith(".txt")) {
        const buffer = new Buffer();
        await entry.body.stream().pipeTo(buffer.writable);
        const contents = textDecoder.decode(buffer.bytes({ copy: false }));
        readEntries.push({ entry, contents });
      } else {
        entry.body.autodrain();
        readEntries.push({ entry });
      }
    } else {
      assertEquals("body" in entry, false);
      readEntries.push({ entry });
    }
  }

  assertEquals(
    readEntries.map((r) => ({
      ...r,
      entry: { ...r.entry, body: undefined },
    })),
    [
      {
        contents:
          "fantasy: im a gaseous, odorless lifeform that floats through your body spaces\nfantasy: just because i inhabit your skull doesn't mean im actually living in your head\nfantasy: i'm part of your mind, like a dog is part of a home\n\n- https://twitter.com/dril_gpt2/status/1327347532645756929\n",
        entry: {
          body: undefined,
          extendedTimestamps: {
            accessTime: new Date("2022-03-25T05:37:04.000Z"),
            modifyTime: new Date("2022-03-25T05:37:04.000Z"),
          },
          name: "dril_gpt2_1327347532645756929.txt",
          type: "file",
          originalSize: 287,
          compressedSize: 198,
          crc: 180766896,
        },
      },
      {
        contents:
          "if every person on earth killed 1000 bugs every day we would have no more bugs #noBugs #stopBugs\n\n- https://twitter.com/dril/status/1299440247927836672\n",
        entry: {
          body: undefined,
          extendedTimestamps: {
            accessTime: new Date("2022-03-25T05:38:12.000Z"),
            modifyTime: new Date("2022-03-25T05:38:12.000Z"),
          },
          name: "dril_1299440247927836672.txt",
          type: "file",
          originalSize: 152,
          compressedSize: 123,
          crc: 1275466175,
        },
      },
      {
        entry: {
          body: undefined,
          extendedTimestamps: {
            accessTime: new Date("2022-03-25T05:39:06.000Z"),
            modifyTime: new Date("2022-03-25T05:39:06.000Z"),
          },
          name: "subdir/",
          type: "directory",
        },
      },
      {
        entry: {
          body: undefined,
          extendedTimestamps: {
            accessTime: new Date("2022-03-25T05:39:06.000Z"),
            modifyTime: new Date("2022-03-25T05:39:06.000Z"),
          },
          name: "subdir/draft2.png",
          type: "file",
          originalSize: 390043,
          compressedSize: 361303,
          crc: 2864909653,
        },
      },
    ],
  );
}
