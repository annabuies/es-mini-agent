#!/usr/bin/env node
'use strict';

// fake-ffprobe.js, except that the hardware-fit probe (-select_streams v:0) sees
// one unrotated H.264 video stream, so the Watch copy tries the hardware path.
const args = process.argv.slice(2);
if (args.includes('-select_streams')) {
  process.stdout.write(JSON.stringify({ streams: [{ codec_name: 'h264', tags: {} }] }));
  process.exit(0);
}
require('./fake-ffprobe.js');
