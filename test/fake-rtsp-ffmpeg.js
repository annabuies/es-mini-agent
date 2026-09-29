#!/usr/bin/env node
'use strict';

// Stands in for `ffmpeg -i rtsp://... -c copy out.mp4`. No network: behaviour is
// chosen by the last path segment of the input URL.
//   .../ok        header at once, then grows; 'q' on stdin => trailer + exit 0
//   .../refuse    echoes the URL (with its login) to stderr and exits 1, like a refused DESCRIBE
//   .../silent    never writes (camera reachable but no stream)
//   .../drop      writes briefly, then exits 0 by itself (camera went away mid-take)
//   .../ignore-q  ignores 'q' and SIGINT; only SIGKILL stops it

const fs = require('node:fs');

const args = process.argv.slice(2);
if (process.env.FAKE_FFMPEG_LOG) fs.appendFileSync(process.env.FAKE_FFMPEG_LOG, JSON.stringify(args) + '\n');
const url = args[args.indexOf('-i') + 1] || '';
const out = args[args.length - 1];
const mode = url.split('/').pop();

if (mode === 'refuse') {
  process.stderr.write(`[rtsp @ 0x1] method DESCRIBE failed: 401 Unauthorized\n${url}: Server returned 401 Unauthorized\n`);
  process.exit(1);
}
if (mode === 'silent') {
  setInterval(() => {}, 1000);
} else {
  fs.writeFileSync(out, 'ftyp-moov-header');
  const grow = setInterval(() => fs.appendFileSync(out, Buffer.alloc(1024, 1)), 40);
  const finish = (code) => {
    clearInterval(grow);
    fs.appendFileSync(out, 'mfra-trailer');
    process.exit(code);
  };
  if (mode === 'drop') setTimeout(() => finish(0), 250);
  if (mode === 'ignore-q') {
    process.on('SIGINT', () => {});
    process.stdin.resume();
  } else {
    process.on('SIGINT', () => finish(255));
    process.stdin.on('data', (chunk) => { if (String(chunk).includes('q')) finish(0); });
    process.stdin.on('end', () => {});
  }
}
