# streaming_zip

This is a Deno library for doing streaming encoding and decoding of zip files.
Streaming encoding and decoding is useful when you don't have random access to
read or write a zip file. This can be the case if you want to decode a zip file
while it's still being downloaded, or if you want to send a zip file as soon as
possible while it's still being made with minimal buffering and latency.

The cases where this library is useful are expected to be limited. This library
is mostly released for educational purposes.

This library is not right to use for reading zip files from disk (where random
access is available) unless you intend to read all files from it in order, and
it's not right to use for writing zip files to disk unless the files are
uncompressed or pre-compressed. Zip files are not generally conducive to being
creating as a stream because the size of each (optionally compressed) item must
be known before the item may be written into the zip file. (The zip file format
does have an option for allowing zip files to be encoded as a stream, but zip
files using that option are not decodeable as a stream, so this library does not
support that.)
