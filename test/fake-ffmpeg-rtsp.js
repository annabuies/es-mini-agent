#!/usr/bin/env node
'use strict';

// Stands in for ffmpeg in the RTSP capture tests.
// - rtsp:// input: writes an MP4-header-sized first chunk, then 32 KiB every 50 ms
//   until 'q' arrives on stdin. FAKE_RTSP_FAIL=1: refuses the connection.
//   FAKE_RTSP_NO_FRAMES=1: header only. FAKE_RTSP_SILENT=1: connects, writes nothing. FAKE_RTSP_DROP_ONCE=<marker file>: the
//   first process to run drops the connection after 150 ms (FAKE_RTSP_DROP_AFTER_MS to change).
//   FAKE_RTSP_VIDEO_DELAY_MS=<ms>: video starts this long after the header (connect + first keyframe).
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
  // FAKE_CONCAT_SHORT=1: stops after the first part and still exits 0, like ffmpeg on a cut-off fragment.
  const joined = process.env.FAKE_CONCAT_SHORT === '1' ? list.slice(0, 1) : list;
  fs.writeFileSync(out, Buffer.concat(joined.map((p) => fs.readFileSync(p))));
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

// -progress pipe:1 like real ffmpeg: out_time_us is N/A until video is muxed.
// FAKE_RTSP_PROGRESS_ONLY=1: video is muxed but nothing reaches the file after
// the header (a fragment not flushed yet, or the empty-audio stall).
const progress = args.includes('-progress');
let outTimeUs = null;
setTimeout(() => {
  fs.writeFileSync(out, Buffer.alloc(1024, 7));
  if (process.env.FAKE_RTSP_NO_FRAMES === '1') {
    if (progress) setInterval(() => process.stdout.write('out_time_us=N/A\nprogress=continue\n'), 50);
    return;
  }
  setTimeout(() => {
    outTimeUs = 0;
    setInterval(() => {
      outTimeUs += 50000;
      if (process.env.FAKE_RTSP_PROGRESS_ONLY !== '1') fs.appendFileSync(out, Buffer.alloc(32 * 1024, 7));
      if (progress) process.stdout.write('frame=0\nout_time_us=' + outTimeUs + '\nprogress=continue\n');
    }, 50);
  }, Number(process.env.FAKE_RTSP_VIDEO_DELAY_MS) || 0);
}, 20);

const marker = process.env.FAKE_RTSP_DROP_ONCE;
if (marker && !fs.existsSync(marker)) {
  fs.writeFileSync(marker, 'dropped');
  setTimeout(() => {
    process.stderr.write('[rtsp @ 0x1] Connection timed out\n');
    process.exit(1);
  }, Number(process.env.FAKE_RTSP_DROP_AFTER_MS) || 150);
}

process.stdin.on('data', (chunk) => {
  if (String(chunk).includes('q')) setTimeout(() => process.exit(0), 10);
});
setInterval(() => {}, 1000);
