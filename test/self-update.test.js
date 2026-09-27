'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runSelfUpdate } = require('../self-update');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('self-update stages storage-upload, boots it, and leaves the old upload module untouched', async () => {
  const sourceDir = path.resolve(__dirname, '..');
  const manifest = await fs.readFile(path.join(sourceDir, 'modules.txt'), 'utf8');
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'es-mini-agent-update-test-'));
  const oldUploadModuleName = ['r2', 'upload.js'].join('-');
  const staleModule = path.join(projectDir, oldUploadModuleName);
  const staleContents = '// old upload module intentionally retained after update\n';
  let server;
  const originalFetch = global.fetch;
  const originalRecordControlKey = process.env.RECORD_CONTROL_KEY;
  const originalBuildingId = process.env.BUILDING_ID;

  try {
    process.env.RECORD_CONTROL_KEY = 'self-update-test-key';
    process.env.BUILDING_ID = 'self-update-test';
    await fs.writeFile(staleModule, staleContents, 'utf8');
    server = http.createServer(async (req, res) => {
      const name = decodeURIComponent((req.url || '/').slice(1));
      try {
        const body = name === 'modules.txt'
          ? manifest
          : await fs.readFile(path.join(sourceDir, name), 'utf8');
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(body);
      } catch (_) {
        res.writeHead(404);
        res.end('not found');
      }
    });
    const port = await listen(server);

    global.fetch = (url, options) => {
      if (String(url).startsWith('https://api.github.com/repos/annabuies/es-mini-agent/commits/main')) {
        return Promise.resolve(new Response(JSON.stringify({ sha: 'update-test-sha' }), { status: 200 }));
      }
      return originalFetch(url, options);
    };

    const result = await runSelfUpdate({
      projectDir,
      repoRawBase: `http://127.0.0.1:${port}`,
      busyReason: () => null,
    });

    assert.equal(result.ok, true, result.detail);
    assert.equal(result.updated, true);
    assert.ok(result.modules.includes('storage-upload.js'));
    assert.ok(result.modules.includes('disk-usage.js'));
    assert.equal(result.modules.includes(oldUploadModuleName), false);
    assert.equal(await fs.readFile(staleModule, 'utf8'), staleContents);
    assert.equal(
      await fs.readFile(path.join(projectDir, 'storage-upload.js'), 'utf8'),
      await fs.readFile(path.join(sourceDir, 'storage-upload.js'), 'utf8')
    );
    assert.equal(
      await fs.readFile(path.join(projectDir, 'disk-usage.js'), 'utf8'),
      await fs.readFile(path.join(sourceDir, 'disk-usage.js'), 'utf8')
    );
  } finally {
    global.fetch = originalFetch;
    if (originalRecordControlKey === undefined) delete process.env.RECORD_CONTROL_KEY;
    else process.env.RECORD_CONTROL_KEY = originalRecordControlKey;
    if (originalBuildingId === undefined) delete process.env.BUILDING_ID;
    else process.env.BUILDING_ID = originalBuildingId;
    if (server) await close(server);
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});
