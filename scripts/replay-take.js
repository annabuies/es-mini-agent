#!/usr/bin/env node
'use strict';

// Replays a recorded take through the agent's own post-take steps, off the Mini
// (Build 42, B3/A4). Bench tool, not a runtime module; it only reads the take.
//
//   node scripts/replay-take.js <take-dir> <base> <out-dir> [--offset <s> | --offset camN=<s>,...] [--cams cam1,cam2]
//
// <take-dir> is laid out like the S3 bucket or the Mini's record dir:
//   <take-dir>/master/<base>.mp4, <take-dir>/camN/<base>.mp4
// It writes, for each camera, <out-dir>/stream/<camN>/<base>.mp4 (the watch copy,
// exactly as upload-queue's makeProxy makes it), <out-dir>/audio/<base>-mix.m4a,
// and <out-dir>/<base>.replay.json with the plan per camera, the master's
// audio_health and each file's checksum before and after (originals untouched).
//
// A take recorded before 2026.10.20-1 has no logged timing: pass the offset
// measured from the footage (Take 1, 2026-10-19 15-30-22: --offset 1.08).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { mixArgs, planWatch, probeMedia, runTool, watchArgs } = require('../watch-rendition');
const { analyzeMasterAudio } = require('../audio-health');

function md5(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('md5');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

function parseOffsets(value, cams) {
  const out = {};
  if (!value) return out;
  if (/^-?\d+(\.\d+)?$/.test(value)) { for (const c of cams) out[c] = Number(value); return out; }
  for (const part of value.split(',')) {
    const [cam, s] = part.split('=');
    if (cam && Number.isFinite(Number(s))) out[cam.trim()] = Number(s);
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv.splice(i, 2)[1] : null; };
  const offsetArg = opt('--offset');
  const camsArg = opt('--cams');
  const [takeDir, base, outDir] = argv;
  if (!takeDir || !base || !outDir) {
    console.error('usage: replay-take.js <take-dir> <base> <out-dir> [--offset <s>|camN=<s>,...] [--cams cam1,cam2]');
    process.exit(2);
  }
  const ffmpegBin = process.env.FFMPEG_BIN || 'ffmpeg';
  const ffprobeBin = process.env.FFPROBE_BIN || 'ffprobe';
  const masterPath = path.join(takeDir, 'master', base + '.mp4');
  const cams = camsArg ? camsArg.split(',') : fs.readdirSync(takeDir).filter((d) => /^cam\d+$/.test(d) && fs.existsSync(path.join(takeDir, d, base + '.mp4'))).sort();
  const offsets = parseOffsets(offsetArg, cams);
  const report = { take_dir: takeDir, base, master: masterPath, cameras: {}, checksums: {} };
  const inputs = [masterPath].concat(cams.map((c) => path.join(takeDir, c, base + '.mp4'))).filter((f) => fs.existsSync(f));
  for (const f of inputs) report.checksums[f] = { before: await md5(f) };

  const t0 = Date.now();
  report.audio_health = await analyzeMasterAudio(masterPath, { ffmpegBin, ffprobeBin });
  console.log('audio_health', report.audio_health.level, JSON.stringify(report.audio_health.codes), (Date.now() - t0) + ' ms');

  fs.mkdirSync(path.join(outDir, 'audio'), { recursive: true });
  const mixOut = path.join(outDir, 'audio', base + '-mix.m4a');
  const masterProbe = await probeMedia(masterPath, { ffprobeBin });
  const masterTracks = masterProbe.ok ? Math.min(4, masterProbe.audioTracks) : 0;
  if (masterTracks > 0) {
    const r = await runTool(ffmpegBin, mixArgs({ masterPath, masterTracks, outPath: mixOut }));
    report.mix = { path: mixOut, ok: r.code === 0, stderr: r.code === 0 ? undefined : r.stderr };
  }

  for (const cam of cams) {
    const cameraPath = path.join(takeDir, cam, base + '.mp4');
    const outPath = path.join(outDir, 'stream', cam, base + '.mp4');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const plan = await planWatch({ cameraPath, masterPath, offsetS: Number.isFinite(offsets[cam]) ? offsets[cam] : null }, { ffprobeBin });
    const args = watchArgs({ cameraPath, masterPath, masterTracks: plan.masterTracks, delayS: plan.delayS, outPath });
    const started = Date.now();
    const r = await runTool(ffmpegBin, args);
    const encodeS = (Date.now() - started) / 1000;
    report.cameras[cam] = {
      out: outPath, ok: r.code === 0, offset_s: plan.offsetS, delay_s: plan.delayS, audio: plan.audio,
      camera_duration_s: plan.camera.durationS, encode_s: encodeS,
      realtime_x: plan.camera.durationS ? Math.round((plan.camera.durationS / encodeS) * 100) / 100 : null,
      filter: args[args.indexOf('-filter_complex') + 1],
    };
    if (r.code !== 0) report.cameras[cam].stderr = r.stderr;
    console.log(cam, r.code === 0 ? 'ok' : 'FAILED', 'offset', plan.offsetS, 'delay', plan.delayS, 'encode', encodeS.toFixed(1) + ' s');
  }

  for (const f of Object.keys(report.checksums)) {
    report.checksums[f].after = await md5(f);
    report.checksums[f].unchanged = report.checksums[f].after === report.checksums[f].before;
  }
  const reportPath = path.join(outDir, base + '.replay.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log('report', reportPath, 'originals unchanged:', Object.values(report.checksums).every((c) => c.unchanged));
}

main().catch((e) => { console.error(e && (e.stack || e)); process.exit(1); });
