#!/usr/bin/env node
'use strict';

// A watch-copy encode that fails its first FAKE_FFMPEG_FAILS runs (counted in
// FAKE_FFMPEG_COUNT), then writes its output like fake-ffmpeg-slow.js.
const fs = require('node:fs');

const args = process.argv.slice(2);
const countPath = process.env.FAKE_FFMPEG_COUNT;
const runs = (countPath && fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, 'utf8')) : 0) + 1;
if (countPath) fs.writeFileSync(countPath, String(runs));
if (runs <= Number(process.env.FAKE_FFMPEG_FAILS || 0)) {
  process.stderr.write('fake encode failure ' + runs + '\n');
  process.exit(1);
}
fs.writeFileSync(args[args.length - 1], 'fake-watch-copy');
