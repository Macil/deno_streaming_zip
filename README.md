# streaming_zip

This is a Deno library for doing streaming encoding and decoding of zip files.
Streaming encoding and decoding is useful when you don't have random access to
read or write a zip file. This can be the case if you want to decode a zip file
while it's still being downloaded, or if you want to send a zip file as soon as
possible while it's still being made with minimal buffering and latency.

This library supports reading and writing zip files with the zip64 and extended
timestamps extensions.

## Limitations

This library does not currently support reading or writing zip files with
encryption.

This library's ability to create zip files is limited. This library is not right
for writing zip files to disk unless the files are uncompressed or
pre-compressed, you know all of their compressed and uncompressed sizes, and you
know their CRC checksums ahead of time. It's expected that the main case this
would be realistic is where you're transforming a pre-existing zip file.

Zip files are not generally conducive to being creating as a stream because the
size of each (optionally compressed) item and its CRC checksum must be known
before the item may be written into the zip file. (The zip file format does have
an option to put sizes after file data to better allow zip files to be encoded
as a stream, but zip files using that option are not decodeable as a stream, so
this library does not support that.)

## Usage

### read()

```ts
import { read } from "https://deno.land/x/streaming_zip/read.ts";
import { Buffer } from "https://deno.land/std@0.195.0/streams/buffer.ts";
import { partialReaderFromDenoFsFile } from "https://deno.land/x/stream_slicing@v1.1.0/deno_helpers.ts";

const textDecoder = new TextDecoder();

// Reading a zip from a fetch response body:
// const req = await fetch("https://example.com/somefile.zip");
// const stream = req.body!;

// Reading a zip from a local file:
const stream = partialReaderFromDenoFsFile(
  await Deno.open("somefile.zip"),
);

for await (const entry of read(stream)) {
  // Each entry object is of ReadEntry type:
  /*
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
  */

  if (entry.type === "file") {
    if (entry.name.endsWith(".txt")) {
      const buffer = new Buffer();
      await entry.body.stream().pipeTo(buffer.writable);
      const contents = textDecoder.decode(buffer.bytes({ copy: false }));
      console.log(`contents of ${entry.name}: ${contents}`);
    } else {
      console.log(`ignoring non-txt file ${entry.name}`);
      // Every file entry must either have entry.body.stream() or entry.body.autodrain() called.
      entry.body.autodrain();
    }
  } else {
    console.log(`directory found: ${entry.name}`);
  }
}
```

### write()

```ts
import { write } from "https://deno.land/x/streaming_zip/write.ts";
import { crc32 } from "https://deno.land/x/crc32@v0.2.2/mod.ts";
import { Buffer } from "https://deno.land/std@0.195.0/streams/buffer.ts";

async function* entryGenerator(): AsyncGenerator<WriteEntry> {
  yield {
    type: "directory",
    name: "some-subdir/",
    extendedTimestamps: {
      modifyTime: new Date("2022-03-28T05:37:04.000Z"),
    },
  };
  const fileBuf = new TextEncoder().encode("Text file contents here.\n");
  yield {
    type: "file",
    name: "fortune.txt",
    extendedTimestamps: {
      modifyTime: new Date("2022-03-29T05:37:04.000Z"),
    },
    body: {
      stream: ReadableStream.from([fileBuf]),
      originalSize: fileBuf.byteLength,
      originalCrc: parseInt(crc32(fileBuf), 16),
    },
  };
}

const stream = write(entryGenerator());
const buffer = new Buffer();
await stream.pipeTo(buffer.writable);
console.log(buffer.bytes({ copy: false }));
```

## Documentation

This library is made available on deno.land at
https://deno.land/x/streaming_zip, and has documentation pages generated at
https://doc.deno.land/https://deno.land/x/streaming_zip/mod.ts.
