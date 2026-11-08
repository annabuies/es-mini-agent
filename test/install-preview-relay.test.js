'use strict';

// scripts/install-preview-relay.sh end to end in a sandbox: fake HOME (with a space in
// the path), PATH shims for launchctl and dscacheutil, and a fake MediaMTX binary (node)
// packed in a tar.gz that answers the control API and serves TLS with the room
// certificate. Every run uses /bin/bash (3.2 on macOS). Nothing here touches the real
// launchd, LaunchAgents or network beyond 127.0.0.1.

const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const projectDir = path.resolve(__dirname, '..');
const SCRIPT = path.join(projectDir, 'scripts', 'install-preview-relay.sh');
const HOST = 'preview-bench1.evrybdystudios.com';
const ROOM = 'bench-1';
const LABEL = 'com.es.preview-relay';
const onMac = process.platform === 'darwin';
const SKIP = { skip: !onMac && 'needs macOS (plutil, PlistBuddy, LibreSSL layout)' };

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// Fake mediamtx: reads its yml, serves /v3/info + /v3/config/paths/get/<room> on the API
// address and HTTPS on the WebRTC address. MODE=fail exits at once (a broken binary).
function fakeBinary(mode) {
  return `#!/usr/bin/env node
'use strict';
if (${JSON.stringify(mode)} === 'fail') { console.error('fake relay: refusing to start'); process.exit(1); }
const fs = require('fs'), http = require('http'), https = require('https');
const y = fs.readFileSync(process.argv[2], 'utf8');
const get = (k) => { const m = y.match(new RegExp('^' + k + ': (.*)$', 'm')); return m ? m[1].trim() : ''; };
const api = get('apiAddress').split(':');
const web = Number(get('webrtcAddress').replace(':', ''));
const room = (y.match(/^paths:\\n  ([^:]+):/m) || [])[1];
http.createServer((q, r) => {
  if (q.url === '/v3/info') { r.end(JSON.stringify({ version: ${JSON.stringify(mode === 'oldver' ? 'v1.0.0' : 'v1.21.3')} })); return; }
  if (q.url === '/v3/config/paths/get/' + room) { r.end('{}'); return; }
  r.statusCode = 404; r.end();
}).listen(Number(api[1]), api[0]);
https.createServer({ key: fs.readFileSync(get('webrtcServerKey')), cert: fs.readFileSync(get('webrtcServerCert')) },
  (q, r) => { r.statusCode = 404; r.end(); }).listen(web, '127.0.0.1');
console.log('fake relay up');
`;
}

function makeTar(dir, name, mode, extra) {
  const src = path.join(dir, `src-${name}`);
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'mediamtx'), fakeBinary(mode), { mode: 0o755 });
  fs.writeFileSync(path.join(src, 'LICENSE'), 'MIT');
  const tar = path.join(dir, `${name}.tar.gz`);
  execFileSync('tar', ['-czf', tar, '-C', src, 'mediamtx', 'LICENSE', ...(extra || [])]);
  return tar;
}

function makeCert(dir, host, days, name) {
  const key = path.join(dir, `${name}.key`), crt = path.join(dir, `${name}.crt`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-days', String(days), '-subj', `/CN=${host}`, '-addext', `subjectAltName=DNS:${host}`, '-keyout', key, '-out', crt],
  { stdio: 'ignore' });
  return { key, crt };
}

function shims(bin, state) {
  fs.mkdirSync(bin, { recursive: true });
  // launchctl: print gui/<uid> ok; print gui/<uid>/<label> shows the pid while alive;
  // bootstrap runs ProgramArguments in the background; bootout kills it.
  fs.writeFileSync(path.join(bin, 'launchctl'), `#!/bin/bash
S=${JSON.stringify(state)}
pidf="$S/relay.pid"
alive() { [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null; }
echo "$*" >> "$S/launchctl.log"
case "$1" in
  print)
    case "$2" in */${LABEL}) alive && { echo "${LABEL} = {"; echo "	pid = $(cat "$pidf")"; echo "}"; exit 0; }; exit 113 ;;
                 *) exit 0 ;; esac ;;
  bootstrap)
    b0="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$3")"
    b1="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:1' "$3")"
    log="$(/usr/libexec/PlistBuddy -c 'Print :StandardOutPath' "$3")"
    nohup "$b0" "$b1" >> "$log" 2>&1 &
    echo $! > "$pidf"; sleep 0.3; exit 0 ;;
  bootout)
    alive && kill "$(cat "$pidf")" 2>/dev/null; rm -f "$pidf"; sleep 0.2; exit 0 ;;
esac
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'dscacheutil'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
}

async function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'es-relay-test-'));
  const home = path.join(root, 'home dir');
  const state = path.join(root, 'state');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(state);
  shims(bin, state);
  const ports = { api: await freePort(), web: await freePort(), ice: await freePort() };
  const good = makeTar(root, 'good', 'ok');
  const cert = makeCert(root, HOST, 30, 'room');
  const sb = {
    root, home, state, ports, good, cert,
    appDir: path.join(home, 'Library', 'Application Support', 'es-preview-relay'),
    plist: path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
    inbox: path.join(home, 'es-preview-certs-inbox'),
    putInbox(c = cert) {
      fs.mkdirSync(this.inbox, { recursive: true });
      fs.copyFileSync(c.crt, path.join(this.inbox, `${HOST}.crt`));
      fs.copyFileSync(c.key, path.join(this.inbox, `${HOST}.key`));
    },
    run(args = [], env = {}) {
      const r = spawnSync('/bin/bash', [SCRIPT, ...args], {
        encoding: 'utf8', timeout: 60000,
        env: {
          PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin:${path.dirname(process.execPath)}`,
          HOME: home, TMPDIR: root, ES_RELAY_TEST: '1',
          ES_RELAY_API_PORT: String(ports.api), ES_RELAY_WEBRTC_PORT: String(ports.web), ES_RELAY_ICE_PORT: String(ports.ice),
          ES_RELAY_CACERT: cert.crt, ES_RELAY_TAR: good, ES_RELAY_TAR_SHA: sha(good), ES_RELAY_READBACK_TIMEOUT: '8',
          ...env,
        },
      });
      return { code: r.status, out: `${r.stdout}${r.stderr}` };
    },
  };
  t.after(() => {
    spawnSync('/bin/bash', ['-c', `p="${state}/relay.pid"; [ -f "$p" ] && kill "$(cat "$p")" 2>/dev/null; true`]);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return sb;
}

test('bash 3.2 parses the installer', SKIP, () => {
  const r = spawnSync('/bin/bash', ['-n', SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('pinned MediaMTX tar is v1.21.3 darwin_arm64 with the release SHA-256', () => {
  const s = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(s, /^RELAY_VERSION="v1\.21\.3"$/m);
  assert.match(s, /^TAR_SHA256="bc1a0762fd18ffb413bcd81dcb9a072ac159fbd1f27e79ac6f14598aaac5ed3f"$/m);
  assert.match(s, /mediamtx_\$\{RELAY_VERSION\}_darwin_arm64\.tar\.gz/);
  // test hooks only behind ES_RELAY_TEST=1
  const hookLine = s.split('\n').findIndex((l) => l.includes('ES_RELAY_TAR_SHA'));
  const guardLine = s.split('\n').findIndex((l) => l.includes('if [ "${ES_RELAY_TEST:-}" = "1" ]'));
  assert.ok(guardLine > 0 && hookLine > guardLine);
});

test('fresh install: relay running, files rendered, key 600, inbox emptied, report SUCCESS', SKIP, async (t) => {
  const sb = await sandbox(t);
  sb.putInbox();
  const r = sb.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /===== ES PREVIEW RELAY INSTALL REPORT =====\nresult: SUCCESS/);
  assert.match(r.out, /backup: none \(first install\)/);
  assert.match(r.out, /local preview switch: unchanged/);
  const yml = fs.readFileSync(path.join(sb.appDir, 'mediamtx.yml'), 'utf8');
  assert.doesNotMatch(yml, /__[A-Z_]+__/);
  assert.match(yml, new RegExp(`^apiAddress: 127\\.0\\.0\\.1:${sb.ports.api}$`, 'm'));
  assert.match(yml, /^authHTTPAddress: https:\/\/api\.evrybdystudios\.com\/api\/preview-auth$/m);
  assert.match(yml, /^paths:\n {2}bench-1:\n {4}source: publisher/m);
  assert.ok(yml.includes(`webrtcServerKey: ${sb.appDir}/certs/certificates/${HOST}.key`));
  const st = fs.statSync(path.join(sb.appDir, 'certs', 'certificates', `${HOST}.key`));
  assert.equal(st.mode & 0o777, 0o600);
  execFileSync('plutil', ['-lint', sb.plist]);
  const pl = fs.readFileSync(sb.plist, 'utf8');
  assert.doesNotMatch(pl, /__APP_DIR__|__HOME__/);
  assert.ok(pl.includes(`<string>${sb.appDir}/mediamtx</string>`));
  assert.ok(!fs.existsSync(path.join(sb.inbox, `${HOST}.key`)), 'inbox key removed after success');
  assert.match(fs.readFileSync(path.join(sb.state, 'launchctl.log'), 'utf8'), /bootstrap gui\/\d+ /);
  // DNS shim resolves nothing: a warning, not a failure
  assert.match(r.out, /warnings: dns: .* does not resolve/);
});

test('--status reads back a running relay and changes nothing', SKIP, async (t) => {
  const sb = await sandbox(t);
  sb.putInbox();
  assert.equal(sb.run().code, 0);
  const before = fs.readFileSync(sb.plist, 'utf8');
  const r = sb.run(['--status']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /launchd: loaded, pid \d+/);
  assert.match(r.out, /api 127\.0\.0\.1:\d+: v1\.21\.3/);
  assert.match(r.out, /room path: bench-1 configured/);
  assert.match(r.out, /TLS ok for preview-bench1/);
  assert.equal(fs.readFileSync(sb.plist, 'utf8'), before);
});

test('re-run reuses the installed certificate and backs up the previous install', SKIP, async (t) => {
  const sb = await sandbox(t);
  sb.putInbox();
  assert.equal(sb.run().code, 0);
  const r = sb.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /certificate \(installed\)/);
  assert.match(r.out, /backup: .*es-backups\/preview-relay-/);
});

test('SHA-256 mismatch stops before anything is written', SKIP, async (t) => {
  const sb = await sandbox(t);
  sb.putInbox();
  const r = sb.run([], { ES_RELAY_TAR_SHA: '0'.repeat(64) });
  assert.equal(r.code, 1);
  assert.match(r.out, /SHA-256 mismatch/);
  assert.match(r.out, /STOPPED: nothing was changed/);
  assert.ok(!fs.existsSync(sb.appDir));
  assert.ok(!fs.existsSync(sb.plist));
  assert.ok(fs.existsSync(path.join(sb.inbox, `${HOST}.key`)), 'inbox untouched');
});

test('certificate for another host, expiring, or with the wrong key is refused', SKIP, async (t) => {
  const sb = await sandbox(t);
  const other = makeCert(sb.root, 'preview-other.example.com', 30, 'other');
  sb.putInbox(other);
  let r = sb.run();
  assert.equal(r.code, 1); assert.match(r.out, /not issued for preview-bench1/);

  const soon = makeCert(sb.root, HOST, 3, 'soon');
  sb.putInbox(soon);
  r = sb.run();
  assert.equal(r.code, 1); assert.match(r.out, /expires within 7 days/);

  sb.putInbox();
  fs.copyFileSync(other.key, path.join(sb.inbox, `${HOST}.key`));
  r = sb.run();
  assert.equal(r.code, 1); assert.match(r.out, /key does not belong/);
  assert.ok(!fs.existsSync(sb.plist));
});

test('no certificate: clear stop, nothing written', SKIP, async (t) => {
  const sb = await sandbox(t);
  const r = sb.run();
  assert.equal(r.code, 1);
  assert.match(r.out, /certificate: none found/);
  assert.ok(!fs.existsSync(sb.appDir));
});

test('a tar without a top-level mediamtx binary is refused', SKIP, async (t) => {
  const sb = await sandbox(t);
  sb.putInbox();
  const src = path.join(sb.root, 'evil'); fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(src, 'sub', 'mediamtx'), 'x');
  const tar = path.join(sb.root, 'evil.tar.gz');
  execFileSync('tar', ['-czf', tar, '-C', src, 'sub']);
  const r = sb.run([], { ES_RELAY_TAR: tar, ES_RELAY_TAR_SHA: sha(tar) });
  assert.equal(r.code, 1);
  assert.match(r.out, /no top-level mediamtx/);
  assert.ok(!fs.existsSync(sb.appDir));
});

test('failed readback on an update puts the previous relay back', SKIP, async (t) => {
  const sb = await sandbox(t);
  sb.putInbox();
  assert.equal(sb.run().code, 0);
  const bad = makeTar(sb.root, 'bad', 'fail');
  const r = sb.run([], { ES_RELAY_TAR: bad, ES_RELAY_TAR_SHA: sha(bad) });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /result: FAILED, rolled back/);
  assert.match(r.out, /rollback: previous relay restored/);
  const s = sb.run(['--status']);
  assert.match(s.out, /api 127\.0\.0\.1:\d+: v1\.21\.3/);
  assert.match(fs.readFileSync(path.join(sb.appDir, 'mediamtx'), 'utf8'), /fake relay up/);
});

test('failed readback on a first install leaves nothing behind', SKIP, async (t) => {
  const sb = await sandbox(t);
  sb.putInbox();
  const bad = makeTar(sb.root, 'old', 'oldver');
  const r = sb.run([], { ES_RELAY_TAR: bad, ES_RELAY_TAR_SHA: sha(bad) });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /did not report v1\.21\.3/);
  assert.match(r.out, /rollback: no previous relay/);
  assert.ok(!fs.existsSync(sb.plist));
  assert.ok(!fs.existsSync(sb.appDir));
  assert.ok(fs.existsSync(path.join(sb.inbox, `${HOST}.key`)), 'inbox kept for the next try');
});

test('--dry-run checks and stages but installs nothing', SKIP, async (t) => {
  const sb = await sandbox(t);
  sb.putInbox();
  const r = sb.run(['--dry-run']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /result: READY \(nothing installed\)/);
  assert.ok(!fs.existsSync(sb.appDir));
  assert.ok(!fs.existsSync(sb.plist));
  assert.ok(!fs.existsSync(path.join(sb.state, 'launchctl.log')) ||
    !/bootstrap/.test(fs.readFileSync(path.join(sb.state, 'launchctl.log'), 'utf8')));
});

test('--uninstall stops the relay and moves its files to a backup', SKIP, async (t) => {
  const sb = await sandbox(t);
  sb.putInbox();
  assert.equal(sb.run().code, 0);
  const r = sb.run(['--uninstall']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /result: REMOVED/);
  assert.ok(!fs.existsSync(sb.plist));
  assert.ok(!fs.existsSync(sb.appDir));
  const bk = fs.readdirSync(path.join(sb.home, 'es-backups')).find((d) => d.startsWith('preview-relay-'));
  assert.ok(fs.existsSync(path.join(sb.home, 'es-backups', bk, 'app', 'mediamtx')));
  assert.match(sb.run(['--status']).out, /launchd: not loaded/);
});

test('a port held by another program stops the install', SKIP, async (t) => {
  const sb = await sandbox(t);
  sb.putInbox();
  const srv = net.createServer().listen(sb.ports.web, '127.0.0.1');
  t.after(() => srv.close());
  await new Promise((r) => srv.once('listening', r));
  // lsof sees our own listener: run the installer in a child so node's event loop keeps serving
  const r = await new Promise((resolve) => {
    const { spawn } = require('node:child_process');
    const env = {
      PATH: `${path.join(sb.root, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: sb.home, TMPDIR: sb.root, ES_RELAY_TEST: '1',
      ES_RELAY_API_PORT: String(sb.ports.api), ES_RELAY_WEBRTC_PORT: String(sb.ports.web), ES_RELAY_ICE_PORT: String(sb.ports.ice),
      ES_RELAY_TAR: sb.good, ES_RELAY_TAR_SHA: sha(sb.good),
    };
    const c = spawn('/bin/bash', [SCRIPT], { env }); let out = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out }));
  });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /already used by another program/);
  assert.ok(!fs.existsSync(sb.appDir));
});

test('output never contains the private key', SKIP, async (t) => {
  const sb = await sandbox(t);
  sb.putInbox();
  const keyBody = fs.readFileSync(sb.cert.key, 'utf8').split('\n').filter((l) => l && !l.startsWith('-----'));
  const r = sb.run();
  for (const l of keyBody) assert.ok(!r.out.includes(l));
  assert.doesNotMatch(r.out, /PRIVATE KEY/);
});
