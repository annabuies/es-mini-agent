'use strict';

const crypto = require('crypto');
const http = require('http');

const SUPPORTED_ALGORITHMS = new Set(['MD5', 'MD5-sess', 'SHA-256', 'SHA-256-sess']);

function unquote(value) {
  return value.replace(/\\(.)/g, '$1');
}

function parseChallenge(header) {
  if (typeof header !== 'string') return null;
  const match = /(?:^|,)\s*Digest\s+(.+)/i.exec(header);
  if (!match) return null;
  const values = {};
  const params = match[1];
  const pattern = /([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^,\s]+))/g;
  let part;
  while ((part = pattern.exec(params))) {
    values[part[1].toLowerCase()] = typeof part[2] === 'string' ? unquote(part[2]) : part[3];
  }
  const algorithm = values.algorithm || 'MD5';
  if (!values.realm || !values.nonce || !SUPPORTED_ALGORITHMS.has(algorithm)) return null;
  const qop = typeof values.qop === 'string'
    ? values.qop.split(',').map((value) => value.trim()).find((value) => value === 'auth') || null
    : null;
  if (values.qop && !qop) return null;
  return { realm: values.realm, nonce: values.nonce, qop, algorithm, opaque: values.opaque || null };
}

function hashName(algorithm) {
  return algorithm.startsWith('SHA-256') ? 'sha256' : 'md5';
}

function digest(algorithm, value) {
  return crypto.createHash(hashName(algorithm)).update(value, 'utf8').digest('hex');
}

function quote(value) {
  return String(value).replace(/([\\"])/g, '\\$1');
}

function buildAuthorization({ method, uri, username, password, challenge, nc, cnonce }) {
  if (!challenge || !SUPPORTED_ALGORITHMS.has(challenge.algorithm) || !challenge.qop) return null;
  const requestMethod = typeof method === 'string' ? method.toUpperCase() : 'GET';
  const requestUri = typeof uri === 'string' && uri.startsWith('/') ? uri : '/';
  const nonceCount = typeof nc === 'string' && /^[0-9a-fA-F]{8}$/.test(nc) ? nc : '00000001';
  const clientNonce = typeof cnonce === 'string' && cnonce ? cnonce : crypto.randomBytes(16).toString('hex');
  let ha1 = digest(challenge.algorithm, `${username}:${challenge.realm}:${password}`);
  if (challenge.algorithm.endsWith('-sess')) {
    ha1 = digest(challenge.algorithm, `${ha1}:${challenge.nonce}:${clientNonce}`);
  }
  const ha2 = digest(challenge.algorithm, `${requestMethod}:${requestUri}`);
  const response = digest(challenge.algorithm, `${ha1}:${challenge.nonce}:${nonceCount}:${clientNonce}:${challenge.qop}:${ha2}`);
  const fields = [
    `username="${quote(username)}"`,
    `realm="${quote(challenge.realm)}"`,
    `uri="${quote(requestUri)}"`,
    `algorithm=${challenge.algorithm}`,
    `nonce="${quote(challenge.nonce)}"`,
    `nc=${nonceCount}`,
    `cnonce="${quote(clientNonce)}"`,
    `qop=${challenge.qop}`,
    `response="${response}"`,
  ];
  if (challenge.opaque) fields.push(`opaque="${quote(challenge.opaque)}"`);
  return `Digest ${fields.join(', ')}`;
}

function requestOnce(url, authorization, deadline, includeBody, method, extraHeaders, payload) {
  return new Promise((resolve) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      resolve({ statusCode: null, timedOut: true });
      return;
    }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let request;
    try {
      const target = new URL(url);
      const headers = Object.assign({}, extraHeaders, { Connection: 'close' }, authorization ? { Authorization: authorization } : {});
      if (payload !== null) headers['Content-Length'] = Buffer.byteLength(payload);
      request = http.request(target, {
        method,
        agent: false,
        headers,
      }, (response) => {
        const challenge = parseChallenge(response.headers['www-authenticate']);
        if (!includeBody) {
          response.resume();
          response.once('end', () => finish({ statusCode: response.statusCode || null, challenge }));
          return;
        }
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.once('end', () => finish({ statusCode: response.statusCode || null, challenge, body: Buffer.concat(chunks).toString('utf8') }));
      });
    } catch (_) {
      finish({ statusCode: null, error: true });
      return;
    }
    request.setTimeout(remaining, () => request.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    request.once('error', (error) => finish({ statusCode: null, timedOut: !!(error && error.code === 'ETIMEDOUT'), error: true }));
    request.end(payload === null ? undefined : payload);
  });
}

// `method`, `headers` and `body` default to a bare GET, which is all the camera
// callers use. A write (e.g. the power strip's PUT) resends its body with the
// Authorization header after the 401, so the unauthenticated first attempt
// never takes effect on a server that requires auth.
async function requestWithDigest({ url, username, password, timeoutMs, includeBody = false, method = 'GET', headers = null, body = null }) {
  const timeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Math.floor(Number(timeoutMs)) : 3000;
  const deadline = Date.now() + timeout;
  const requestMethod = typeof method === 'string' && method ? method.toUpperCase() : 'GET';
  const extraHeaders = headers && typeof headers === 'object' ? headers : {};
  const payload = typeof body === 'string' ? body : null;
  const first = await requestOnce(url, null, deadline, includeBody, requestMethod, extraHeaders, payload);
  const challenged = first.statusCode === 401 && !!first.challenge;
  if (!challenged || !username || !password) return Object.assign(first, { challenged, attempted: false });
  const target = new URL(url);
  const authorization = buildAuthorization({
    method: requestMethod, uri: `${target.pathname}${target.search}`, username, password,
    challenge: first.challenge, nc: '00000001',
  });
  if (!authorization) return Object.assign(first, { challenged, attempted: false });
  const retry = await requestOnce(url, authorization, deadline, includeBody, requestMethod, extraHeaders, payload);
  return Object.assign(retry, { challenged: true, attempted: true });
}

module.exports = { buildAuthorization, parseChallenge, requestWithDigest };
