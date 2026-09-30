#!/usr/bin/env node
'use strict';

// Stands in for ffprobe in the agent tests. "<file>.probe.json" next to a file is
// printed as-is; otherwise any file of 16 KiB or more is one video stream whose
// duration is its size at the fake RTSP camera's rate (640 KiB/s).
const fs = require('node:fs');

const args = process.argv.slice(2);
const file = args[args.length - 1];
if (args.includes('-select_streams')) {
  process.stdout.write(JSON.stringify({ streams: [] }));
  process.exit(0);
}
if (fs.existsSync(file + '.probe.json')) {
  process.stdout.write(fs.readFileSync(file + '.probe.json', 'utf8'));
  process.exit(0);
}
let size = 0;
try { size = fs.statSync(file).size; } catch (_) {
  process.stderr.write(file + ': No such file or directory\n');
  process.exit(1);
}
if (size < 16 * 1024) {
  process.stderr.write(file + ': Invalid data found when processing input\n');
  process.exit(1);
}
const duration = (size / (640 * 1024)).toFixed(6);
process.stdout.write(JSON.stringify({ streams: [{ codec_type: 'video', duration }], format: { duration } }));
