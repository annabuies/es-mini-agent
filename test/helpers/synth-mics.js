'use strict';

// Synthetic four-mic master for the audio tests (real ffmpeg): per channel a
// broadband white-noise floor (the SM7B + EVO preamp hiss) plus a speech-like burst
// (pink noise, 150 Hz-3.5 kHz, 4 Hz syllable modulation) at a different time on each
// channel, so room tone and per-mic speech can be measured separately.
// Layout (s): room tone 0-1.5, bursts mic1 2-4, mic2 5-7, mic3 8-10, mic4 11-13,
// room tone 14-16. Each track is AAC, like the master OBS writes.

const { execFileSync, spawnSync } = require('node:child_process');

const HAVE_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

const BURSTS = [[2, 4], [5, 7], [8, 10], [11, 13]];
const ROOM_TONE = [0.3, 1.4];
const DURATION_S = 16;

function dbToLin(db) {
  return Math.pow(10, db / 20);
}

/**
 * options: floorsDb (4 RMS dBFS noise floors), speechGain (linear, default 2.2 which
 * gives about -24 dBFS RMS in the burst), bleedDb (speech of every other mic leaking into
 * each mic, dB below its own; default off), video (adds a gray video stream).
 */
function makeMaster(outPath, options) {
  const opts = options || {};
  const floors = opts.floorsDb || [-66, -70, -74, -78];
  const speech = opts.speechGain === undefined ? 2.2 : opts.speechGain;
  const bleed = Number.isFinite(opts.bleedDb) ? dbToLin(opts.bleedDb) : 0;
  const parts = [];
  for (let i = 0; i < 4; i += 1) {
    // anoisesrc white at amplitude a measures about a / 2.88 RMS (calibrated against astats)
    const a = dbToLin(floors[i]) * 2.88;
    parts.push(`anoisesrc=c=white:a=${a}:r=48000:d=${DURATION_S}:seed=${7 * (i + 1)}[n${i}]`);
    const [s, e] = BURSTS[i];
    const outs = bleed > 0 ? '[s' + i + '_0][s' + i + '_1][s' + i + '_2][s' + i + '_3]' : '[s' + i + '_' + i + ']';
    parts.push(`anoisesrc=c=pink:a=0.5:r=48000:d=${DURATION_S}:seed=${13 * (i + 1)},highpass=f=150,lowpass=f=3500,`
      + `volume=eval=frame:volume='if(between(t\\,${s}\\,${e})\\,${speech}*(0.6+0.4*sin(2*PI*4*t))\\,0)'`
      + (bleed > 0 ? ',asplit=4' : ',anull') + outs);
  }
  for (let i = 0; i < 4; i += 1) {
    const ins = [`[n${i}]`, `[s${i}_${i}]`];
    if (bleed > 0) {
      for (let j = 0; j < 4; j += 1) {
        if (j === i) continue;
        parts.push(`[s${j}_${i}]volume=${bleed}[b${i}_${j}]`);
        ins.push(`[b${i}_${j}]`);
      }
    }
    parts.push(`${ins.join('')}amix=inputs=${ins.length}:normalize=0:duration=longest,aformat=sample_fmts=fltp:channel_layouts=stereo[t${i}]`);
  }
  const args = ['-nostdin', '-v', 'error', '-y'];
  if (opts.video) args.push('-f', 'lavfi', '-i', `color=c=gray:s=160x90:r=30:d=${DURATION_S}`);
  args.push('-filter_complex', parts.join(';'));
  if (opts.video) args.push('-map', '0:v');
  for (let i = 0; i < 4; i += 1) args.push('-map', `[t${i}]`);
  if (opts.video) args.push('-c:v', 'libx264', '-preset', 'ultrafast');
  args.push('-c:a', 'aac', '-b:a', '160k', outPath);
  execFileSync('ffmpeg', args);
  return outPath;
}

/** RMS and peak dBFS of [start, end] seconds of one audio stream of a file (all channels, ffmpeg astats). */
function levelDb(file, streamSelector, start, end) {
  const res = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'info', '-i', file, '-map', streamSelector,
    '-af', `atrim=start=${start}:end=${end},astats=measure_perchannel=none:measure_overall=RMS_level+Peak_level`, '-f', 'null', '-']);
  const text = (res.stderr || '').toString();
  const rms = text.match(/Overall[\s\S]*?RMS level dB:\s*(-?[\d.]+|-inf)/);
  const peak = text.match(/Overall[\s\S]*?Peak level dB:\s*(-?[\d.]+|-inf)/);
  const num = (m) => (m ? (m[1] === '-inf' ? -120 : Number(m[1])) : NaN);
  return { rms: num(rms), peak: num(peak) };
}

module.exports = { BURSTS, DURATION_S, HAVE_FFMPEG, ROOM_TONE, levelDb, makeMaster };
