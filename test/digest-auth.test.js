'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { buildAuthorization, parseChallenge, requestWithDigest } = require('../digest-auth');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

const RFC_CHALLENGE = {
  realm: 'http-auth@example.org',
  nonce: '7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v',
  qop: 'auth',
  opaque: 'FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS',
};
const RFC_CNONCE = 'f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ';

test('parses quoted and unquoted Digest challenges and selects auth', () => {
  assert.deepEqual(parseChallenge('Digest realm="camera", nonce="abc", qop="auth, auth-int", algorithm=SHA-256, opaque="xyz"'), {
    realm: 'camera', nonce: 'abc', qop: 'auth', algorithm: 'SHA-256', opaque: 'xyz',
  });
  assert.deepEqual(parseChallenge('Digest realm=cam, nonce=xyz, qop=auth, algorithm=MD5'), {
    realm: 'cam', nonce: 'xyz', qop: 'auth', algorithm: 'MD5', opaque: null,
  });
  assert.equal(parseChallenge('Digest realm="cam", nonce="n", qop="auth-int"'), null);
});

test('buildAuthorization matches RFC 7616 section 3.9.1 MD5 and SHA-256 examples', () => {
  const input = { method: 'GET', uri: '/dir/index.html', username: 'Mufasa', password: 'Circle of Life', nc: '00000001', cnonce: RFC_CNONCE };
  const md5 = buildAuthorization({ ...input, challenge: { ...RFC_CHALLENGE, algorithm: 'MD5' } });
  const sha256 = buildAuthorization({ ...input, challenge: { ...RFC_CHALLENGE, algorithm: 'SHA-256' } });
  assert.match(md5, /response="8ca523f5e9506fed4657c9700eebdbec"/);
  assert.match(sha256, /response="753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1"/);
});

test('requestWithDigest closes both requests, retries after 401, and returns success', async (t) => {
  const challengeHeader = 'Digest realm="fake-camera", nonce="nonce-1", qop="auth", algorithm="SHA-256"';
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls += 1;
    assert.equal(req.headers.connection, 'close');
    const expected = buildAuthorization({
      method: 'GET', uri: req.url, username: 'fake-user', password: 'fake-password',
      challenge: parseChallenge(challengeHeader), nc: '00000001', cnonce: req.headers.authorization && /cnonce="([^"]+)"/.exec(req.headers.authorization)?.[1],
    });
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { 'WWW-Authenticate': challengeHeader, Connection: 'close' });
      res.end();
      return;
    }
    res.writeHead(200, { Connection: 'close' });
    res.end();
  });
  const port = await listen(server);
  t.after(() => close(server));
  const result = await requestWithDigest({ url: `http://127.0.0.1:${port}/cgi-bin/ptzctrl.cgi?ptzcmd&poscall&1`, username: 'fake-user', password: 'fake-password', timeoutMs: 500 });
  assert.deepEqual(result, { statusCode: 200, challenge: null, challenged: true, attempted: true });
  assert.equal(calls, 2);
});

test('requestWithDigest sends a PUT body and extra headers on both attempts and signs the PUT method', async (t) => {
  const challengeHeader = 'Digest realm="fake-strip", nonce="nonce-put", qop="auth", algorithm=MD5';
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ method: req.method, csrf: req.headers['x-csrf'], body: Buffer.concat(chunks).toString('utf8') });
      const expected = buildAuthorization({
        method: 'PUT', uri: req.url, username: 'fake-user', password: 'fake-password',
        challenge: parseChallenge(challengeHeader), nc: '00000001', cnonce: req.headers.authorization && /cnonce="([^"]+)"/.exec(req.headers.authorization)?.[1],
      });
      if (req.headers.authorization !== expected) {
        res.writeHead(401, { 'WWW-Authenticate': challengeHeader, Connection: 'close' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end('true');
    });
  });
  const port = await listen(server);
  t.after(() => close(server));
  const result = await requestWithDigest({
    url: `http://127.0.0.1:${port}/restapi/relay/outlets/3/transient_state/`, method: 'put', username: 'fake-user', password: 'fake-password',
    headers: { 'X-CSRF': 'x', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'value=true', includeBody: true, timeoutMs: 500,
  });
  assert.deepEqual(result, { statusCode: 200, challenge: null, body: 'true', challenged: true, attempted: true });
  assert.deepEqual(seen, [
    { method: 'PUT', csrf: 'x', body: 'value=true' },
    { method: 'PUT', csrf: 'x', body: 'value=true' },
  ]);
});

test('requestWithDigest preserves a failed authentication and honours the whole timeout', async (t) => {
  const challengeHeader = 'Digest realm="fake-camera", nonce="nonce-2", qop="auth", algorithm=MD5';
  const unauthorized = http.createServer((req, res) => {
    assert.equal(req.headers.connection, 'close');
    res.writeHead(401, { 'WWW-Authenticate': challengeHeader, Connection: 'close' });
    res.end();
  });
  const unauthorizedPort = await listen(unauthorized);
  t.after(() => close(unauthorized));
  assert.deepEqual(await requestWithDigest({ url: `http://127.0.0.1:${unauthorizedPort}/`, username: 'fake-user', password: 'wrong-fake-password', timeoutMs: 500 }), {
    statusCode: 401, challenge: parseChallenge(challengeHeader), challenged: true, attempted: true,
  });

  const slow = http.createServer(() => {});
  const slowPort = await listen(slow);
  t.after(() => close(slow));
  const started = Date.now();
  const timeoutResult = await requestWithDigest({ url: `http://127.0.0.1:${slowPort}/`, username: 'fake-user', password: 'fake-password', timeoutMs: 60 });
  assert.equal(timeoutResult.timedOut, true);
  assert.ok(Date.now() - started < 250);
});
