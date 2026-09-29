#!/usr/bin/env node
'use strict';

// Stands in for ffmpeg in the RTSP capture tests.
// - rtsp:// input: writes an MP4-header-sized first chunk, then 32 KiB every 50 ms
//   until 'q' arrives on stdin. FAKE_RTSP_FAIL=1: refuses the connection.
//   FAKE_RTSP_NO_FRAMES=1: header only. FAKE_RTSP_SILENT=1: connects, writes nothing. FAKE_RTSP_DROP_ONCE=<marker file>: the
//   first process to run drops the connection after 150 ms.
// - concat: joins the listed files byte for byte.
// - anything else (proxies, audio split): writes a small output file.
const fs = require('node:fs');

const args = process.argv.slice(2);
if (process.env.FAKE_FFMPEG_LOG) fs.appendFileSync(process.env.FAKE_FFMPEG_LOG, JSON.stringify(args) + '\n');
const out = args[args.length - 1];
const input = args[args.indexOf('-i') + 1] || '';

if (args.includes('concat')) {
  const list = fs.readFileSync(input, 'utf8').split('\n').filter(Boolean)
    .map((line) => line.replace(/^file '/, '').replace(/'$/, '').replace(/'\\''/g, "'"));
  fs.writeFileSync(out, Buffer.concat(list.map((p) => fs.readFileSync(p))));
  process.exit(0);
}

if (!/^rtsps?:\/\//.test(input)) {
  if (args.includes('-show_streams')) {
    process.stdout.write(JSON.stringify({ streams: [] }));
    process.exit(0);
  }
  fs.writeFileSync(out, 'fake-output');
  process.exit(0);
}

if (process.env.FAKE_RTSP_FAIL === '1') {
  process.stderr.write('[in#0 @ 0x1] Error opening input: Connection refused\n');
  process.exit(1);
}

if (process.env.FAKE_RTSP_SILENT === '1') {
  setInterval(() => {}, 1000); // hangs like ffmpeg stuck in connect: ignores 'q'
  return;
}

setTimeout(() => {
  fs.writeFileSync(out, Buffer.alloc(1024, 7));
  if (process.env.FAKE_RTSP_NO_FRAMES === '1') return;
  setInterval(() => fs.appendFileSync(out, Buffer.alloc(32 * 1024, 7)), 50);
}, 20);

const marker = process.env.FAKE_RTSP_DROP_ONCE;
if (marker && !fs.existsSync(marker)) {
  fs.writeFileSync(marker, 'dropped');
  setTimeout(() => {
    process.stderr.write('[rtsp @ 0x1] Connection timed out\n');
    process.exit(1);
  }, 150);
}

process.stdin.on('data', (chunk) => {
  if (String(chunk).includes('q')) setTimeout(() => process.exit(0), 10);
});
setInterval(() => {}, 1000);
