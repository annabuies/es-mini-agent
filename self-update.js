'use strict';

// Remote self-update for the studio Mini.
//
// The Mac this runs on is outbound-only: no SSH, no inbound port, no VPN. Before
// this module existed, shipping a code change meant a human standing at that
// keyboard pasting an installer command. This removes that permanently -- the
// agent pulls its own new code when explicitly told to.
//
// The whole design is built around one rule: a failed update must leave a
// working agent running. Every stage before `swap` is done against a staging
// copy, and the live files are not touched until a throwaway instance of the NEW
// code has actually booted and answered /health. That boot test is not
// belt-and-braces -- it is the only check that catches a missing module, which is
// the failure that has already bitten this agent once (shipped without
// aws-creds.js, crash-looped).

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const net = require('net');
const { execFile, spawn } = require('child_process');

const COMMITS_API = 'https://api.github.com/repos/annabuies/es-mini-agent/commits/main';
// A manifest is remote input. Constrain it to bare .js filenames so it can never
// name '../' paths or reach outside the project dir.
const MODULE_NAME_RE = /^[A-Za-z0-9._-]+\.js$/;
const BOOT_TEST_TIMEOUT_MS = 15000;
const BOOT_TEST_POLL_MS = 250;
const STDERR_KEEP_CHARS = 500;

function fail(stage, detail) {
  return { ok: false, updated: false, stage, detail: String(detail || '').slice(0, 600) };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Parse modules.txt: one filename per line, '#' comments and blank lines allowed.
function parseManifest(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

// Ask the OS for a port nobody is using by binding port 0 and reading back what
// we got. Guessing a "probably free" port would risk colliding with the live
// agent, which is the one process we must not disturb.
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function nodeCheck(execPath, file) {
  return new Promise((resolve) => {
    execFile(execPath, ['--check', file], { timeout: 20000 }, (err, _stdout, stderr) => {
      resolve({ ok: !err, stderr: String(stderr || (err && err.message) || '') });
    });
  });
}

async function readUpdateState(projectDir) {
  // A machine that has never self-updated has no state file. That is normal, not
  // an error -- callers get nulls and carry on.
  try {
    const raw = await fsp.readFile(path.join(projectDir, 'update-state.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : null;
  } catch (_) {
    return null;
  }
}

// The version block reported by the `diag` op. Lives here rather than in
// server.js because this module already owns update-state.json (and server.js
// deliberately has no fs import). A machine that has never self-updated must
// still return a version block, so every failure degrades to nulls.
function getVersionBlock({ projectDir, agentVersion }) {
  let commit = null;
  let updatedAt = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(projectDir, 'update-state.json'), 'utf8'));
    if (parsed && typeof parsed === 'object') {
      commit = parsed.commit || null;
      updatedAt = parsed.updatedAt || null;
    }
  } catch (_) { /* never updated, or unreadable -- nulls are the correct answer */ }
  return { agent: agentVersion || null, commit, updated_at: updatedAt };
}

// Best-effort version label. A missing commit sha must never block a working
// update, so every failure here degrades to null instead of failing a stage.
async function fetchHeadCommit() {
  try {
    const res = await fetch(COMMITS_API, {
      method: 'GET',
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'es-mini-agent',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const sha = data && data.sha;
    return (typeof sha === 'string' && sha) ? sha : null;
  } catch (_) {
    return null;
  }
}

async function rmrf(dir) {
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch (_) { /* best-effort cleanup; a leftover dir is recreated fresh next run */ }
}

// Boot the staged code as a throwaway process and require it to answer /health.
// The three env overrides below are each load-bearing:
//   PORT             -- a real PORT would collide with the live agent.
//   RECORD_POLL_URL  -- the real one would let this throwaway instance claim and
//                       execute a genuine record command out of the relay queue.
//   OBS_SOURCES      -- a non-empty value would have it reach into the live OBS.
// Running from a temp cwd is deliberate too: upload-queue.js derives its stateDir
// from __dirname, so a temp cwd means the test instance sees an empty upload
// queue instead of re-uploading real pending recordings.
async function bootTest(stagingDir, modules) {
  let tmpDir = null;
  let child = null;
  let stderr = '';
  try {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'es-mini-agent-boottest-'));
    for (const name of modules) {
      await fsp.copyFile(path.join(stagingDir, name), path.join(tmpDir, name));
    }

    const port = await findFreePort();
    const env = Object.assign({}, process.env, {
      PORT: String(port),
      RECORD_POLL_URL: 'http://127.0.0.1:9',
      OBS_SOURCES: '',
    });

    child = spawn(process.execPath, ['server.js'], {
      cwd: tmpDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => { /* drained so the pipe can never fill and stall the child */ });
    child.stderr.on('data', (chunk) => {
      // Keep the HEAD, not the tail. Node prints the actual cause first
      // ("Cannot find module './aws-creds'") and the generic loader stack after
      // it, so truncating from the end throws away the one line that tells you
      // which module is missing -- which is the entire reason we capture stderr.
      if (stderr.length < STDERR_KEEP_CHARS) {
        stderr = (stderr + String(chunk)).slice(0, STDERR_KEEP_CHARS);
      }
    });

    let exited = false;
    child.on('exit', () => { exited = true; });

    const deadline = Date.now() + BOOT_TEST_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exited) {
        return { ok: false, detail: `staged agent exited during boot test. stderr: ${stderr.trim() || '(empty)'}` };
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) {
          const body = await res.text();
          if (body.includes('"ok":true')) return { ok: true, port };
        }
      } catch (_) { /* not up yet -- keep polling until the deadline */ }
      await sleep(BOOT_TEST_POLL_MS);
    }
    return { ok: false, detail: `staged agent never answered /health in ${BOOT_TEST_TIMEOUT_MS}ms. stderr: ${stderr.trim() || '(empty)'}` };
  } catch (e) {
    return { ok: false, detail: `boot test error: ${(e && (e.message || e))}. stderr: ${stderr.trim() || '(empty)'}` };
  } finally {
    // Unconditional, including on the success path -- a surviving test process
    // would sit there holding a port and polling nothing.
    if (child && child.pid && !child.killed) {
      try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
    }
    if (tmpDir) await rmrf(tmpDir);
  }
}

async function runSelfUpdate({ projectDir, repoRawBase, busyReason }) {
  const stagingDir = path.join(projectDir, '.update-staging');
  const backupDir = path.join(projectDir, '.update-backup');

  try {
    // ---------- stage: busy ----------
    // Checked before any network call. Updating means restarting the process, and
    // doing that mid-recording or mid-upload would destroy a paying client's
    // session. Nothing else in this function matters if we are not allowed to go.
    try {
      const reason = typeof busyReason === 'function' ? busyReason() : null;
      if (reason) return fail('busy', reason);
    } catch (e) {
      return fail('busy', `busyReason threw: ${e && (e.message || e)}`);
    }

    // ---------- stage: manifest ----------
    let modules;
    try {
      const res = await fetch(`${repoRawBase}/modules.txt`, {
        method: 'GET',
        headers: { 'User-Agent': 'es-mini-agent' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return fail('manifest', `modules.txt fetch returned HTTP ${res.status}`);
      modules = parseManifest(await res.text());
    } catch (e) {
      return fail('manifest', `modules.txt fetch failed: ${e && (e.message || e)}`);
    }
    if (!modules.length) return fail('manifest', 'modules.txt parsed to an empty list');
    if (!modules.includes('server.js')) return fail('manifest', 'modules.txt does not list server.js');
    for (const name of modules) {
      if (!MODULE_NAME_RE.test(name)) return fail('manifest', `rejected manifest entry: ${name}`);
    }

    // ---------- stage: download ----------
    // Any single failure fails the whole stage. A partial set must never reach
    // the swap -- half-new, half-old code is the one state with no safe rollback.
    await rmrf(stagingDir);
    try {
      await fsp.mkdir(stagingDir, { recursive: true });
    } catch (e) {
      return fail('download', `could not create staging dir: ${e && (e.message || e)}`);
    }
    for (const name of modules) {
      try {
        const res = await fetch(`${repoRawBase}/${name}`, {
          method: 'GET',
          headers: { 'User-Agent': 'es-mini-agent' },
          signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) {
          await rmrf(stagingDir);
          return fail('download', `${name}: HTTP ${res.status}`);
        }
        const body = await res.text();
        if (!body) {
          await rmrf(stagingDir);
          return fail('download', `${name}: empty body`);
        }
        await fsp.writeFile(path.join(stagingDir, name), body, 'utf8');
      } catch (e) {
        await rmrf(stagingDir);
        return fail('download', `${name}: ${e && (e.message || e)}`);
      }
    }

    // ---------- stage: syntax ----------
    for (const name of modules) {
      const res = await nodeCheck(process.execPath, path.join(stagingDir, name));
      if (!res.ok) {
        await rmrf(stagingDir);
        return fail('syntax', `${name} does not parse: ${res.stderr.trim().slice(0, 300)}`);
      }
    }

    // ---------- stage: boottest ----------
    const boot = await bootTest(stagingDir, modules);
    if (!boot.ok) {
      await rmrf(stagingDir);
      return fail('boottest', boot.detail);
    }

    // ---------- stage: swap ----------
    // First point at which live files are touched. Everything above this line is
    // reversible by simply deleting the staging dir.
    const previousState = await readUpdateState(projectDir);
    const previousCommit = (previousState && previousState.commit) || null;

    await rmrf(backupDir);
    try {
      await fsp.mkdir(backupDir, { recursive: true });
    } catch (e) {
      await rmrf(stagingDir);
      return fail('swap', `could not create backup dir: ${e && (e.message || e)}`);
    }

    const backedUp = [];
    try {
      for (const name of modules) {
        const live = path.join(projectDir, name);
        if (fs.existsSync(live)) {
          await fsp.copyFile(live, path.join(backupDir, name));
          backedUp.push(name);
        }
      }
      for (const name of modules) {
        await fsp.copyFile(path.join(stagingDir, name), path.join(projectDir, name));
      }
    } catch (e) {
      // Partway through the swap: put every file we backed up back, so the agent
      // restarts on the code it was already running rather than a mixed set.
      let restoreError = null;
      for (const name of backedUp) {
        try {
          await fsp.copyFile(path.join(backupDir, name), path.join(projectDir, name));
        } catch (re) {
          restoreError = re;
        }
      }
      await rmrf(stagingDir);
      const detail = `${e && (e.message || e)}` + (restoreError ? ` (ROLLBACK ALSO FAILED: ${restoreError.message || restoreError})` : '');
      return fail('swap_rolled_back', detail);
    }

    await rmrf(stagingDir);

    const commit = await fetchHeadCommit();
    const updatedAt = new Date().toISOString();
    try {
      await fsp.writeFile(
        path.join(projectDir, 'update-state.json'),
        JSON.stringify({ commit, previousCommit, updatedAt, modules }, null, 2) + '\n',
        'utf8'
      );
    } catch (e) {
      // The code is already swapped and boot-tested at this point. A missing
      // state file costs us the version label, not the update.
      console.warn('[self-update] could not write update-state.json:', e && (e.message || e));
    }

    console.log(`[self-update] swapped ${modules.length} module(s) to ${commit || 'unknown commit'}; restart pending`);
    return { ok: true, updated: true, commit, previousCommit, modules, restarting: true };
  } catch (e) {
    // This function is called from an HTTP handler on a machine nobody can SSH
    // into. It must always return a readable object rather than throw.
    await rmrf(stagingDir);
    return fail('unexpected', `${e && (e.stack || e.message || e)}`);
  }
}

module.exports = { runSelfUpdate, getVersionBlock };
