'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { executeLook } = require('../ptz');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function main() {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'bench-1-ptz.json'), 'utf8'));
  const cameraServer = http.createServer((req, res) => {
    const preset = Number((req.url.match(/&([0-9]+)$/) || [])[1]);
    if (preset === 2) {
      setTimeout(() => { if (!res.destroyed) res.end(); }, 150).unref();
      return;
    }
    res.writeHead(204);
    res.end();
  });
  const port = await listen(cameraServer);
  const host = `127.0.0.1:${port}`;
  fixture.cameras = fixture.cameras.map((camera) => ({ name: camera.name, host }));

  const outputs = [];
  outputs.push({
    case: 'no_cameras',
    result: await executeLook({ ...fixture, cameras: [], recording: false, paused: false }, '2', { timeoutMs: 40 }),
  });
  outputs.push({
    case: 'unknown_look',
    result: await executeLook({ ...fixture, recording: false, paused: false }, '9', { timeoutMs: 40 }),
  });
  outputs.push({
    case: 'per_camera',
    result: await executeLook({ ...fixture, recording: false, paused: false }, '3', { timeoutMs: 40 }),
  });

  await new Promise((resolve) => cameraServer.close(resolve));
  process.stdout.write(JSON.stringify({ mode: 'demo_fixture', building_id: fixture.building_id, outputs }, null, 2) + '\n');
}

main().catch((error) => {
  console.error(error && (error.stack || error));
  process.exitCode = 1;
});
