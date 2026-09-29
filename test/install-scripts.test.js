'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectDir = path.resolve(__dirname, '..');

test('installer and launcher shell scripts pass bash syntax checks', () => {
  for (const name of ['install.sh', 'uninstall.sh', 'obs-launcher.sh']) {
    execFileSync('/bin/bash', ['-n', path.join(projectDir, name)]);
  }
});

test('installer removes the stale agent plist and supports the opt-in OBS launcher', () => {
  const install = fs.readFileSync(path.join(projectDir, 'install.sh'), 'utf8');
  const uninstall = fs.readFileSync(path.join(projectDir, 'uninstall.sh'), 'utf8');
  const manifest = fs.readFileSync(path.join(projectDir, 'modules.txt'), 'utf8');
  const obsPlist = fs.readFileSync(path.join(projectDir, 'com.es.obs-launcher.plist'), 'utf8');
  const obsLauncher = fs.readFileSync(path.join(projectDir, 'obs-launcher.sh'), 'utf8');

  assert.doesNotMatch(manifest, /^com\.es\.mini-agent\.plist$/m);
  assert.match(install, /rm -f "\$PROJECT_DIR\/com\.es\.mini-agent\.plist"/);
  assert.doesNotMatch(install, /download "com\.es\.mini-agent\.plist"/);

  assert.match(install, /--obs-launcher/);
  assert.match(install, /launchctl load "\$OBS_LAUNCHER_PLIST"/);
  assert.match(uninstall, /com\.es\.obs-launcher\.plist/);
  assert.match(obsPlist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(obsPlist, /<key>KeepAlive<\/key>\s*<false\/>/);
  assert.match(obsPlist, /__LAUNCHER_DIR__\/obs-launcher\.sh/);
  assert.doesNotMatch(obsPlist, /__PROJECT_DIR__/);
  assert.match(obsLauncher, /open -a OBS --args --disable-shutdown-check/);
  assert.match(obsLauncher, /pgrep -x OBS/);
});

test('agent release version is 2026.09.29-1', () => {
  const server = fs.readFileSync(path.join(projectDir, 'server.js'), 'utf8');
  assert.match(server, /const AGENT_VERSION = '2026\.09\.29-1';/);
});

test('installer persists the power strip env into the plist and modules.txt ships power.js', () => {
  const install = fs.readFileSync(path.join(projectDir, 'install.sh'), 'utf8');
  const manifest = fs.readFileSync(path.join(projectDir, 'modules.txt'), 'utf8');
  for (const key of ['POWER_STRIP_URL', 'POWER_STRIP_USER', 'POWER_STRIP_PASS', 'POWER_OUTLETS_SWITCHABLE']) {
    assert.match(install, new RegExp(`<key>${key}</key>\\s*<string>\\$\\{${key}_X\\}</string>`));
  }
  assert.match(manifest, /^power\.js$/m);
});

test('modules.txt lists only .js runtime modules (deployed self-update rejects anything else)', () => {
  const manifest = fs.readFileSync(path.join(projectDir, 'modules.txt'), 'utf8')
    .split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
  assert.ok(manifest.length > 0);
  assert.deepEqual(manifest.filter((m) => !/^[A-Za-z0-9._-]+\.js$/.test(m)), []);
});

test('installer reuses values from the live plist for anything left unset (bash 3.2 safe)', { skip: process.platform !== 'darwin' && 'needs /usr/libexec/PlistBuddy' }, () => {
  const { execFileSync } = require('node:child_process');
  const os = require('node:os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-reuse-'));
  try {
    fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
    fs.writeFileSync(path.join(home, 'Library', 'LaunchAgents', 'com.es.mini-agent.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>EnvironmentVariables</key><dict>
<key>BUILDING_ID</key><string>bench-1</string>
<key>RECORD_CONTROL_KEY</key><string>k3y &amp; "q"</string>
<key>OBS_SOURCES</key><string>cam1,cam2,cam3</string>
<key>POWER_STRIP_URL</key><string>http://old</string>
</dict></dict></plist>`);
    const install = fs.readFileSync(path.join(projectDir, 'install.sh'), 'utf8');
    const start = install.indexOf('# ---------- reuse an existing install ----------');
    const end = install.indexOf('# ---------- read inputs ----------');
    assert.ok(start > 0 && end > start);
    const script = `set -euo pipefail\n${install.slice(start, end)}\nprintf '%s|%s|%s|%s' "$BUILDING_ID" "$RECORD_CONTROL_KEY" "$OBS_SOURCES" "$POWER_STRIP_URL"`;
    const out = execFileSync('/bin/bash', ['-c', script], { env: { PATH: process.env.PATH, HOME: home, POWER_STRIP_URL: 'http://172.16.1.40' } }).toString();
    assert.equal(out, 'bench-1|k3y & "q"|cam1,cam2,cam3|http://172.16.1.40');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('OBS launcher runs from Application Support, never ~/Documents (launchd bash gets EPERM there)', () => {
  const os = require('node:os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-obs-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-bin-'));
  try {
    fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
    fs.writeFileSync(path.join(bin, 'launchctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const install = fs.readFileSync(path.join(projectDir, 'install.sh'), 'utf8');
    const helpers = install.slice(install.indexOf('xml_escape() {'), install.indexOf('LAUNCH_AGENTS_DIR='));
    const start = install.indexOf('# ---------- optional OBS login launcher ----------');
    const end = install.indexOf('# ---------- verify ----------');
    assert.ok(start > 0 && end > start);
    const script = `set -euo pipefail
ok() { :; }; warn() { :; }; err() { echo "$*" >&2; }
${helpers}
INSTALL_OBS_LAUNCHER=1
PROJECT_DIR=${JSON.stringify(projectDir)}
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
${install.slice(start, end)}`;
    execFileSync('/bin/bash', ['-c', script], { env: { PATH: `${bin}:${process.env.PATH}`, HOME: home } });
    const plist = fs.readFileSync(path.join(home, 'Library', 'LaunchAgents', 'com.es.obs-launcher.plist'), 'utf8');
    const dir = path.join(home, 'Library', 'Application Support', 'es-mini-agent');
    assert.ok(plist.includes(`<string>${dir}/obs-launcher.sh</string>`));
    assert.ok(plist.includes(`<string>${dir}/obs-launcher.error.log</string>`));
    assert.doesNotMatch(plist, /Documents|__LAUNCHER_DIR__/);
    assert.ok(fs.statSync(path.join(dir, 'obs-launcher.sh')).mode & 0o100);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});
