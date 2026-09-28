'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createUploadQueue } = require('../upload-queue');

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out');
}

function webhookServer(t) {
  const posts = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { posts.push(JSON.parse(raw)); res.end('{}'); });
  });
  t.after(() => server.close());
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ posts, url: `http://127.0.0.1:${server.address().port}/hook` })));
}

test('a 0-byte camera file is never uploaded: it is reported as sizeBytes 0 and dropped', { timeout: 8000 }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-empty-cam-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const hook = await webhookServer(t);
  const filePath = path.join(tempDir, 'cam2-take.mkv');
  fs.writeFileSync(filePath, '');
  const stateDir = path.join(tempDir, 'state');
  const uploads = [];
  const queue = createUploadQueue({
    stateDir, buildingId: 'bench-1', stabilityPollMs: 5, webhookUrl: hook.url,
    uploader: async (input) => { uploads.push(input); return { key: input.key, sizeBytes: input.sizeBytes }; },
  });
  queue.enqueue({ filePath, source: 'cam2', sessionRef: 'sess-1' });
  const stateFiles = () => (fs.existsSync(stateDir) ? fs.readdirSync(stateDir).filter((f) => f.endsWith('.state.json')) : []);
  await waitFor(() => hook.posts.length === 1 && queue.status().active === null && queue.status().queued === 0 && stateFiles().length === 0, 6000);
  assert.equal(uploads.length, 0);
  assert.deepEqual(
    { event: hook.posts[0].event, sizeBytes: hook.posts[0].sizeBytes, source: hook.posts[0].source, building_id: hook.posts[0].building_id, session_ref: hook.posts[0].session_ref },
    { event: 'upload_confirmed', sizeBytes: 0, source: 'cam2', building_id: 'bench-1', session_ref: 'sess-1' },
  );
  assert.deepEqual(stateFiles(), []);
});

test('a 0-byte master file is dropped without a webhook', { timeout: 8000 }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-empty-master-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const hook = await webhookServer(t);
  const filePath = path.join(tempDir, 'master-take.mp4');
  fs.writeFileSync(filePath, '');
  const stateDir = path.join(tempDir, 'state');
  const queue = createUploadQueue({ stateDir, buildingId: 'bench-1', stabilityPollMs: 5, webhookUrl: hook.url, uploader: async () => { throw new Error('must not upload'); } });
  queue.enqueue({ filePath, source: 'master' });
  const stateFiles = () => (fs.existsSync(stateDir) ? fs.readdirSync(stateDir) : []);
  await waitFor(() => queue.status().active === null && queue.status().queued === 0, 6000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(stateFiles(), []);
  assert.equal(hook.posts.length, 0);
});

test('sweep drops upload states left behind by the old "requires sizeBytes" failure, keeps other errors', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-empty-sweep-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const stateDir = path.join(tempDir, 'state');
  fs.mkdirSync(stateDir);
  const write = (name, error) => fs.writeFileSync(path.join(stateDir, name), JSON.stringify({ version: 1, key: name, status: 'error', error }));
  write('sep7-cam1.state.json', 'runMultipartUpload requires sizeBytes');
  write('other.state.json', 'HeadObject verification failed status=403');
  const queue = createUploadQueue({ stateDir, buildingId: 'bench-1', uploader: async () => { throw new Error('must not upload'); } });
  await queue.sweep();
  assert.deepEqual(fs.readdirSync(stateDir), ['other.state.json']);
});
