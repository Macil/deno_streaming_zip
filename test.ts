import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.132.0/testing/asserts.ts";
import { readableStreamFromIterable } from "https://deno.land/std@0.132.0/streams/conversion.ts";
import { Buffer } from "https://deno.land/std@0.132.0/streams/buffer.ts";
import { read, ReadEntry } from "./mod.ts";

// Deno.test("write -> read", { permissions: {} }, async () => {
//   async function* entryGenerator(): AsyncGenerator<Entry> {
//     for (let i = 0; i < 5; i++) {
//       yield {
//         name: `item-${i}`,
//         body: readableStreamFromIterable([
//           new Uint8Array([i, 1337, i]),
//           new Uint8Array([1, i]),
//           new Uint8Array([i, 2]),
//         ]),
//       };
//     }
//   }

//   const stream = write(entryGenerator());
//   const iterable = read(stream);
//   const items = [];
//   for await (const entry of iterable) {
//     items.push(entry);
//     entry.body.cancel();
//   }
//   assertEquals(items.length, 5);
// });

const testZipUrl = new URL("./test.zip", import.meta.url);

Deno.test("can read test.zip", {
  permissions: { read: [testZipUrl] },
}, async () => {
  const textDecoder = new TextDecoder();

  const req = await fetch(testZipUrl.href);
  assert(req.ok);

  const readEntries: { entry: ReadEntry; contents?: string }[] = [];
  for await (const entry of read(req.body!)) {
    if (entry.type === "file") {
      if (entry.name.endsWith(".txt")) {
        const buffer = new Buffer();
        await entry.body.stream().pipeTo(buffer.writable);
        const contents = textDecoder.decode(buffer.bytes());
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
        },
      },
    ],
  );
});
