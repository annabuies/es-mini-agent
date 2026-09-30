#!/usr/bin/env node
'use strict';

// A proxy encode that takes FAKE_FFMPEG_DELAY_MS, logging its start and end.
const fs = require('node:fs');

const args = process.argv.slice(2);
const log = (what) => { if (process.env.FAKE_FFMPEG_LOG) fs.appendFileSync(process.env.FAKE_FFMPEG_LOG, what + ' ' + args[args.indexOf('-i') + 1] + '\n'); };
log('start');
setTimeout(() => {
  fs.writeFileSync(args[args.length - 1], 'fake-proxy');
  log('end');
}, Number(process.env.FAKE_FFMPEG_DELAY_MS || 300));
