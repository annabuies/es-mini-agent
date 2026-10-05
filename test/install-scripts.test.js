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

test('--obs-launcher turns macOS session restore off so only the launcher starts OBS; uninstall restores it', () => {
  const install = fs.readFileSync(path.join(projectDir, 'install.sh'), 'utf8');
  const uninstall = fs.readFileSync(path.join(projectDir, 'uninstall.sh'), 'utf8');
  const block = install.slice(install.indexOf('# ---------- optional OBS login launcher ----------'), install.indexOf('# ---------- verify ----------'));
  assert.match(block, /defaults write com\.apple\.loginwindow TALLogoutSavesState -bool false/);
  assert.match(block, /defaults write com\.apple\.loginwindow LoginwindowLaunchesRelaunchApps -bool false/);
  assert.match(block, /defaults -currentHost delete com\.apple\.loginwindow TALAppsToRelaunchAtLogin/);
  assert.match(uninstall, /defaults delete com\.apple\.loginwindow TALLogoutSavesState/);
  assert.match(uninstall, /defaults delete com\.apple\.loginwindow LoginwindowLaunchesRelaunchApps/);
});

// Runs obs-launcher.sh against stub pgrep/ps/lsof/open/sleep. `kill` is a bash builtin,
// so the "OBS" is a real orphaned sleep (launchd reaps it, so kill -0 sees it go).
// By default the stub lsof shows an OBS stuck at the Safe Mode dialog: only its
// binary open, no recording file, no listening port.
function runLauncher({ obsArgs, obsLstart, dockLstart, lsofFile = '', lsofListen = '', lsofUnreadable = false }) {
  const os = require('node:os');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-obsrun-'));
  const obsPid = execFileSync('/bin/sh', ['-c', '/bin/sleep 300 >/dev/null 2>&1 & echo $!']).toString().trim();
  try {
    fs.writeFileSync(path.join(bin, 'pgrep'), `#!/bin/sh
[ "$2" = OBS ] && echo ${obsPid} && exit 0
[ "$4" = Dock ] && [ -n "$DOCK_LSTART" ] && echo 647 && exit 0
exit 1
`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh
case "$2" in
  args=) echo "$OBS_ARGS" ;;
  lstart=) if [ "$4" = 647 ]; then echo "$DOCK_LSTART"; else echo "$OBS_LSTART"; fi ;;
esac
`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'lsof'), `#!/bin/sh
case "$*" in
  *sTCP:LISTEN*) [ -n "$LSOF_LISTEN" ] || exit 1; printf 'p1\\nf20\\nn%s\\n' "$LSOF_LISTEN" ;;
  *) [ -z "$LSOF_UNREADABLE" ] || exit 1
     printf 'p1\\nfcwd\\nn/\\nftxt\\nn/Applications/OBS.app/Contents/MacOS/OBS\\n'
     [ -z "$LSOF_FILE" ] || printf 'f31\\nn%s\\n' "$LSOF_FILE" ;;
esac
`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'open'), '#!/bin/sh\necho "OPENED $*"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\n/bin/sleep 0.2\n', { mode: 0o755 });
    const out = execFileSync('/bin/bash', [path.join(projectDir, 'obs-launcher.sh')], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`, HOME: bin, OBS_ARGS: obsArgs, OBS_LSTART: obsLstart, DOCK_LSTART: dockLstart || '',
        LSOF_FILE: lsofFile, LSOF_LISTEN: lsofListen, LSOF_UNREADABLE: lsofUnreadable ? '1' : '',
      },
    }).toString();
    let alive = true;
    try { process.kill(Number(obsPid), 0); } catch { alive = false; }
    return { out, alive, obsPid };
  } finally {
    try { process.kill(Number(obsPid), 'SIGKILL'); } catch {}
    fs.rmSync(bin, { recursive: true, force: true });
  }
}

const OBS_BIN = '/Applications/OBS.app/Contents/MacOS/OBS';

test('OBS launcher leaves an OBS that already has --disable-shutdown-check', () => {
  const r = runLauncher({ obsArgs: `${OBS_BIN} --disable-shutdown-check`, obsLstart: 'Fri Oct  2 12:23:37 2026', dockLstart: 'Fri Oct  2 12:23:26 2026' });
  assert.match(r.out, /OBS already running with --disable-shutdown-check \(pid \d+\), leaving it$/m);
  assert.doesNotMatch(r.out, /OPENED/);
  assert.equal(r.alive, true);
});

test('OBS launcher restarts an OBS that macOS reopened at login without the flag (power pull, 10-02)', () => {
  const r = runLauncher({ obsArgs: OBS_BIN, obsLstart: 'Fri Oct  2 12:23:37 2026', dockLstart: 'Fri Oct  2 12:23:26 2026' });
  assert.match(r.out, /reopened by macOS 11 s after login without --disable-shutdown-check; restarting it/);
  assert.equal(r.alive, false);
  assert.match(r.out, /OPENED (\/Applications\/OBS\.app|-a OBS) --args --disable-shutdown-check$/m);
});

test('OBS launcher never touches an OBS opened by hand after login (installer reload mid-day)', () => {
  const r = runLauncher({ obsArgs: OBS_BIN, obsLstart: 'Fri Oct  2 14:40:00 2026', dockLstart: 'Fri Oct  2 12:23:26 2026' });
  assert.match(r.out, /OBS already running \(pid \d+\), not started with this login, leaving it: \/Applications\/OBS\.app\/Contents\/MacOS\/OBS$/m);
  assert.doesNotMatch(r.out, /OPENED/);
  assert.equal(r.alive, true);
});

// Audit 10-05 F3: someone opens OBS by hand right after login (inside the restore
// window, before the LaunchAgent gets to it) and starts recording.
test('OBS launcher never kills a flagless OBS that is recording, even one started right after login', () => {
  const r = runLauncher({ obsArgs: OBS_BIN, obsLstart: 'Fri Oct  2 12:23:37 2026', dockLstart: 'Fri Oct  2 12:23:26 2026', lsofFile: '/Users/megadesk/Movies/2026-10-02 12-23-50.mkv' });
  assert.match(r.out, /started 11 s after login without --disable-shutdown-check, but it has a recording file open; leaving it/);
  assert.doesNotMatch(r.out, /restarting it|OPENED/);
  assert.equal(r.alive, true);
});

test('OBS launcher leaves a flagless OBS that is past the Safe Mode dialog (obs-websocket listening)', () => {
  const r = runLauncher({ obsArgs: OBS_BIN, obsLstart: 'Fri Oct  2 12:23:37 2026', dockLstart: 'Fri Oct  2 12:23:26 2026', lsofListen: '*:4455' });
  assert.match(r.out, /but it is listening on a port, so it is past the Safe Mode dialog; leaving it/);
  assert.doesNotMatch(r.out, /OPENED/);
  assert.equal(r.alive, true);
});

test('OBS launcher leaves a flagless OBS whose open files it cannot read (no proof it is idle)', () => {
  const r = runLauncher({ obsArgs: OBS_BIN, obsLstart: 'Fri Oct  2 12:23:37 2026', dockLstart: 'Fri Oct  2 12:23:26 2026', lsofUnreadable: true });
  assert.match(r.out, /but its open files cannot be read; leaving it/);
  assert.doesNotMatch(r.out, /OPENED/);
  assert.equal(r.alive, true);
});

test('OBS launcher: a non-recording file (a log, a scene collection) does not count as a recording', () => {
  const r = runLauncher({ obsArgs: OBS_BIN, obsLstart: 'Fri Oct  2 12:23:37 2026', dockLstart: 'Fri Oct  2 12:23:26 2026', lsofFile: '/Users/megadesk/Library/Application Support/obs-studio/logs/2026-10-02 12-23-37.txt' });
  assert.match(r.out, /restarting it/);
  assert.equal(r.alive, false);
});

test('OBS launcher leaves OBS alone when it cannot tell when login happened', () => {
  const r = runLauncher({ obsArgs: OBS_BIN, obsLstart: 'Fri Oct  2 12:23:37 2026', dockLstart: '' });
  assert.match(r.out, /not started with this login, leaving it/);
  assert.equal(r.alive, true);
});

test('agent release version is 2026.10.03-1', () => {
  const server = fs.readFileSync(path.join(projectDir, 'server.js'), 'utf8');
  assert.match(server, /const AGENT_VERSION = '2026\.10\.03-1';/);
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
