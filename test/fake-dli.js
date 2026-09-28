'use strict';

// A fake Digital Loggers PowerSwitch Pro REST API, modelled on restapi.pdf:
// digest auth on every request, zero-based relays, 207 for `all;` selectors,
// and modifying requests rejected unless they carry an X-CSRF header.

const http = require('node:http');
const { buildAuthorization, parseChallenge } = require('../digest-auth');

function createFakeDli({ username = 'fake-admin', password = 'fake-pass' } = {}) {
  const challengeHeader = 'Digest realm="fake-dli", nonce="fake-nonce", qop="auth", algorithm=MD5';
  const strip = {
    states: [true, true, true, true, false, false, false, false],
    names: ['Router', 'PoE', 'Mini', 'Lights', 'Outlet 5', 'Outlet 6', 'Outlet 7', 'Outlet 8'],
    requests: [],
    writes: [],
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const cnonce = req.headers.authorization && /cnonce="([^"]+)"/.exec(req.headers.authorization)?.[1];
      const expected = buildAuthorization({
        method: req.method, uri: req.url, username, password,
        challenge: parseChallenge(challengeHeader), nc: '00000001', cnonce,
      });
      if (!req.headers.authorization || req.headers.authorization !== expected) {
        strip.requests.push({ method: req.method, url: req.url, authed: false });
        res.writeHead(401, { 'WWW-Authenticate': challengeHeader, Connection: 'close' });
        res.end();
        return;
      }
      strip.requests.push({ method: req.method, url: req.url, authed: true, csrf: req.headers['x-csrf'] || null, body });

      const json = (status, value) => {
        res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' });
        res.end(JSON.stringify(value));
      };

      if (req.method === 'GET' && req.url === '/restapi/relay/outlets/all;/physical_state/') return json(207, strip.states);
      if (req.method === 'GET' && req.url === '/restapi/relay/outlets/all;/name/') return json(207, strip.names);
      const one = /^\/restapi\/relay\/outlets\/([0-7])\/(physical_state|transient_state)\/$/.exec(req.url);
      if (one && req.method === 'GET') return json(200, strip.states[Number(one[1])]);
      if (one && one[2] === 'transient_state' && req.method === 'PUT') {
        if (!req.headers['x-csrf']) return json(403, { error: 'csrf' });
        const value = new URLSearchParams(body).get('value');
        if (value !== 'true' && value !== 'false') return json(400, { error: 'value' });
        strip.states[Number(one[1])] = value === 'true';
        strip.writes.push({ index: Number(one[1]), value: value === 'true' });
        res.writeHead(204, { Connection: 'close' });
        res.end();
        return;
      }
      json(404, { error: 'not_found' });
    });
  });

  return { server, strip, username, password };
}

module.exports = { createFakeDli };
