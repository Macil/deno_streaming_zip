/*
TODO consider npm release
https://deno.com/blog/dnt-oak
*/

// TODO should we offer a way to provide raw compressed data?
/*
export function write(
  entries: Iterable<Entry> | AsyncIterable<Entry>,
  options: { signal?: AbortSignal; includeCentralDirectory?: boolean } = {},
): ReadableStream<Uint8Array> {
  const { signal } = options;
  const includeCentralDirectory = options.includeCentralDirectory ?? true;

  const ts = new TransformStream<Uint8Array>();
  const writer = ts.writable.getWriter();

  async function run() {
    for await (const entry of entries) {
      // Note this doesn't cancel things until the next time
      // entries yields a value. TODO use something like
      // https://github.com/alanshaw/abortable-iterator here to fix that.
      signal?.throwIfAborted();
      await writeLocalFileEntry(entry).pipeTo(ts.writable, { signal });
    }
  }
  run().then(
    () => writer.close(),
    (reason) => ts.writable.abort(reason),
  ).catch(() => {});
  return ts.readable;
}

export function writeLocalFileEntry(
  entry: Entry,
  options: { signal?: AbortSignal } = {},
): ReadableStream<Uint8Array> {
  const { signal } = options;
  return entry.body.pipeThrough(new CompressionStream("deflate"), { signal });
}
*/
