'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const OBS_RPC_VERSION = 1;
const CONNECT_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 5000;

function makeError(message) {
  return new Error(message || 'obs_error');
}

function sha256Base64(input) {
  return crypto.createHash('sha256').update(input).digest('base64');
}

function makeObsAuth(password, salt, challenge) {
  const secret = sha256Base64(String(password || '') + salt);
  return sha256Base64(secret + challenge);
}

function normalizeMessageData(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  return '';
}

class ObsClient {
  constructor(opts) {
    const options = opts || {};
    this.url = options.url || 'ws://127.0.0.1:4455';
    this.password = options.password || '';
    this.requestTimeoutMs = options.requestTimeoutMs || REQUEST_TIMEOUT_MS;

    this.ws = null;
    this.connected = false;
    this.connectPromise = null;
    this.connectTimeout = null;
    this.pending = new Map();

    this._resolveConnect = null;
    this._rejectConnect = null;
  }

  async ensureConnected() {
    const socket = this.ws;
    if (this.connected && socket && socket.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.connectPromise = this._connect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async request(requestType, requestData) {
    await this.ensureConnected();

    const requestId = crypto.randomUUID();
    const payload = {
      op: 6,
      d: {
        requestType,
        requestId,
      },
    };
    if (requestData && typeof requestData === 'object' && Object.keys(requestData).length > 0) {
      payload.d.requestData = requestData;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(makeError('obs_request_timeout'));
      }, this.requestTimeoutMs);

      this.pending.set(requestId, { resolve, reject, timer });

      try {
        this._send(payload);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(e instanceof Error ? e : makeError('obs_send_failed'));
      }
    });
  }

  close() {
    this._markDisconnected(makeError('obs_client_closed'));
  }

  _connect() {
    if (typeof WebSocket !== 'function') {
      return Promise.reject(makeError('global_websocket_unavailable'));
    }

    return new Promise((resolve, reject) => {
      this._resolveConnect = resolve;
      this._rejectConnect = reject;

      this.connectTimeout = setTimeout(() => {
        this._failConnect(makeError('obs_connect_timeout'));
      }, CONNECT_TIMEOUT_MS);

      let socket;
      try {
        socket = new WebSocket(this.url);
      } catch (e) {
        this._failConnect(e instanceof Error ? e : makeError('obs_connect_failed'));
        return;
      }

      this.ws = socket;
      this.connected = false;

      socket.addEventListener('message', (event) => {
        try {
          this._onMessage(event);
        } catch (_) {
          // Ignore parse/shape errors from non-essential frames.
        }
      });

      socket.addEventListener('close', () => {
        if (!this.connected) {
          this._failConnect(makeError('obs_socket_closed_during_handshake'));
          return;
        }
        this._markDisconnected(makeError('obs_socket_closed'));
      });

      socket.addEventListener('error', () => {
        if (!this.connected) {
          this._failConnect(makeError('obs_socket_error_during_handshake'));
          return;
        }
        this._markDisconnected(makeError('obs_socket_error'));
      });
    });
  }

  _onMessage(event) {
    const raw = normalizeMessageData(event && event.data);
    if (!raw) return;

    let packet;
    try {
      packet = JSON.parse(raw);
    } catch (_) {
      return;
    }
    if (!packet || typeof packet !== 'object') return;

    if (packet.op === 0) {
      this._handleHello(packet.d || {});
      return;
    }

    if (packet.op === 2) {
      this.connected = true;
      this._finishConnect();
      return;
    }

    if (packet.op === 7) {
      const data = packet.d || {};
      const requestId = data.requestId;
      if (!requestId || !this.pending.has(requestId)) return;
      const pending = this.pending.get(requestId);
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.resolve(data);
    }
  }

  _handleHello(helloData) {
    const identify = {
      op: 1,
      d: {
        rpcVersion: OBS_RPC_VERSION,
        eventSubscriptions: 0,
      },
    };

    const auth = helloData && helloData.authentication;
    if (auth && typeof auth === 'object') {
      if (typeof auth.challenge !== 'string' || typeof auth.salt !== 'string') {
        this._failConnect(makeError('obs_invalid_auth_challenge'));
        return;
      }
      identify.d.authentication = makeObsAuth(this.password, auth.salt, auth.challenge);
    }

    try {
      this._send(identify);
    } catch (e) {
      this._failConnect(e instanceof Error ? e : makeError('obs_identify_send_failed'));
    }
  }

  _send(payload) {
    const socket = this.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw makeError('obs_socket_not_open');
    }
    socket.send(JSON.stringify(payload));
  }

  _finishConnect() {
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
    if (this._resolveConnect) {
      const resolve = this._resolveConnect;
      this._resolveConnect = null;
      this._rejectConnect = null;
      resolve();
    }
  }

  _failConnect(err) {
    const error = err instanceof Error ? err : makeError('obs_connect_failed');
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
    if (this._rejectConnect) {
      const reject = this._rejectConnect;
      this._resolveConnect = null;
      this._rejectConnect = null;
      reject(error);
    }
    this._markDisconnected(error);
  }

  _markDisconnected(err) {
    this.connected = false;

    const socket = this.ws;
    this.ws = null;
    if (socket) {
      try {
        socket.close();
      } catch (_) {
        // noop
      }
    }

    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }

    if (this._rejectConnect) {
      const reject = this._rejectConnect;
      this._resolveConnect = null;
      this._rejectConnect = null;
      reject(err instanceof Error ? err : makeError('obs_disconnected'));
    }

    const error = err instanceof Error ? err : makeError('obs_disconnected');
    for (const [requestId, pending] of this.pending.entries()) {
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

async function callVendor(client, requestType, source) {
  try {
    const response = await client.request('CallVendorRequest', {
      vendorName: 'source-record',
      requestType,
      requestData: { source },
    });

    const vendorData = response && response.responseData && response.responseData.responseData;
    if (!vendorData || typeof vendorData !== 'object' || typeof vendorData.success !== 'boolean') {
      return { success: false, error: 'malformed_response' };
    }

    if (vendorData.success) {
      return { success: true, error: null };
    }

    if (typeof vendorData.error === 'string' && vendorData.error) {
      return { success: false, error: vendorData.error };
    }
    return { success: false, error: 'vendor_error' };
  } catch (e) {
    const message = e && e.message ? e.message : 'request_failed';
    return { success: false, error: message };
  }
}

function getNewestFileSample(sourceDir) {
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  let newest = null;

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const absPath = path.join(sourceDir, entry.name);
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) continue;

    if (!newest || stat.mtimeMs > newest.mtimeMs) {
      newest = {
        name: entry.name,
        absPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    }
  }

  return newest;
}

function sampleFeedsWriting(sources, recordDir, prevSamples) {
  const nextSamples = new Map();
  const prev = prevSamples instanceof Map ? prevSamples : new Map();
  const now = Date.now();
  let count = 0;

  for (const source of sources) {
    try {
      const sourceDir = path.join(recordDir, source);
      const newest = getNewestFileSample(sourceDir);
      if (!newest) continue;

      const sample = {
        size: newest.size,
        mtimeMs: newest.mtimeMs,
        sampledAt: now,
      };
      nextSamples.set(source, sample);

      const prevSample = prev.get(source);
      const freshEnough = now - sample.mtimeMs <= 5000;
      const grewSincePrevious = !prevSample || sample.size > prevSample.size;
      if (freshEnough && grewSincePrevious) {
        count += 1;
      }
    } catch (_) {
      // Missing source folder/file or transient IO error: treat as not writing.
    }
  }

  return { count, samples: nextSamples };
}

async function getSourceScreenshot(client, source, width, quality) {
  if (!client || typeof client.request !== 'function') return null;

  async function attempt(imageFormat) {
    try {
      const response = await client.request('GetSourceScreenshot', {
        sourceName: source,
        imageFormat,
        imageWidth: width,
        imageCompressionQuality: quality,
      });

      const status = response && response.requestStatus;
      if (!status || typeof status !== 'object') {
        return { ok: false, retryWithJpeg: false, frame: null };
      }
      if (status.result === false) {
        const comment = typeof status.comment === 'string' ? status.comment.toLowerCase() : '';
        const retryWithJpeg = imageFormat === 'jpg' && comment.includes('format');
        return { ok: false, retryWithJpeg, frame: null };
      }
      if (status.result !== true) {
        return { ok: false, retryWithJpeg: false, frame: null };
      }

      const imageData = response && response.responseData && response.responseData.imageData;
      if (typeof imageData !== 'string') {
        return { ok: false, retryWithJpeg: false, frame: null };
      }
      const comma = imageData.indexOf(',');
      if (comma < 0 || comma >= (imageData.length - 1)) {
        return { ok: false, retryWithJpeg: false, frame: null };
      }

      const payload = imageData.slice(comma + 1).trim();
      if (!payload) {
        return { ok: false, retryWithJpeg: false, frame: null };
      }
      if (!/^[A-Za-z0-9+/=\r\n]+$/.test(payload)) {
        return { ok: false, retryWithJpeg: false, frame: null };
      }

      const frame = Buffer.from(payload, 'base64');
      if (!frame || frame.length === 0) {
        return { ok: false, retryWithJpeg: false, frame: null };
      }
      return { ok: true, retryWithJpeg: false, frame };
    } catch (_) {
      return { ok: false, retryWithJpeg: false, frame: null };
    }
  }

  const first = await attempt('jpg');
  if (first.ok) return first.frame;
  if (first.retryWithJpeg) {
    const second = await attempt('jpeg');
    if (second.ok) return second.frame;
  }
  return null;
}

module.exports = {
  ObsClient,
  callVendor,
  getSourceScreenshot,
  getNewestFileSample,
  sampleFeedsWriting,
};
