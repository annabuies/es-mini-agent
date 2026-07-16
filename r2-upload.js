'use strict';

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');

const DEFAULT_SIZE_BYTES = 300 * 1024 * 1024;
const PART_SIZE_BYTES = 25 * 1024 * 1024;
const RECORDING_CHECK_INTERVAL_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(keyPart, data) {
  return crypto.createHmac('sha256', keyPart).update(data, 'utf8').digest();
}

function normalizeEndpoint(endpoint) {
  const raw = String(endpoint || '').trim().replace(/\/+$/, '');
  if (!raw) throw new Error('r2 endpoint is required');
  if (/^https?:\/\//i.test(raw)) return raw;
  return 'https://' + raw;
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
}

function encodePath(value) {
  return String(value || '')
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function buildCanonicalQueryString(query) {
  const pairs = [];
  const src = query && typeof query === 'object' ? query : {};
  for (const key of Object.keys(src)) {
    const raw = src[key];
    if (raw === undefined || raw === null) continue;
    if (Array.isArray(raw)) {
      for (const item of raw) {
        pairs.push([encodeRfc3986(key), encodeRfc3986(String(item == null ? '' : item))]);
      }
      continue;
    }
    pairs.push([encodeRfc3986(key), encodeRfc3986(String(raw))]);
  }
  pairs.sort((a, b) => {
    if (a[0] === b[0]) return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
    return a[0] < b[0] ? -1 : 1;
  });
  return pairs.map(([k, v]) => k + '=' + v).join('&');
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

function toSafeFileName(value) {
  return String(value || '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+/, '')
    .slice(0, 180) || 'r2_dummy_upload';
}

async function readJsonFile(filePath) {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}

async function writeJsonFileAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const tmpPath = filePath + '.tmp';
  await fsp.writeFile(tmpPath, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(tmpPath, filePath);
}

async function removeFileIfExists(filePath) {
  try {
    await fsp.unlink(filePath);
  } catch (e) {
    if (!e || e.code !== 'ENOENT') throw e;
  }
}

function normalizeCompletedParts(parts) {
  const map = new Map();
  if (!Array.isArray(parts)) return [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const partNumber = Number(part.partNumber);
    if (!Number.isInteger(partNumber) || partNumber <= 0) continue;
    const etag = typeof part.etag === 'string' ? part.etag : '';
    if (!etag) continue;
    map.set(partNumber, etag);
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([partNumber, etag]) => ({ partNumber, etag }));
}

function bytesUploadedForParts(partsCompleted, sizeBytes, partSize) {
  let sum = 0;
  for (const part of partsCompleted) {
    const n = part.partNumber;
    const start = (n - 1) * partSize;
    const end = Math.min(sizeBytes, start + partSize);
    if (end > start) sum += (end - start);
  }
  return sum;
}

async function ensureDummyFile(filePath, sizeBytes) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  try {
    const st = await fsp.stat(filePath);
    if (st.isFile() && st.size === sizeBytes) return;
  } catch (e) {
    if (!e || e.code !== 'ENOENT') throw e;
  }

  await removeFileIfExists(filePath);

  const handle = await fsp.open(filePath, 'w');
  const pattern = Buffer.alloc(Math.min(4 * 1024 * 1024, sizeBytes), 0xAB);
  let written = 0;
  try {
    while (written < sizeBytes) {
      const len = Math.min(pattern.length, sizeBytes - written);
      await handle.write(pattern, 0, len, written);
      written += len;
    }
  } finally {
    await handle.close();
  }
}

async function readResponseTextSafe(res) {
  try {
    return await res.text();
  } catch (_) {
    return '';
  }
}

function buildStateFromParts(uploadId, key, partSize, totalParts, completedParts) {
  return {
    uploadId,
    key,
    partSize,
    totalParts,
    completedParts: normalizeCompletedParts(completedParts),
  };
}

function makeAbortError() {
  const err = new Error('upload_aborted_by_request');
  err.code = 'aborted';
  return err;
}

function isAbortError(err) {
  return !!(err && err.code === 'aborted');
}

function signR2Request({
  method,
  key,
  query,
  accessKeyId,
  secretAccessKey,
  bucket,
  endpoint,
}) {
  const verb = String(method || '').toUpperCase();
  if (!verb) throw new Error('method is required');
  if (!accessKeyId || !secretAccessKey || !bucket || !endpoint) {
    throw new Error('r2 signing config missing required fields');
  }

  const endpointNoSlash = normalizeEndpoint(endpoint);
  const endpointUrl = new URL(endpointNoSlash);
  const host = endpointUrl.host;
  const normalizedKey = String(key || '').replace(/^\/+/, '');
  const canonicalUri = '/' + encodePath(String(bucket)) + '/' + encodePath(normalizedKey);
  const canonicalQueryString = buildCanonicalQueryString(query);

  const { amzDate, dateStamp } = amzNow();
  const canonicalHeaders = 'host:' + host + '\n'
    + 'x-amz-content-sha256:UNSIGNED-PAYLOAD\n'
    + 'x-amz-date:' + amzDate + '\n';
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    verb,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const credentialScope = dateStamp + '/auto/s3/aws4_request';
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(Buffer.from('AWS4' + secretAccessKey, 'utf8'), dateStamp);
  const kRegion = hmac(kDate, 'auto');
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization = 'AWS4-HMAC-SHA256 '
    + 'Credential=' + accessKeyId + '/' + credentialScope + ', '
    + 'SignedHeaders=' + signedHeaders + ', '
    + 'Signature=' + signature;

  const url = endpointNoSlash + canonicalUri + (canonicalQueryString ? ('?' + canonicalQueryString) : '');

  return {
    url,
    headers: {
      host,
      'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
      'x-amz-date': amzDate,
      Authorization: authorization,
    },
  };
}

async function runMultipartUploadTest(opts) {
  const startedAt = Date.now();
  const r2Config = opts && opts.r2Config ? opts.r2Config : {};
  const key = String((opts && opts.key) || '').trim();
  const testId = opts && opts.testId ? opts.testId : undefined;
  const sizeBytesRaw = Number(opts && opts.sizeBytes);
  const sizeBytes = Number.isFinite(sizeBytesRaw) && sizeBytesRaw > 0
    ? Math.floor(sizeBytesRaw)
    : DEFAULT_SIZE_BYTES;

  if (!key) throw new Error('runMultipartUploadTest requires key');

  const stateFilePath = path.resolve(String((opts && opts.stateFilePath) || path.join(process.cwd(), '.r2-test-tmp', toSafeFileName(key) + '.state.json')));
  const tmpDir = path.dirname(stateFilePath);
  const dummyFilePath = path.join(tmpDir, toSafeFileName(key) + '.bin');
  const partSize = PART_SIZE_BYTES;
  const totalParts = Math.ceil(sizeBytes / partSize);

  let uploadId = null;
  let multipartFinalized = false;
  let verified = false;
  let pausedForRecordingMs = 0;
  let summary = null;
  let fatalError = null;
  let stateForCompletion = null;

  async function signedFetch(method, query, body, extraHeaders) {
    const signed = signR2Request({
      method,
      key,
      query,
      accessKeyId: r2Config.accessKeyId,
      secretAccessKey: r2Config.secretAccessKey,
      bucket: r2Config.bucket,
      endpoint: r2Config.endpoint,
    });
    const headers = Object.assign({}, signed.headers, extraHeaders || {});
    return fetch(signed.url, {
      method,
      headers,
      body: body == null ? undefined : body,
    });
  }

  try {
    await fsp.mkdir(tmpDir, { recursive: true });
    await ensureDummyFile(dummyFilePath, sizeBytes);

    const existingState = await readJsonFile(stateFilePath);
    if (existingState && existingState.key === key && existingState.uploadId) {
      uploadId = String(existingState.uploadId);
      if (existingState.partSize !== partSize || existingState.totalParts !== totalParts) {
        throw new Error('existing multipart state does not match requested size/key layout');
      }
      stateForCompletion = buildStateFromParts(uploadId, key, partSize, totalParts, existingState.completedParts);
    } else if (existingState && existingState.key && existingState.key !== key) {
      throw new Error('existing state key mismatch for requested key');
    } else {
      const createRes = await signedFetch('POST', { uploads: '' }, null);
      if (!createRes.ok) {
        const detail = truncateDetail(await readResponseTextSafe(createRes));
        throw new Error('CreateMultipartUpload failed status=' + createRes.status + ' detail=' + detail);
      }
      const createBody = await readResponseTextSafe(createRes);
      const uploadIdMatch = createBody.match(/<UploadId>([^<]+)<\/UploadId>/);
      if (!uploadIdMatch) {
        throw new Error('CreateMultipartUpload response missing UploadId');
      }
      uploadId = uploadIdMatch[1];
      stateForCompletion = buildStateFromParts(uploadId, key, partSize, totalParts, []);
      await writeJsonFileAtomic(stateFilePath, stateForCompletion);
    }

    const fileHandle = await fsp.open(dummyFilePath, 'r');
    try {
      for (let partNumber = 1; partNumber <= totalParts; partNumber += 1) {
        const alreadyDone = stateForCompletion.completedParts.some((part) => part.partNumber === partNumber);
        if (alreadyDone) continue;

        while (true) {
          if (opts && typeof opts.shouldAbort === 'function' && opts.shouldAbort()) {
            throw makeAbortError();
          }
          if (!(opts && typeof opts.isRecording === 'function' && opts.isRecording())) break;
          const waitStart = Date.now();
          await sleep(RECORDING_CHECK_INTERVAL_MS);
          pausedForRecordingMs += (Date.now() - waitStart);
        }

        const start = (partNumber - 1) * partSize;
        const endExclusive = Math.min(sizeBytes, start + partSize);
        const partLen = endExclusive - start;
        const partBytes = Buffer.alloc(partLen);
        let offset = 0;
        while (offset < partLen) {
          const readResult = await fileHandle.read(partBytes, offset, partLen - offset, start + offset);
          if (!readResult.bytesRead) {
            throw new Error('unexpected EOF while reading part ' + partNumber);
          }
          offset += readResult.bytesRead;
        }

        const putRes = await signedFetch(
          'PUT',
          { partNumber: String(partNumber), uploadId },
          partBytes,
          { 'content-length': String(partLen) },
        );
        if (!putRes.ok) {
          const detail = truncateDetail(await readResponseTextSafe(putRes));
          throw new Error('UploadPart failed part=' + partNumber + ' status=' + putRes.status + ' detail=' + detail);
        }
        const etag = putRes.headers.get('etag');
        if (!etag) {
          throw new Error('UploadPart missing ETag part=' + partNumber);
        }

        stateForCompletion.completedParts.push({ partNumber, etag });
        stateForCompletion = buildStateFromParts(uploadId, key, partSize, totalParts, stateForCompletion.completedParts);
        await writeJsonFileAtomic(stateFilePath, stateForCompletion);

        if (opts && typeof opts.onProgress === 'function') {
          try {
            opts.onProgress({
              partsCompleted: stateForCompletion.completedParts.length,
              totalParts,
              bytesUploaded: bytesUploadedForParts(stateForCompletion.completedParts, sizeBytes, partSize),
            });
          } catch (_) {
            // Progress reporting is best-effort only.
          }
        }
      }
    } finally {
      await fileHandle.close();
    }

    const completionState = await readJsonFile(stateFilePath);
    if (!completionState || completionState.key !== key || completionState.uploadId !== uploadId) {
      throw new Error('state file unavailable or mismatched before CompleteMultipartUpload');
    }
    const orderedParts = normalizeCompletedParts(completionState.completedParts);
    if (orderedParts.length !== totalParts) {
      throw new Error('cannot complete multipart upload: missing parts (' + orderedParts.length + '/' + totalParts + ')');
    }
    const completeXml = '<CompleteMultipartUpload>'
      + orderedParts.map((part) => (
        '<Part><PartNumber>' + part.partNumber + '</PartNumber><ETag>' + part.etag + '</ETag></Part>'
      )).join('')
      + '</CompleteMultipartUpload>';
    const completeRes = await signedFetch(
      'POST',
      { uploadId },
      Buffer.from(completeXml, 'utf8'),
      {
        'content-length': String(Buffer.byteLength(completeXml)),
        'content-type': 'application/xml; charset=utf-8',
      },
    );
    if (!completeRes.ok) {
      const detail = truncateDetail(await readResponseTextSafe(completeRes));
      throw new Error('CompleteMultipartUpload failed status=' + completeRes.status + ' detail=' + detail);
    }
    multipartFinalized = true;

    const headRes = await signedFetch('HEAD', {}, null);
    if (!headRes.ok) {
      throw new Error('HeadObject verification failed status=' + headRes.status);
    }
    const contentLengthHeader = headRes.headers.get('content-length');
    const contentLength = Number(contentLengthHeader);
    if (!Number.isFinite(contentLength) || contentLength !== sizeBytes) {
      throw new Error('HeadObject size mismatch expected=' + sizeBytes + ' got=' + String(contentLengthHeader));
    }
    verified = true;

    const payload = {
      event: 'upload_confirmed',
      key,
      sizeBytes,
      testId,
      confirmedAt: new Date().toISOString(),
    };
    console.log('[r2-upload] upload_confirmed:', JSON.stringify(payload));
    if (opts && opts.webhookUrl) {
      try {
        const webhookRes = await fetch(String(opts.webhookUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!webhookRes.ok) {
          const detail = truncateDetail(await readResponseTextSafe(webhookRes));
          console.warn('[r2-upload] upload_confirmed webhook failed status=' + webhookRes.status + ' detail=' + detail);
        }
      } catch (e) {
        console.warn('[r2-upload] upload_confirmed webhook error:', e && (e.stack || e.message || e));
      }
    } else {
      console.log('[r2-upload] UPLOAD_CONFIRMED_WEBHOOK_URL not set - this is the exact hook point for the future Trigger.dev "master upload confirmed" task (see Clients/ES/app/15-camera-mac-mini-capture-handoff.md section 5.4)');
    }

    summary = {
      ok: true,
      key,
      sizeBytes,
      partsUploaded: orderedParts.length,
      elapsedMs: Date.now() - startedAt,
      pausedForRecordingMs,
    };
  } catch (e) {
    fatalError = e;
  } finally {
    if (verified) {
      try {
        const deleteRes = await signedFetch('DELETE', {}, null);
        if (!deleteRes.ok) {
          const detail = truncateDetail(await readResponseTextSafe(deleteRes));
          throw new Error('DeleteObject cleanup failed status=' + deleteRes.status + ' detail=' + detail);
        }
        await removeFileIfExists(dummyFilePath);
        await removeFileIfExists(stateFilePath);
      } catch (cleanupErr) {
        fatalError = fatalError || cleanupErr;
      }
    } else if (uploadId && !multipartFinalized) {
      try {
        const abortRes = await signedFetch('DELETE', { uploadId }, null);
        if (!abortRes.ok) {
          const detail = truncateDetail(await readResponseTextSafe(abortRes));
          console.warn('[r2-upload] AbortMultipartUpload failed status=' + abortRes.status + ' detail=' + detail);
        }
      } catch (abortErr) {
        console.warn('[r2-upload] AbortMultipartUpload error:', abortErr && (abortErr.stack || abortErr.message || abortErr));
      }
    } else if (fatalError && multipartFinalized) {
      // Verify failed after completion: object may already exist and incur cost; best-effort delete.
      try {
        await signedFetch('DELETE', {}, null);
      } catch (_) {
        // Ignore cleanup failure; keep primary error.
      }
    }
  }

  if (fatalError) {
    if (isAbortError(fatalError)) throw fatalError;
    throw fatalError;
  }
  return summary;
}

module.exports = {
  signR2Request,
  runMultipartUploadTest,
};
