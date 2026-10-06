'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
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
  assert.match(obsLauncher, /open -a OBS \|\|/);
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

// Runs obs-launcher.sh against stub pgrep/ps/sysctl/open/sleep and a temporary HOME.
// The stub `open` behaves like OBS 32's crash check (CrashHandler.cpp): if any
// .sentinel/run_* marker is left, its log says "Crash or unclean shutdown
// detected" and it waits at the dialog unless `fakeObs` says someone clicked.
// `markers` maps a marker name to its age in seconds relative to boot
// (negative = written before this boot).
const LAUNCHER_ON_MAC = { skip: process.platform !== 'darwin' && 'needs BSD stat/date' };
const OBS_BIN = '/Applications/OBS.app/Contents/MacOS/OBS';

function lstart(epoch) {
  return execFileSync('/bin/date', ['-r', String(epoch), '+%a %b %e %T %Y']).toString().trim();
}

function runLauncher({ markers = {}, bootAgo = 120, dockAgo = 60, noBootTime = false, fakeObs = 'auto', running = null } = {}) {
  const os = require('node:os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-obsrun-'));
  const bin = path.join(home, 'bin');
  const support = path.join(home, 'Library', 'Application Support');
  const sentinel = path.join(support, 'obs-studio', '.sentinel');
  const logs = path.join(support, 'obs-studio', 'logs');
  const archive = path.join(support, 'es-mini-agent', 'obs-sentinel-archive');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(sentinel, { recursive: true });
  fs.mkdirSync(logs, { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  const boot = now - bootAgo;
  for (const [name, ageVsBoot] of Object.entries(markers)) {
    const f = path.join(sentinel, name);
    fs.writeFileSync(f, '');
    fs.utimesSync(f, boot + ageVsBoot, boot + ageVsBoot);
  }
  // A log from an earlier OBS run that ended at the dialog must not be read as this run's.
  const oldLog = path.join(logs, '2026-10-01 08-00-00.txt');
  fs.writeFileSync(oldLog, '08:00:00.000: Crash or unclean shutdown detected\n');
  fs.utimesSync(oldLog, boot - 7200, boot - 7200);

  let obsPid = '';
  if (running) {
    obsPid = execFileSync('/bin/sh', ['-c', '/bin/sleep 300 >/dev/null 2>&1 & echo $!']).toString().trim();
    fs.writeFileSync(path.join(logs, '2099-01-01 00-00-00.txt'), running.log);
  }
  fs.writeFileSync(path.join(bin, 'pgrep'), `#!/bin/sh
[ "$2" = OBS ] && [ -n "$OBS_PID" ] && /bin/kill -0 "$OBS_PID" 2>/dev/null && echo "$OBS_PID" && exit 0
[ "$4" = Dock ] && [ -n "$DOCK_LSTART" ] && echo 647 && exit 0
exit 1
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh
case "$2" in
  args=) echo "${OBS_BIN}" ;;
  lstart=) if [ "$4" = 647 ]; then echo "$DOCK_LSTART"; else echo "$OBS_LSTART"; fi ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'sysctl'), `#!/bin/sh
[ -n "$BOOT_SEC" ] || exit 1
echo "{ sec = $BOOT_SEC, usec = 654321 } Mon Oct  5 09:00:00 2026"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'open'), `#!/bin/sh
[ "$1" = -Ra ] && exit 0
echo "OPENED $*" >> "$HOME/opened"
[ "$FAKE_OBS" = silent ] && exit 0
crash=""
for m in "$HOME/Library/Application Support/obs-studio/.sentinel"/run_*; do [ -f "$m" ] && crash=1; done
f="$HOME/Library/Application Support/obs-studio/logs/2099-01-01 00-00-00.txt"
echo "00:00:00.100: Platform: Apple" > "$f"
[ -n "$crash" ] && echo "00:00:00.200: Crash or unclean shutdown detected" >> "$f"
case "$FAKE_OBS" in
  normal) [ -n "$crash" ] && echo "00:00:09.000: [Safe Mode] Normal launch selected, loading third-party plugins is enabled" >> "$f" ;;
  safe) [ -n "$crash" ] && echo "00:00:09.000: [Safe Mode] Safe mode launch selected, loading third-party plugins is disabled" >> "$f" ;;
  other-prompt) exit 0 ;;
esac
if [ -z "$crash" ] || [ "$FAKE_OBS" = normal ] || [ "$FAKE_OBS" = safe ]; then
  echo "00:00:09.100: Current Date/Time: 2099-01-01, 00:00:09" >> "$f"
fi
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\n/bin/sleep 0.01\n', { mode: 0o755 });
  try {
    const r = spawnSync('/bin/bash', [path.join(projectDir, 'obs-launcher.sh')], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`, HOME: home, FAKE_OBS: fakeObs,
        BOOT_SEC: noBootTime ? '' : String(boot),
        DOCK_LSTART: dockAgo === null ? '' : lstart(now - dockAgo),
        OBS_PID: obsPid, OBS_LSTART: running ? lstart(now - running.startedAgo) : '',
      },
    });
    const list = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.startsWith('run_')).sort() : []);
    const archived = {};
    if (fs.existsSync(archive)) {
      for (const batch of fs.readdirSync(archive)) {
        for (const n of list(path.join(archive, batch))) archived[n] = fs.statSync(path.join(archive, batch, n)).mtimeMs / 1000;
      }
    }
    const openedFile = path.join(home, 'opened');
    let alive = null;
    if (obsPid) { try { process.kill(Number(obsPid), 0); alive = true; } catch { alive = false; } }
    return {
      out: r.stdout.toString(), err: r.stderr.toString(), status: r.status, boot, alive,
      left: list(sentinel), archived,
      opened: fs.existsSync(openedFile) ? fs.readFileSync(openedFile, 'utf8').trim().split('\n') : [],
    };
  } finally {
    if (obsPid) { try { process.kill(Number(obsPid), 'SIGKILL'); } catch {} }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('OBS launcher only sends TERM to a proven dialog-blocked process and no longer passes the removed flag', () => {
  const launcher = fs.readFileSync(path.join(projectDir, 'obs-launcher.sh'), 'utf8');
  assert.match(launcher, /kill -TERM "\$pid"/);
  assert.doesNotMatch(launcher, /kill -KILL|pkill|killall|osascript/);
  assert.doesNotMatch(launcher, /--args|open[^\n]*--disable-shutdown-check/);
  assert.doesNotMatch(launcher, /\brm\b/);
});

test('power cut or restart: cold login archives the marker from before this boot and OBS starts with no dialog', LAUNCHER_ON_MAC, () => {
  const r = runLauncher({ markers: { 'run_before-power-cut': -900 } });
  assert.deepEqual(r.left, []);
  assert.deepEqual(Object.keys(r.archived), ['run_before-power-cut']);
  assert.equal(r.archived['run_before-power-cut'], r.boot - 900, 'archive keeps the marker and its time');
  assert.match(r.out, /archived OBS crash marker run_before-power-cut .*before this boot/);
  assert.equal(r.opened.length, 1);
  assert.match(r.opened[0], /^OPENED (\/Applications\/OBS\.app|-a OBS)$/);
  assert.match(r.out, /OBS started with no Safe Mode dialog \(log 2099-01-01 00-00-00\.txt\)$/m);
  assert.doesNotMatch(r.out + r.err, /ALERT/);
  assert.equal(r.status, 0);
});

test('normal restart where OBS quit cleanly: no markers, nothing archived, OBS starts', LAUNCHER_ON_MAC, () => {
  const r = runLauncher();
  assert.deepEqual(r.archived, {});
  assert.doesNotMatch(r.out, /archived/);
  assert.equal(r.opened.length, 1);
  assert.match(r.out, /OBS started with no Safe Mode dialog/);
  assert.equal(r.status, 0);
});

test('crash during this boot: its marker is left, OBS is started once and the dialog raises an alert', LAUNCHER_ON_MAC, () => {
  const r = runLauncher({ markers: { 'run_crashed-this-boot': 30 } });
  assert.deepEqual(r.left, ['run_crashed-this-boot']);
  assert.deepEqual(r.archived, {});
  assert.match(r.out, /leaving 1 OBS crash marker\(s\) .*written since this boot/);
  assert.equal(r.opened.length, 1, 'one launch attempt only');
  assert.match(r.out, /ALERT: OBS is waiting at the Safe Mode dialog \(log 2099-01-01 00-00-00\.txt\)\. Someone at the Mini must choose Run in Normal Mode/);
  assert.match(r.err, /ALERT: OBS is waiting at the Safe Mode dialog/);
  assert.equal(r.status, 1);
});

test('markers from before and since this boot: only the old one is archived', LAUNCHER_ON_MAC, () => {
  const r = runLauncher({ markers: { 'run_before-power-cut': -60, 'run_crashed-this-boot': 45 } });
  assert.deepEqual(r.left, ['run_crashed-this-boot']);
  assert.deepEqual(Object.keys(r.archived), ['run_before-power-cut']);
  assert.match(r.out, /ALERT: OBS is waiting at the Safe Mode dialog/);
  assert.equal(r.opened.length, 1);
});

test('not a cold login (installer reloaded mid-day): markers are left as they are', LAUNCHER_ON_MAC, () => {
  const r = runLauncher({ markers: { 'run_before-power-cut': -900 }, bootAgo: 9000, dockAgo: 7200 });
  assert.deepEqual(r.left, ['run_before-power-cut']);
  assert.deepEqual(r.archived, {});
  assert.match(r.out, /not a cold login \(7[0-9]{3} s after login; launcher reloaded or login time unknown\)/);
  assert.equal(r.opened.length, 1);
  assert.match(r.out, /ALERT: OBS is waiting at the Safe Mode dialog/);
});

test('login time or boot time unknown: markers are left as they are', LAUNCHER_ON_MAC, () => {
  const noDock = runLauncher({ markers: { 'run_before-power-cut': -900 }, dockAgo: null });
  assert.deepEqual(noDock.left, ['run_before-power-cut']);
  assert.match(noDock.out, /not a cold login \(launcher reloaded or login time unknown\)/);
  const noBoot = runLauncher({ markers: { 'run_before-power-cut': -900 }, noBootTime: true });
  assert.deepEqual(noBoot.left, ['run_before-power-cut']);
  assert.match(noBoot.out, /cannot read the boot time; leaving OBS crash markers as they are/);
});

test('a macOS-reopened OBS stuck at the dialog is stopped and relaunched after its markers are archived', LAUNCHER_ON_MAC, () => {
  const r = runLauncher({
    markers: { 'run_before-power-cut': -900, 'run_reopened-by-macos': 78 },
    bootAgo: 120,
    running: { startedAgo: 45, log: '00:00:00.200: Crash or unclean shutdown detected\n' },
  });
  assert.equal(r.alive, false);
  assert.deepEqual(r.left, []);
  assert.deepEqual(Object.keys(r.archived).sort(), ['run_before-power-cut', 'run_reopened-by-macos']);
  assert.equal(r.opened.length, 1);
  assert.match(r.out, /dialog-blocked OBS exited and its markers were archived; starting a fresh OBS/);
  assert.equal(r.status, 0);
});

test('same-boot crash or extra marker does not allow recovery of a running OBS', LAUNCHER_ON_MAC, () => {
  const r = runLauncher({
    markers: { run_crashed: 20, run_current: 78 }, bootAgo: 120,
    running: { startedAgo: 45, log: '00:00:00.200: Crash or unclean shutdown detected\n' },
  });
  assert.equal(r.alive, true);
  assert.deepEqual(r.opened, []);
  assert.deepEqual(r.left, ['run_crashed', 'run_current']);
  assert.equal(r.status, 1);
});

test('a reopened OBS that finished startup is never stopped, even with a preboot marker', LAUNCHER_ON_MAC, () => {
  const r = runLauncher({
    markers: { 'run_before-power-cut': -900, 'run_reopened-by-macos': 78 }, bootAgo: 120,
    running: { startedAgo: 45, log: '00:00:00.200: Crash or unclean shutdown detected\n00:00:03.000: [Safe Mode] Normal launch selected\n00:00:03.100: Current Date/Time: x\n00:00:30.000: ==== Recording Start ===\n' },
  });
  assert.equal(r.alive, true);
  assert.deepEqual(r.opened, []);
  assert.deepEqual(r.left, ['run_before-power-cut', 'run_reopened-by-macos']);
  assert.equal(r.status, 0);
});

test('an OBS opened by hand right after login and recording is left alone with no alert', LAUNCHER_ON_MAC, () => {
  const r = runLauncher({
    markers: { 'run_opened-by-hand': 20 },
    running: { startedAgo: 40, log: '00:00:00.200: Crash or unclean shutdown detected\n00:00:03.000: [Safe Mode] Normal launch selected, loading third-party plugins is enabled\n00:00:03.100: Current Date/Time: x\n00:00:30.000: ==== Recording Start ===\n' },
  });
  assert.equal(r.alive, true);
  assert.deepEqual(r.opened, []);
  assert.match(r.out, /OBS \(pid \d+\) got past the Safe Mode dialog: someone chose Run in Normal Mode/);
  assert.doesNotMatch(r.out + r.err, /ALERT/);
  assert.equal(r.status, 0);
});

test('someone at the Mini answers the dialog: Normal Mode is logged, Safe Mode raises an alert', LAUNCHER_ON_MAC, () => {
  const normal = runLauncher({ markers: { 'run_crashed-this-boot': 30 }, fakeObs: 'normal' });
  assert.match(normal.out, /OBS got past the Safe Mode dialog: someone chose Run in Normal Mode/);
  assert.equal(normal.status, 0);
  const safe = runLauncher({ markers: { 'run_crashed-this-boot': 30 }, fakeObs: 'safe' });
  assert.match(safe.out, /ALERT: OBS was started in Safe Mode by someone at the Mini: obs-websocket is off/);
  assert.equal(safe.status, 1);
});

test('OBS writes no new log, or stops at another prompt: alert, and an old log is not mistaken for this run', LAUNCHER_ON_MAC, () => {
  const silent = runLauncher({ fakeObs: 'silent' });
  assert.match(silent.out, /ALERT: OBS wrote no startup log within 90 s/);
  assert.equal(silent.opened.length, 1);
  const other = runLauncher({ fakeObs: 'other-prompt' });
  assert.match(other.out, /ALERT: OBS has not finished starting after 90 s and shows no Safe Mode dialog/);
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
  const { execFileSync, spawnSync } = require('node:child_process');
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
