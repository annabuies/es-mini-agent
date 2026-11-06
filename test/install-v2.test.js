'use strict';

// install.sh v2 end to end in a sandbox: fake HOME, PATH shims for launchctl / pgrep /
// lsof / defaults / brew / pmset / fdesetup, and an in-process fake agent answering
// /health, /record/status and /record/diag. Every installer run uses /bin/bash (3.2 on
// macOS), never Homebrew bash. Nothing here touches the real LaunchAgents, launchd or
// user defaults.
//
// Fail-before: the same fixtures are run through the 20230f2 install.sh (v1) to show
// the bug or missing guard, then through v2.

const assert = require('node:assert/strict');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const projectDir = path.resolve(__dirname, '..');
// ES_MINI_TEST_INSTALLER runs the suite against another copy (fail-before checks on a parent commit).
const V2 = process.env.ES_MINI_TEST_INSTALLER || path.join(projectDir, 'install.sh');
const COMMIT = '20230f20fdd3345451e947e907b26455daed787b';
const C7 = COMMIT.slice(0, 7);
const VERSION = '2026.11.05-1';
const TAR_SHA = 'a62d02a7d2d1a1c24f61383f5361a42f1a7a22c87da969af4f09addf8ab3c802';
const OLD_VERSION = '2026.10.20-1';

const onMac = process.platform === 'darwin';
const hasCommit = spawnSync('git', ['-C', projectDir, 'cat-file', '-e', `${COMMIT}^{commit}`]).status === 0;
const SKIP = { skip: (!onMac && 'needs macOS (PlistBuddy, plutil, launchd layout)') || (!hasCommit && `needs commit ${C7}`) };

// Secret values in the fixture plist. None may ever appear in installer output.
const SECRETS = {
  RECORD_CONTROL_KEY: 'rck-Z9 & <x> "q" \'s\' $HOME `t`',
  S3_SECRET_ACCESS_KEY: 's3-secret-Q7r!',
  S3_ACCESS_KEY_ID: 'AKIAFAKE000111',
  OBS_WS_PASSWORD: 'obs-pass-55',
  PTZ_HTTP_PASS: 'ptz-pass-66',
  POWER_STRIP_PASS: 'strip-pass-77',
  UPLOAD_CONFIRMED_WEBHOOK_URL: 'https://hooks.example.invalid/x?key=whk-secret-88',
};
function fixtureEnv(port) {
  return {
    AWS_ROLE_ARN: '', BUILDING_ID: 'bench-1', FFMPEG_BIN: '/opt/homebrew/bin/ffmpeg',
    OBS_RECORD_DIR: '/Users/x/Movies/OBS', OBS_SOURCES: 'cam1,cam2,cam3',
    OBS_WS_PASSWORD: SECRETS.OBS_WS_PASSWORD, OBS_WS_URL: 'ws://127.0.0.1:4455', PORT: String(port),
    POWER_OUTLETS_SWITCHABLE: '', POWER_STRIP_PASS: SECRETS.POWER_STRIP_PASS, POWER_STRIP_URL: 'http://192.168.1.40',
    POWER_STRIP_USER: 'admin', PTZ_HTTP_PASS: SECRETS.PTZ_HTTP_PASS, PTZ_HTTP_USER: 'admin',
    RECORD_CONTROL_KEY: SECRETS.RECORD_CONTROL_KEY, RECORD_POLL_URL: 'https://api.evrybdystudios.com',
    S3_ACCESS_KEY_ID: SECRETS.S3_ACCESS_KEY_ID, S3_BUCKET: 'es-recordings', S3_ENDPOINT: '', S3_REGION: 'us-east-1',
    S3_SECRET_ACCESS_KEY: SECRETS.S3_SECRET_ACCESS_KEY, UPLOAD_CONFIRMED_WEBHOOK_URL: SECRETS.UPLOAD_CONFIRMED_WEBHOOK_URL,
    // Hand-added keys the 22-key v1 installer drops (the bug).
    RTSP_CAPTURE: '0', WATCH_HW: '1',
  };
}
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function plistXml({ env, wd, node }) {
  const kv = Object.entries(env).map(([k, v]) => `        <key>${k}</key>\n        <string>${esc(v)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.es.mini-agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>${esc(node)}</string>
        <string>server.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${esc(wd)}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <!-- camera web-UI admin login; lives only on this Mini -->
${kv}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${esc(wd)}/agent.log</string>
    <key>StandardErrorPath</key>
    <string>${esc(wd)}/agent.error.log</string>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
`;
}

let PKG = null;   // { dir, tar, sums }
function pkg() {
  if (PKG) return PKG;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-v2pkg-'));
  execFileSync('/bin/bash', [path.join(projectDir, 'scripts', 'build-mini-package.sh'), projectDir, dir, COMMIT, VERSION]);
  PKG = { dir, tar: path.join(dir, `es-mini-agent-${VERSION}-${C7}.tar`), sums: path.join(dir, `SHA256SUMS-files-${VERSION}.txt`) };
  return PKG;
}

const SHIMS = {
  launchctl: `#!/bin/sh
S="$FAKE_STATE"; echo "launchctl $*" >> "$S/calls.log"
case "$1" in
  list)
    [ -f "$S/loaded" ] && printf '%s\\t0\\tcom.es.mini-agent\\n' "$(cat "$S/pid")"
    [ -f "$S/obs-loaded" ] && printf -- '-\\t0\\tcom.es.obs-launcher\\n'
    exit 0 ;;
  unload)
    case "$2" in *obs-launcher*) rm -f "$S/obs-loaded" ;; *) rm -f "$S/loaded" ;; esac; exit 0 ;;
  load)
    case "$2" in *obs-launcher*) touch "$S/obs-loaded"; exit 0 ;; esac
    [ -f "$S/fail-load" ] && exit 5
    wd="$(/usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "$2")"
    out="$(/usr/libexec/PlistBuddy -c 'Print :StandardOutPath' "$2")"
    printf '%s' "$wd" > "$S/cwd"; cp "$2" "$S/loaded.plist"
    n=$(( $(cat "$S/pid" 2>/dev/null || echo 500) + 1 )); echo "$n" > "$S/pid"
    if [ -w "$(dirname "$out")" ]; then
      printf '[es-mini-agent] listening on :x\\n[es-mini-agent] relay: polling https://api.example/api/record every 250ms\\n' >> "$out"
      [ -f "$S/relay-401" ] && printf '[es-mini-agent] relay: poll GET 401 from https://api.example\\n' >> "$out"
    fi
    touch "$S/loaded"; exit 0 ;;
esac
exit 0
`,
  pgrep: `#!/bin/sh
[ -f "$FAKE_STATE/loaded" ] && cat "$FAKE_STATE/pid" && exit 0
exit 1
`,
  lsof: `#!/bin/sh
[ -f "$FAKE_STATE/loaded" ] || exit 1
printf 'p%s\\nfcwd\\nn%s\\n' "$(cat "$FAKE_STATE/pid")" "$(cat "$FAKE_STATE/cwd")"
`,
  defaults: `#!/bin/sh
echo "defaults $*" >> "$FAKE_STATE/calls.log"
exit 0
`,
  brew: `#!/bin/sh
echo "brew $*" >> "$FAKE_STATE/calls.log"
exit 1
`,
  pmset: `#!/bin/sh
printf 'System-wide power settings:\\nCurrently in use:\\n autorestart          1\\n sleep                0\\n'
`,
  fdesetup: `#!/bin/sh
echo "FileVault is Off."
`,
  ffmpeg: '#!/bin/sh\nexit 0\n',
  ffprobe: '#!/bin/sh\nexit 0\n',
  curl: `#!/bin/sh
for a in "$@"; do case "$a" in http://127.0.0.1:*) ;; http*) echo "curl $a" >> "$FAKE_STATE/calls.log" ;; file:*) echo "curl $a" >> "$FAKE_STATE/calls.log" ;; esac; done
for a in "$@"; do case "$a" in https://*) echo "test shim: no network" >&2; exit 7 ;; esac; done
exec /usr/bin/curl "$@"
`,
};

// One sandbox = one Mini. state: { recording, paused, uploads, crashDir }.
async function sandbox({ fresh = false, unreadableOld = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-v2-')));
  const home = path.join(root, 'home'); const bin = path.join(root, 'bin');
  const stateDir = path.join(root, 'state'); const tmp = path.join(root, 'tmp');
  for (const d of [home, bin, stateDir, tmp]) fs.mkdirSync(d, { recursive: true });
  for (const [name, body] of Object.entries(SHIMS)) fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));   // what Homebrew/nodejs.org would provide

  const state = { recording: false, paused: false, uploads: { queued: 0, active: null, proxies_pending: 0 }, crashDir: null };
  const server = http.createServer((req, res) => {
    const loaded = fs.existsSync(path.join(stateDir, 'loaded'));
    const cwd = loaded ? fs.readFileSync(path.join(stateDir, 'cwd'), 'utf8') : '';
    if (!loaded || (state.crashDir && cwd === state.crashDir)) { req.socket.destroy(); return; }
    const send = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.method === 'GET' && req.url === '/health') {
      return send({ ok: true, building_id: 'bench-1', uptime_s: 5, state: { recording: state.recording, paused: state.paused } });
    }
    // Like the real agent: the key it checks is the one in the plist launchd loaded.
    let key = SECRETS.RECORD_CONTROL_KEY;
    try { key = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path.join(stateDir, 'loaded.plist')]).toString()).EnvironmentVariables.RECORD_CONTROL_KEY; } catch {}
    if (req.headers.authorization !== 'Bearer ' + key) { res.statusCode = 401; return send({ ok: false, reason: 'unauthorized' }); }
    if (req.url === '/record/status') return send({ ok: true, recording: state.recording, uploads: state.uploads });
    if (req.url === '/record/diag') {
      let agent = null, commit = null;
      try { agent = /const AGENT_VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(cwd, 'server.js'), 'utf8'))[1]; } catch {}
      try { commit = JSON.parse(fs.readFileSync(path.join(cwd, 'update-state.json'), 'utf8')).commit; } catch {}
      return send({ ok: true, version: { agent, commit, updated_at: null } });
    }
    res.statusCode = 404; send({ ok: false });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // OBS + plugins (fake app bundle; plugins in the user's OBS folder).
  const obsApp = path.join(root, 'OBS.app');
  fs.mkdirSync(path.join(obsApp, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(obsApp, 'Contents', 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>32.1.0</string></dict></plist>\n');
  const obsSettings = path.join(home, 'Library', 'Application Support', 'obs-studio');
  for (const p of ['source-record.plugin', 'distroav.plugin']) fs.mkdirSync(path.join(obsSettings, 'plugins', p), { recursive: true });
  fs.mkdirSync(path.join(obsSettings, 'basic', 'scenes'), { recursive: true });
  fs.writeFileSync(path.join(obsSettings, 'basic', 'scenes', 'Studio.json'), '{"scenes":[]}');

  const la = path.join(home, 'Library', 'LaunchAgents');
  fs.mkdirSync(la, { recursive: true });
  const plist = path.join(la, 'com.es.mini-agent.plist');
  const oldDir = path.join(home, 'Documents', 'es-mini-agent');
  let original = null;
  if (!fresh) {
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'server.js'), `const AGENT_VERSION = '${OLD_VERSION}';\n`);
    fs.writeFileSync(path.join(oldDir, '.cam-golden.json'), '{"taken_at":"2026-10-01","cameras":{}}');
    fs.writeFileSync(path.join(oldDir, 'update-state.json'), '{"commit":"05e659ca84f42a4a016264a8366ef642806d287b"}');
    fs.mkdirSync(path.join(oldDir, '.r2-uploads'));
    fs.writeFileSync(path.join(oldDir, '.r2-uploads', 'webhook-outbox.json'), '[]');
    fs.writeFileSync(path.join(oldDir, 'agent.log'), 'old log\n');
    original = plistXml({ env: fixtureEnv(port), wd: oldDir, node: process.execPath });
    fs.writeFileSync(plist, original, { mode: 0o600 });
    fs.writeFileSync(path.join(stateDir, 'loaded.plist'), original);
    fs.writeFileSync(path.join(la, 'com.es.obs-launcher.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>com.es.obs-launcher</string></dict></plist>\n', { mode: 0o644 });
    // The old agent is running.
    fs.writeFileSync(path.join(stateDir, 'cwd'), oldDir);
    fs.writeFileSync(path.join(stateDir, 'pid'), '77993');
    fs.writeFileSync(path.join(stateDir, 'loaded'), '');
    fs.writeFileSync(path.join(stateDir, 'obs-loaded'), '');
    if (unreadableOld) fs.chmodSync(oldDir, 0o000);
  }

  const baseEnv = {
    HOME: home, TMPDIR: tmp, FAKE_STATE: stateDir,
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    ES_MINI_TOOL_DIRS: bin, ES_MINI_OBS_APP: obsApp,
    ES_MINI_READBACK_TIMEOUT: '4', ES_MINI_SETTLE_S: '1', ES_MINI_MIN_FREE_GIB: '1',
  };
  function run(script, args = [], env = {}) {
    return new Promise((resolve) => {
      fs.writeFileSync(path.join(stateDir, 'calls.log'), '');
      const child = spawn('/bin/bash', [script, ...args], { env: { ...baseEnv, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
      child.on('close', (code) => {
        if (process.env.ES_MINI_TEST_SHOW) process.stdout.write(`\n----- ${path.basename(script)} ${args.join(' ')} -> ${code}\n${out}`);
        resolve({ code, out, calls: fs.readFileSync(path.join(stateDir, 'calls.log'), 'utf8') });
      });
    });
  }
  const v2env = (extra = {}) => ({ ES_MINI_VERSION: VERSION, ES_MINI_COMMIT: COMMIT, ES_MINI_TAR_SHA256: TAR_SHA, ES_MINI_TAR: pkg().tar, ...extra });
  async function close() {
    server.close();
    if (fs.existsSync(oldDir)) fs.chmodSync(oldDir, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  }
  return { root, home, bin, stateDir, tmp, port, state, plist, oldDir, original, obsSettings, run, v2env, close,
    newDir: path.join(home, 'es-mini-agent-runtimes', `${VERSION}-${C7}`),
    backups: path.join(home, 'es-backups') };
}

function envOf(plist) {
  return JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', plist]).toString()).EnvironmentVariables;
}
function topOf(plist) { return JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', plist]).toString()); }
function noSecrets(out) {
  for (const [k, v] of Object.entries(SECRETS)) assert.ok(!out.includes(v), `output leaks ${k}`);
  assert.ok(!out.includes('whk-secret-88'), 'output leaks the webhook key');
}
function treeHash(dir) {
  const h = crypto.createHash('sha256');
  const walk = (d) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n); const st = fs.lstatSync(p);
      h.update(path.relative(dir, p) + ':' + (st.mode & 0o777) + ':');
      if (st.isDirectory()) walk(p); else h.update(fs.readFileSync(p));
    }
  };
  walk(dir); return h.digest('hex');
}
function v1Script(root) {
  const f = path.join(root, 'install-v1-20230f2.sh');
  fs.writeFileSync(f, execFileSync('git', ['-C', projectDir, 'show', `${COMMIT}:install.sh`]));
  return f;
}

// ---------------------------------------------------------------- static checks

test('install.sh v2 is bash 3.2 syntax-clean and avoids bash 4 features', () => {
  execFileSync('/bin/bash', ['-n', V2]);
  const src = fs.readFileSync(V2, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(src, /declare -A|mapfile|readarray|\$\{[A-Za-z_]+,,\}|\$\{[A-Za-z_]+\^\^\}/);
  assert.ok(fs.readFileSync(V2, 'utf8').startsWith('#!/bin/bash\n'));
});

test('install.sh v2 never downloads from GitHub main and never installs under ~/Documents', () => {
  const src = fs.readFileSync(V2, 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(code, /REPO_RAW_BASE|raw\.githubusercontent\.com\/annabuies/);
  assert.match(code, /RUNTIMES="\$HOME\/es-mini-agent-runtimes"/);
  assert.match(code, /NEW="\$RUNTIMES\/\$V-\$C7"/);
  assert.doesNotMatch(code, /NEW="[^"]*Documents/);
  // No fixed env-key list: the plist is carried over generically.
  assert.doesNotMatch(code, /<key>POWER_STRIP_URL<\/key>/);
});

// ---------------------------------------------------------------- (a) key drop

test('(a) fail-before: v1 (20230f2) drops hand-set RTSP_CAPTURE and WATCH_HW; v2 keeps every key and value', SKIP, async () => {
  const sb = await sandbox();
  try {
    // v1, local mode from an extracted copy of the package (that is how it ran on a checkout).
    const x = path.join(sb.root, 'v1'); fs.mkdirSync(x);
    execFileSync('tar', ['-xf', pkg().tar, '-C', x]);
    const v1dir = path.join(x, `es-mini-agent-${VERSION}-${C7}`);
    fs.copyFileSync(v1Script(sb.root), path.join(v1dir, 'install.sh'));
    const r1 = await sb.run(path.join(v1dir, 'install.sh'), [], { PATH: `${sb.bin}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` });
    assert.equal(r1.code, 0, r1.out);
    const after1 = envOf(sb.plist);
    assert.equal(after1.RTSP_CAPTURE, undefined, 'v1 drops RTSP_CAPTURE (the bug)');
    assert.equal(after1.WATCH_HW, undefined, 'v1 drops WATCH_HW (the bug)');

    // Same fixture again, through v2.
    fs.writeFileSync(sb.plist, sb.original, { mode: 0o600 });
    fs.writeFileSync(path.join(sb.stateDir, 'cwd'), sb.oldDir);
    const r2 = await sb.run(V2, ['--yes'], sb.v2env());
    assert.equal(r2.code, 0, r2.out);
    assert.deepEqual(envOf(sb.plist), fixtureEnv(sb.port), 'v2 keeps every key with its exact value');
    assert.match(r2.out, /new plist keeps all 24 env keys/);
    assert.match(r2.out, /env keys changed \(names only\): none/);
    noSecrets(r2.out);
  } finally { await sb.close(); }
});

// ---------------------------------------------------------------- (b) busy

test('(b) fail-before: v1 rewrites the plist and reloads while recording; v2 refuses and writes nothing', SKIP, async () => {
  const sb = await sandbox();
  try {
    sb.state.recording = true;
    const x = path.join(sb.root, 'v1'); fs.mkdirSync(x);
    execFileSync('tar', ['-xf', pkg().tar, '-C', x]);
    const v1dir = path.join(x, `es-mini-agent-${VERSION}-${C7}`);
    fs.copyFileSync(v1Script(sb.root), path.join(v1dir, 'install.sh'));
    const r1 = await sb.run(path.join(v1dir, 'install.sh'), [], { PATH: `${sb.bin}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` });
    assert.match(r1.calls, /launchctl load .*com\.es\.mini-agent\.plist/, 'v1 reloads the agent mid-take (no busy guard)');
    assert.notEqual(fs.readFileSync(sb.plist, 'utf8'), sb.original, 'v1 rewrote the plist mid-take');

    fs.writeFileSync(sb.plist, sb.original, { mode: 0o600 });
    fs.writeFileSync(path.join(sb.stateDir, 'cwd'), sb.oldDir);
    fs.writeFileSync(path.join(sb.stateDir, 'loaded'), '');
    const before = treeHash(sb.home);
    const r2 = await sb.run(V2, ['--yes'], sb.v2env());
    assert.notEqual(r2.code, 0);
    assert.match(r2.out, /busy guard \(start\): the agent is RECORDING/);
    assert.equal(treeHash(sb.home), before, 'v2 wrote nothing');
    assert.doesNotMatch(r2.calls, /launchctl (un)?load/);
    noSecrets(r2.out);
  } finally { await sb.close(); }
});

test('(b) v2 refuses while paused, with uploads queued, with an active upload, or with watch copies pending', SKIP, async () => {
  const cases = [
    [{ paused: true }, /a take is PAUSED/],
    [{ uploads: { queued: 2, active: null, proxies_pending: 0 } }, /2 upload\(s\) still queued/],
    [{ uploads: { queued: 0, active: { file: 'cam1.mp4' }, proxies_pending: 0 } }, /an upload is in progress/],
    [{ uploads: { queued: 0, active: null, proxies_pending: 1 } }, /1 watch copies still being made/],
  ];
  for (const [patch, re] of cases) {
    const sb = await sandbox();
    try {
      Object.assign(sb.state, patch);
      const before = treeHash(sb.home);
      const r = await sb.run(V2, ['--yes'], sb.v2env());
      assert.notEqual(r.code, 0);
      assert.match(r.out, re);
      assert.equal(treeHash(sb.home), before);
      assert.doesNotMatch(r.calls, /launchctl (un)?load/);
    } finally { await sb.close(); }
  }
});

test('(b) v2 stops when a plist exists but the agent does not answer', SKIP, async () => {
  const sb = await sandbox();
  try {
    fs.rmSync(path.join(sb.stateDir, 'loaded'));
    const r = await sb.run(V2, ['--yes'], sb.v2env());
    assert.notEqual(r.code, 0);
    assert.match(r.out, /the agent does not answer/);
    assert.ok(!fs.existsSync(sb.newDir));
  } finally { await sb.close(); }
});

// ---------------------------------------------------------------- (c) hash

test('(c) fail-before: v1 standalone installs a tampered module from the raw URL; v2 refuses a hash mismatch', SKIP, async () => {
  const sb = await sandbox();
  try {
    // A "main" with a tampered server.js, served over file:// as REPO_RAW_BASE.
    const raw = path.join(sb.root, 'raw'); fs.mkdirSync(raw);
    const x = path.join(sb.root, 'x'); fs.mkdirSync(x);
    execFileSync('tar', ['-xf', pkg().tar, '-C', x]);
    const src = path.join(x, `es-mini-agent-${VERSION}-${C7}`);
    for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(raw, f));
    fs.appendFileSync(path.join(raw, 'server.js'), '\n// TAMPERED\n');
    const alone = path.join(sb.root, 'alone'); fs.mkdirSync(alone);
    const v1 = path.join(alone, 'install.sh'); fs.copyFileSync(v1Script(sb.root), v1);
    const r1 = await sb.run(v1, [], { REPO_RAW_BASE: `file://${raw}`, PATH: `${sb.bin}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` });
    assert.match(fs.readFileSync(path.join(sb.oldDir, 'server.js'), 'utf8'), /TAMPERED/, 'v1 installed the tampered file with no check');

    // v2 with the wrong expected hash.
    fs.writeFileSync(sb.plist, sb.original, { mode: 0o600 });
    fs.writeFileSync(path.join(sb.stateDir, 'cwd'), sb.oldDir);
    fs.writeFileSync(path.join(sb.stateDir, 'loaded'), '');
    const before = treeHash(sb.home);
    const r2 = await sb.run(V2, ['--yes'], sb.v2env({ ES_MINI_TAR_SHA256: '0'.repeat(64) }));
    assert.notEqual(r2.code, 0);
    assert.match(r2.out, /package SHA-256 MISMATCH/);
    assert.ok(!fs.existsSync(path.join(sb.home, 'es-mini-agent-runtimes')), 'no runtime folder');
    assert.equal(treeHash(sb.home), before);
    assert.deepEqual(fs.readdirSync(sb.tmp), [], 'temp work folder removed');
  } finally { await sb.close(); }
});

test('(c) v2 refuses when a file does not match the per-file sums, even with the right tar hash', SKIP, async () => {
  const sb = await sandbox();
  try {
    const bad = path.join(sb.root, `SHA256SUMS-files-${VERSION}.txt`);
    fs.writeFileSync(bad, fs.readFileSync(pkg().sums, 'utf8').replace(/^[0-9a-f]{64}(  server\.js)$/m, `${'1'.repeat(64)}$1`));
    const r = await sb.run(V2, ['--yes'], sb.v2env({ ES_MINI_SUMS: bad }));
    assert.notEqual(r.code, 0);
    assert.match(r.out, /server\.js: FAILED/);
    assert.match(r.out, /a file in the package does not match/);
    assert.ok(!fs.existsSync(sb.newDir));
  } finally { await sb.close(); }
});

test('(c) v2 refuses a release URL that points at a branch', SKIP, async () => {
  const sb = await sandbox();
  try {
    const r = await sb.run(V2, ['--yes'], { ...sb.v2env({ ES_MINI_RELEASE_URL: 'https://raw.githubusercontent.com/annabuies/es-mini-agent/main/' }), ES_MINI_TAR: '' });
    assert.notEqual(r.code, 0);
    assert.match(r.out, /must be a release, never a branch/);
    assert.doesNotMatch(r.calls, /curl https/);
  } finally { await sb.close(); }
});

// ---------------------------------------------------------------- happy path + report

test('v2 install: verified runtime outside ~/Documents, backup verified, full readback, names-only report', SKIP, async () => {
  const sb = await sandbox();
  try {
    const oldBefore = treeHash(sb.oldDir);
    const r = await sb.run(V2, ['--yes'], sb.v2env());
    assert.equal(r.code, 0, r.out);
    noSecrets(r.out);
    assert.match(r.out, /package SHA-256 matches/);
    assert.match(r.out, /all 29 files match SHA256SUMS-files-2026\.11\.05-1\.txt/);
    assert.match(r.out, /node --check passed for 23 modules/);
    assert.match(r.out, /busy guard \(start\): not recording, not paused, upload queue empty/);
    assert.match(r.out, /busy guard \(before swap\)/);
    assert.match(r.out, /BACKUP-VERIFIED/);
    assert.match(r.out, /SUCCESS: agent 2026\.11\.05-1/);
    assert.match(r.out, new RegExp(`agent: ${OLD_VERSION} -> ${VERSION}`));
    assert.match(r.out, new RegExp(`commit: ${COMMIT}`));
    assert.match(r.out, /plist fields changed: StandardErrorPath StandardOutPath WorkingDirectory/);
    assert.match(r.out, /env keys \(24\): AWS_ROLE_ARN BUILDING_ID .* WATCH_HW/);

    const top = topOf(sb.plist);
    assert.equal(top.WorkingDirectory, sb.newDir);
    assert.ok(!top.WorkingDirectory.includes('/Documents/'));
    assert.equal(top.StandardOutPath, sb.newDir + '/agent.log');
    assert.equal(top.ProgramArguments[0], process.execPath);
    assert.equal(fs.statSync(sb.plist).mode & 0o777, 0o600);
    assert.deepEqual(envOf(sb.plist), fixtureEnv(sb.port));

    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.newDir, 'update-state.json'), 'utf8')).commit, COMMIT);
    assert.ok(fs.existsSync(path.join(sb.newDir, '.cam-golden.json')), 'camera baseline carried over');
    assert.ok(!fs.existsSync(path.join(sb.newDir, '.r2-uploads')), 'queue state is not carried');
    assert.equal(treeHash(sb.oldDir), oldBefore, 'old runtime folder untouched');

    const bks = fs.readdirSync(sb.backups);
    assert.equal(bks.length, 1);
    const bk = path.join(sb.backups, bks[0]);
    assert.equal(fs.statSync(bk).mode & 0o777, 0o700);
    assert.equal(fs.statSync(sb.backups).mode & 0o777, 0o700);
    assert.equal(fs.readFileSync(path.join(bk, 'com.es.mini-agent.plist'), 'utf8'), sb.original);
    for (const f of ['plists.sha256', 'live.sha256', 'MANIFEST.txt', 'REPORT.txt', 'install.sh', 'com.es.obs-launcher.plist']) assert.ok(fs.existsSync(path.join(bk, f)), f);
    assert.ok(fs.existsSync(path.join(bk, 'runtime', 'server.js')));
    assert.ok(fs.existsSync(path.join(bk, 'obs-studio', 'basic', 'scenes', 'Studio.json')));
    assert.match(fs.readFileSync(path.join(bk, 'MANIFEST.txt'), 'utf8'), new RegExp(`^from_version=${OLD_VERSION}$`, 'm'));
    noSecrets(fs.readFileSync(path.join(bk, 'REPORT.txt'), 'utf8'));
    noSecrets(fs.readFileSync(path.join(bk, 'MANIFEST.txt'), 'utf8'));
    assert.deepEqual(fs.readdirSync(sb.tmp), [], 'temp work folder (holds plist JSON) removed');

    const loads = r.calls.split('\n').filter((l) => /launchctl (un)?load .*mini-agent/.test(l));
    assert.deepEqual(loads.map((l) => l.split(' ')[1]), ['unload', 'load']);
    assert.doesNotMatch(r.calls, /brew|curl https/);
  } finally { await sb.close(); }
});

test('v2 --set changes only the named key and reports only its name', SKIP, async () => {
  const sb = await sandbox();
  try {
    const r = await sb.run(V2, ['--yes', '--set', 'RTSP_CAPTURE=1', '--set=NEW_FLAG=on'], sb.v2env());
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /env keys changed \(names only\): RTSP_CAPTURE NEW_FLAG/);
    assert.deepEqual(envOf(sb.plist), { ...fixtureEnv(sb.port), RTSP_CAPTURE: '1', NEW_FLAG: 'on' });
  } finally { await sb.close(); }
});

// ---------------------------------------------------------------- (d) rollback

test('(d) fail-before: v1 keeps no backup and has no --rollback; v2 --rollback restores the plist byte for byte', SKIP, async () => {
  const sb = await sandbox();
  try {
    const v1 = v1Script(sb.root);
    const r0 = await sb.run(v1, ['--rollback'], {});
    assert.equal(r0.code, 2);
    assert.match(r0.out, /Unknown option: --rollback/);

    const r1 = await sb.run(V2, ['--yes'], sb.v2env());
    assert.equal(r1.code, 0, r1.out);
    assert.notEqual(fs.readFileSync(sb.plist, 'utf8'), sb.original);
    const r2 = await sb.run(V2, ['--rollback', '--yes'], {});
    assert.equal(r2.code, 0, r2.out);
    assert.match(r2.out, /ROLLED BACK/);
    assert.match(r2.out, new RegExp(`agent: ${OLD_VERSION}`));
    assert.equal(fs.readFileSync(sb.plist, 'utf8'), sb.original, 'byte for byte');
    assert.equal(fs.readFileSync(path.join(sb.stateDir, 'cwd'), 'utf8'), sb.oldDir);
    assert.ok(fs.existsSync(sb.newDir), 'new folder kept');
    noSecrets(r2.out);
  } finally { await sb.close(); }
});

test('(d) v2 --rollback refuses while recording', SKIP, async () => {
  const sb = await sandbox();
  try {
    assert.equal((await sb.run(V2, ['--yes'], sb.v2env())).code, 0);
    sb.state.recording = true;
    const before = fs.readFileSync(sb.plist, 'utf8');
    const r = await sb.run(V2, ['--rollback', '--yes'], {});
    assert.notEqual(r.code, 0);
    assert.match(r.out, /busy guard \(rollback\): the agent is RECORDING/);
    assert.equal(fs.readFileSync(sb.plist, 'utf8'), before);
  } finally { await sb.close(); }
});

test('v2 rolls back by itself when the new runtime crash-loops after the swap', SKIP, async () => {
  const sb = await sandbox();
  try {
    sb.state.crashDir = sb.newDir;
    const r = await sb.run(V2, ['--yes'], sb.v2env());
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /readback FAILED: agent did not answer \/health/);
    assert.match(r.out, /FAILURE, ROLLED BACK/);
    assert.equal(fs.readFileSync(sb.plist, 'utf8'), sb.original);
    assert.equal(fs.readFileSync(path.join(sb.stateDir, 'cwd'), 'utf8'), sb.oldDir);
    noSecrets(r.out);
  } finally { await sb.close(); }
});

test('v2 rolls back by itself when the relay refuses the key (401)', SKIP, async () => {
  const sb = await sandbox();
  try {
    fs.writeFileSync(path.join(sb.stateDir, 'relay-401'), '');
    const r = await sb.run(V2, ['--yes'], sb.v2env());
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /relay poll refused \(401\/403\)/);
    assert.equal(fs.readFileSync(sb.plist, 'utf8'), sb.original);
  } finally { await sb.close(); }
});

// ---------------------------------------------------------------- (e) idempotent, (f) dry run

test('(e) v2 re-run with the same version changes nothing', SKIP, async () => {
  const sb = await sandbox();
  try {
    assert.equal((await sb.run(V2, ['--yes'], sb.v2env())).code, 0);
    const plistBefore = fs.readFileSync(sb.plist, 'utf8');
    // The running agent may append to its own logs; everything else must stay identical.
    const quietLogs = () => { for (const f of ['agent.log', 'agent.error.log']) fs.writeFileSync(path.join(sb.newDir, f), ''); };
    quietLogs();
    const before = treeHash(sb.home);
    const r = await sb.run(V2, ['--yes'], sb.v2env());
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /ALREADY INSTALLED/);
    assert.doesNotMatch(r.calls, /launchctl (un)?load/);
    quietLogs();
    assert.equal(treeHash(sb.home), before);
    assert.equal(fs.readFileSync(sb.plist, 'utf8'), plistBefore);
    assert.equal(fs.readdirSync(sb.backups).length, 1, 'no second backup');
  } finally { await sb.close(); }
});

test('(f) v2 --dry-run verifies everything and writes nothing', SKIP, async () => {
  const sb = await sandbox();
  try {
    const before = treeHash(sb.home);
    const r = await sb.run(V2, ['--dry-run'], sb.v2env());
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /package SHA-256 matches/);
    assert.match(r.out, /new plist keeps all 24 env keys/);
    assert.match(r.out, /DRY RUN: nothing was written or restarted/);
    assert.equal(treeHash(sb.home), before);
    assert.doesNotMatch(r.calls, /launchctl (un)?load|brew/);
    assert.deepEqual(fs.readdirSync(sb.tmp), []);
    noSecrets(r.out);
  } finally { await sb.close(); }
});

// ---------------------------------------------------------------- TCC, fresh, download, local

test('v2 over SSH (old folder unreadable, macOS privacy): backs up the plist, records it, installs', SKIP, async () => {
  const sb = await sandbox({ unreadableOld: true });
  try {
    const r = await sb.run(V2, ['--yes'], sb.v2env());
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /old runtime backup: old runtime folder not readable/);
    assert.match(r.out, /\.cam-golden\.json not carried over/);
    const bk = path.join(sb.backups, fs.readdirSync(sb.backups)[0]);
    assert.equal(fs.readFileSync(path.join(bk, 'com.es.mini-agent.plist'), 'utf8'), sb.original);
    assert.ok(!fs.existsSync(path.join(bk, 'runtime')));
    // and rollback still works with the old folder unreadable
    const rb = await sb.run(V2, ['--rollback', '--yes'], {});
    assert.equal(rb.code, 0, rb.out);
    assert.equal(fs.readFileSync(sb.plist, 'utf8'), sb.original);
  } finally { await sb.close(); }
});

test('v2 fresh Mini: plist from ES_MINI_CONFIG (mode 600, read literally), refuses a readable config', SKIP, async () => {
  const sb = await sandbox({ fresh: true });
  try {
    const cfg = path.join(sb.root, 'mini.env');
    fs.writeFileSync(cfg, `# worksheet\nBUILDING_ID=fsu-1\nRECORD_CONTROL_KEY="${SECRETS.RECORD_CONTROL_KEY}"\nPORT=${sb.port}\nOBS_SOURCES=cam1,cam2\nS3_SECRET_ACCESS_KEY=${SECRETS.S3_SECRET_ACCESS_KEY}\n`, { mode: 0o644 });
    const r0 = await sb.run(V2, ['--yes'], sb.v2env({ ES_MINI_CONFIG: cfg }));
    assert.notEqual(r0.code, 0);
    assert.match(r0.out, /ES_MINI_CONFIG must be mode 600/);
    fs.chmodSync(cfg, 0o600);
    const r = await sb.run(V2, ['--yes'], sb.v2env({ ES_MINI_CONFIG: cfg }));
    assert.equal(r.code, 0, r.out);
    noSecrets(r.out);
    const env = envOf(sb.plist);
    assert.equal(env.RECORD_CONTROL_KEY, SECRETS.RECORD_CONTROL_KEY, 'quotes stripped, $ and backticks kept literally');
    assert.equal(env.BUILDING_ID, 'fsu-1');
    assert.equal(env.RECORD_POLL_URL, 'https://api.evrybdystudios.com');
    assert.equal(env.FFMPEG_BIN, path.join(sb.bin, 'ffmpeg'));
    const top = topOf(sb.plist);
    assert.equal(top.Label, 'com.es.mini-agent');
    assert.equal(top.KeepAlive, true);
    assert.equal(top.WorkingDirectory, sb.newDir);
    assert.match(r.out, /old runtime backup: none \(fresh install\)/);
  } finally { await sb.close(); }
});

test('v2 fresh Mini without BUILDING_ID / RECORD_CONTROL_KEY stops before writing', SKIP, async () => {
  const sb = await sandbox({ fresh: true });
  try {
    const before = treeHash(sb.home);
    const r = await sb.run(V2, ['--yes'], sb.v2env());
    assert.notEqual(r.code, 0);
    assert.match(r.out, /BUILDING_ID is empty in the new plist/);
    assert.equal(treeHash(sb.home), before);
  } finally { await sb.close(); }
});

test('v2 downloads the tar and sums from the release URL (file:// here) and verifies them', SKIP, async () => {
  const sb = await sandbox();
  try {
    const r = await sb.run(V2, ['--dry-run'], { ...sb.v2env({ ES_MINI_RELEASE_URL: `file://${pkg().dir}` }), ES_MINI_TAR: '' });
    assert.equal(r.code, 0, r.out);
    assert.match(r.calls, new RegExp(`curl file://${pkg().dir}/es-mini-agent-${VERSION}-${C7}\\.tar`));
    assert.match(r.calls, new RegExp(`curl file://${pkg().dir}/SHA256SUMS-files-${VERSION}\\.txt`));
    assert.match(r.out, /package SHA-256 matches/);
  } finally { await sb.close(); }
});

test('v2 --local (bench) packages HEAD itself and never touches the network', SKIP, async () => {
  const sb = await sandbox();
  try {
    const r = await sb.run(V2, ['--local', '--dry-run'], { PATH: `${sb.bin}:/usr/bin:/bin:/usr/sbin:/sbin` });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /--local is for Anna's bench only/);
    assert.match(r.out, /package SHA-256 matches/);
    assert.doesNotMatch(r.calls, /curl/);
  } finally { await sb.close(); }
});

test('v2 --obs-launcher installs the launcher from the new runtime into Application Support', SKIP, async () => {
  const sb = await sandbox();
  try {
    const r = await sb.run(V2, ['--yes', '--obs-launcher'], sb.v2env());
    assert.equal(r.code, 0, r.out);
    const la = fs.readFileSync(path.join(sb.home, 'Library', 'LaunchAgents', 'com.es.obs-launcher.plist'), 'utf8');
    const dir = path.join(sb.home, 'Library', 'Application Support', 'es-mini-agent');
    assert.ok(la.includes(`<string>${dir}/obs-launcher.sh</string>`));
    assert.doesNotMatch(la, /Documents|__LAUNCHER_DIR__/);
    assert.match(r.calls, /defaults write com\.apple\.loginwindow TALLogoutSavesState -bool false/);
  } finally { await sb.close(); }
});

test('v2 key rotation via ES_MINI_CONFIG: guards use the running key, readback uses the new one; neither is printed', SKIP, async () => {
  const sb = await sandbox();
  try {
    const NEWKEY = 'rotated-key-#2 & <z> $X';
    const cfg = path.join(sb.root, 'rotate.env');
    fs.writeFileSync(cfg, `RECORD_CONTROL_KEY='${NEWKEY}'\n`, { mode: 0o600 });
    const r = await sb.run(V2, ['--yes'], sb.v2env({ ES_MINI_CONFIG: cfg }));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /env keys changed \(names only\): RECORD_CONTROL_KEY/);
    assert.match(r.out, /readback: diag agent 2026\.11\.05-1/);
    assert.equal(envOf(sb.plist).RECORD_CONTROL_KEY, NEWKEY);
    assert.ok(!r.out.includes(NEWKEY) && !r.out.includes('rotated-key'), 'new key never printed');
    noSecrets(r.out);
  } finally { await sb.close(); }
});

test('v2 same-version --set on a hand-installed runtime (no update-state.json) succeeds and records the commit', SKIP, async () => {
  const sb = await sandbox();
  try {
    // What the manual S6 runbook leaves: the package extracted at the v2 path, plist pointing at it.
    fs.mkdirSync(path.dirname(sb.newDir), { recursive: true });
    const x = path.join(sb.root, 'hand'); fs.mkdirSync(x);
    execFileSync('tar', ['-xf', pkg().tar, '-C', x]);
    fs.renameSync(path.join(x, `es-mini-agent-${VERSION}-${C7}`), sb.newDir);
    const hand = plistXml({ env: fixtureEnv(sb.port), wd: sb.newDir, node: process.execPath });
    fs.writeFileSync(sb.plist, hand, { mode: 0o600 });
    fs.writeFileSync(path.join(sb.stateDir, 'loaded.plist'), hand);
    fs.writeFileSync(path.join(sb.stateDir, 'cwd'), sb.newDir);
    const r = await sb.run(V2, ['--yes', '--set', 'RTSP_CAPTURE=1'], sb.v2env());
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /running folder .* still matches the package/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.newDir, 'update-state.json'), 'utf8')).commit, COMMIT);
    assert.equal(envOf(sb.plist).RTSP_CAPTURE, '1');
  } finally { await sb.close(); }
});

test.after(() => { if (PKG) fs.rmSync(PKG.dir, { recursive: true, force: true }); });
