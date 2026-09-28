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
  assert.match(obsPlist, /obs-launcher\.sh/);
  assert.match(obsLauncher, /open -a OBS --args --disable-shutdown-check/);
  assert.match(obsLauncher, /pgrep -x OBS/);
});

test('agent release version is 2026.09.28-3', () => {
  const server = fs.readFileSync(path.join(projectDir, 'server.js'), 'utf8');
  assert.match(server, /const AGENT_VERSION = '2026\.09\.28-3';/);
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
