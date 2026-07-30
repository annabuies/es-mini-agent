'use strict';

const crypto = require('crypto');

const STS_ENDPOINT = 'https://sts.amazonaws.com/';
const STS_REGION = 'us-east-1';
const STS_SERVICE = 'sts';
const REFRESH_WINDOW_MS = 5 * 60 * 1000;

function sha256hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(keyPart, data) {
  return crypto.createHmac('sha256', keyPart).update(data, 'utf8').digest();
}

function amzNow() {
  const iso = new Date().toISOString();
  const amzDate = iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  return { amzDate, dateStamp };
}

function truncateDetail(value) {
  const s = typeof value === 'string' ? value : String(value || '');
  return s.length > 300 ? s.slice(0, 300) : s;
}

function extractXmlValue(xml, tagName) {
  const re = new RegExp('<' + tagName + '>([^<]+)</' + tagName + '>');
  const match = String(xml || '').match(re);
  return match ? match[1] : '';
}

function buildAssumeRoleBody(roleArn, sessionName) {
  return 'Action=AssumeRole'
    + '&Version=2011-06-15'
    + '&RoleArn=' + encodeURIComponent(roleArn)
    + '&RoleSessionName=' + encodeURIComponent(sessionName)
    + '&DurationSeconds=3600';
}

function buildStsSignedHeaders(body, accessKeyId, secretAccessKey) {
  const endpointUrl = new URL(STS_ENDPOINT);
  const host = endpointUrl.host;
  const { amzDate, dateStamp } = amzNow();
  const payloadHash = sha256hex(body);
  const canonicalHeaders = 'content-type:application/x-www-form-urlencoded; charset=utf-8\n'
    + 'host:' + host + '\n'
    + 'x-amz-date:' + amzDate + '\n';
  const signedHeaders = 'content-type;host;x-amz-date';
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const credentialScope = dateStamp + '/' + STS_REGION + '/' + STS_SERVICE + '/aws4_request';
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256hex(canonicalRequest),
  ].join('\n');
  const kDate = hmac(Buffer.from('AWS4' + secretAccessKey, 'utf8'), dateStamp);
  const kRegion = hmac(kDate, STS_REGION);
  const kService = hmac(kRegion, STS_SERVICE);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  const authorization = 'AWS4-HMAC-SHA256 '
    + 'Credential=' + accessKeyId + '/' + credentialScope + ', '
    + 'SignedHeaders=' + signedHeaders + ', '
    + 'Signature=' + signature;
  return {
    Authorization: authorization,
    'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
    'x-amz-date': amzDate,
  };
}

function createStaticProvider(accessKeyId, secretAccessKey) {
  return {
    async getCredentials() {
      return {
        accessKeyId,
        secretAccessKey,
        sessionToken: null,
        expiresAt: null,
      };
    },
    describeCredentials() {
      return {
        mode: 'static',
        hasCached: false,
        expiresAt: null,
      };
    },
  };
}

function createCredentialsProvider(config) {
  const input = config && typeof config === 'object' ? config : {};
  const accessKeyId = String(input.accessKeyId || '').trim();
  const secretAccessKey = String(input.secretAccessKey || '').trim();
  const roleArn = String(input.roleArn || '').trim();
  const sessionName = String(input.sessionName || 'es-mini-agent').trim() || 'es-mini-agent';

  if (!roleArn) {
    return createStaticProvider(accessKeyId, secretAccessKey);
  }

  let cached = null;
  let refreshPromise = null;

  function cachedIsValid(nowMs) {
    return !!(cached && Number.isFinite(cached.expiresAtMs) && cached.expiresAtMs > nowMs);
  }

  function shouldRefresh(nowMs) {
    if (!cached || !Number.isFinite(cached.expiresAtMs)) return true;
    return (cached.expiresAtMs - nowMs) < REFRESH_WINDOW_MS;
  }

  function publicCreds(value) {
    return {
      accessKeyId: value.accessKeyId,
      secretAccessKey: value.secretAccessKey,
      sessionToken: value.sessionToken,
      expiresAt: value.expiresAt,
    };
  }

  async function refreshAssumeRole() {
    if (!accessKeyId || !secretAccessKey) {
      throw new Error('AssumeRole requires base AWS credentials');
    }

    const body = buildAssumeRoleBody(roleArn, sessionName);
    const headers = buildStsSignedHeaders(body, accessKeyId, secretAccessKey);
    const res = await fetch(STS_ENDPOINT, {
      method: 'POST',
      headers,
      body,
    });

    const responseText = await res.text().catch(() => '');
    if (!res.ok) {
      throw new Error('AssumeRole failed status=' + res.status + ' detail=' + truncateDetail(responseText));
    }

    const nextAccessKeyId = extractXmlValue(responseText, 'AccessKeyId');
    const nextSecretAccessKey = extractXmlValue(responseText, 'SecretAccessKey');
    const nextSessionToken = extractXmlValue(responseText, 'SessionToken');
    const nextExpiration = extractXmlValue(responseText, 'Expiration');
    const expiresAtMs = Date.parse(nextExpiration);
    if (!nextAccessKeyId || !nextSecretAccessKey || !nextSessionToken || !nextExpiration || !Number.isFinite(expiresAtMs)) {
      throw new Error('AssumeRole response missing required credentials fields');
    }

    cached = {
      accessKeyId: nextAccessKeyId,
      secretAccessKey: nextSecretAccessKey,
      sessionToken: nextSessionToken,
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
    };
    console.log('[aws-creds] assumed role credentials refreshed expiresAt=' + cached.expiresAt);
    return publicCreds(cached);
  }

  async function getCredentials() {
    const nowMs = Date.now();
    if (cachedIsValid(nowMs) && !shouldRefresh(nowMs)) {
      return publicCreds(cached);
    }

    if (!refreshPromise) {
      refreshPromise = (async () => {
        try {
          return await refreshAssumeRole();
        } finally {
          refreshPromise = null;
        }
      })();
    }

    try {
      return await refreshPromise;
    } catch (e) {
      if (cachedIsValid(Date.now())) {
        console.warn('[aws-creds] AssumeRole refresh failed, using cached credentials until expiry:', e && (e.message || e));
        return publicCreds(cached);
      }
      throw e;
    }
  }

  function describeCredentials() {
    return {
      mode: 'assume_role',
      hasCached: !!cached,
      expiresAt: cached ? cached.expiresAt : null,
    };
  }

  return { getCredentials, describeCredentials };
}

module.exports = {
  createCredentialsProvider,
};
