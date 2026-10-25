#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const args = process.argv.slice(2);
if (process.env.FAKE_FFMPEG_LOG) fs.appendFileSync(process.env.FAKE_FFMPEG_LOG, JSON.stringify(args) + '\n');
// As ffprobe (-show_streams / -show_entries): FAKE_AUDIO_STREAMS audio streams.
if (args.includes('-show_streams') || args.includes('-show_entries')) {
  const count = Number(process.env.FAKE_AUDIO_STREAMS || 4);
  process.stdout.write(JSON.stringify({ streams: Array.from({ length: count }, () => ({ codec_type: 'audio', start_time: '0.000000' })), format: { start_time: '0.000000', duration: '12.000000' } }));
  process.exit(0);
}
fs.writeFileSync(args[args.length - 1], 'fake-audio');
