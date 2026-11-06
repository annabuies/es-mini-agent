'use strict';

// A1: the release package is reproducible from the repo, not from a wiki worktree.
// scripts/build-mini-package.sh for 20230f2 / 2026.11.05-1 must give the exact
// tar the 2026-11-05 runbook built: a62d02a7…c802 (29 files, 23 modules).

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const projectDir = path.resolve(__dirname, '..');
const script = path.join(projectDir, 'scripts', 'build-mini-package.sh');
const REPO = process.env.ES_MINI_PKG_REPO || projectDir;
const COMMIT = '20230f20fdd3345451e947e907b26455daed787b';
const VERSION = '2026.11.05-1';
const TAR_SHA = 'a62d02a7d2d1a1c24f61383f5361a42f1a7a22c87da969af4f09addf8ab3c802';
const SUMS_SHA = '3151edbaeb9589ebfaf5fc0ba2c0267ec6b96abac2c46e133f4765564be2141a';

const hasCommit = spawnSync('git', ['-C', REPO, 'cat-file', '-e', `${COMMIT}^{commit}`]).status === 0;
const SKIP = { skip: !hasCommit && `commit ${COMMIT.slice(0, 7)} not in ${REPO}` };

function sha(file) {
  return require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('package script passes bash 3.2 syntax check', () => {
  const r = spawnSync('/bin/bash', ['-n', script]);
  assert.equal(r.status, 0, r.stderr.toString());
});

test('package for 20230f2 / 2026.11.05-1 reproduces the 2026-11-05 tar byte for byte', SKIP, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-pkg-'));
  try {
    const r = spawnSync('/bin/bash', [script, REPO, out, '20230f2', VERSION]);
    assert.equal(r.status, 0, r.stderr.toString());
    assert.match(r.stdout.toString(), /^files=29 modules=23$/m);
    const tar = path.join(out, `es-mini-agent-${VERSION}-20230f2.tar`);
    assert.equal(sha(tar), TAR_SHA);
    assert.equal(sha(path.join(out, `SHA256SUMS-files-${VERSION}.txt`)), SUMS_SHA);
    assert.equal(fs.readFileSync(path.join(out, 'SHA256SUMS-archive.txt'), 'utf8'),
      `${TAR_SHA}  es-mini-agent-${VERSION}-20230f2.tar\n`);
    const rel = fs.readFileSync(path.join(out, 'RELEASE.txt'), 'utf8');
    assert.match(rel, new RegExp(`^version=${VERSION.replace(/\./g, '\\.')}$`, 'm'));
    assert.match(rel, new RegExp(`^commit=${COMMIT}$`, 'm'));
    assert.match(rel, new RegExp(`^tar_sha256=${TAR_SHA}$`, 'm'));
    assert.match(rel, /^files=29$/m);
    assert.match(rel, /^built_at=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/m);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('package script refuses a version that does not match the commit', SKIP, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-pkg-'));
  try {
    const r = spawnSync('/bin/bash', [script, REPO, out, '20230f2', '2026.11.02-1']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr.toString(), /package\.json version at 20230f2 is '2026\.11\.05-1', not '2026\.11\.02-1'/);
    assert.deepEqual(fs.readdirSync(out), []);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
