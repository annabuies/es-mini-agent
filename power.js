'use strict';

// power — Digital Loggers PowerSwitch Pro 10 ("studio-power") outlet control.
//
// Outlet map (labels on the strip, 1-based; Robbie 2026-09-28):
//   1 Router / 2 PoE / 3 Mini / 4 Lights (Amaran 100x) / 5-8 spare
//
// Only lights (and evo, once it is actually plugged into a mapped outlet) may
// ever be switched from here. The router, PoE switch, the Mini this agent runs
// on, and the NAS are denied by name AND by outlet number, regardless of what
// POWER_OUTLETS_SWITCHABLE says: switching any of them off takes the agent (or
// the cameras, or the studio's internet) down with no way back except a human
// at the strip's web UI. There is deliberately no `cycle` action.
//
// Power-loss restore (all on) and AutoPing are configured in the vendor UI and
// are not touched here. Writes go to `transient_state`, never the persistent
// `state`, so a reboot or power loss still lands on the strip's own restore rule.
//
// DLI REST API (restapi.pdf rev 20221009, digital-loggers.com/rest.html):
//   - relays are ZERO-based in URLs: label outlet 4 is /restapi/relay/outlets/3/
//   - auth is HTTP digest; "Allow REST-style API" must be on (External APIs page)
//   - modifying requests need an `X-CSRF` header with any value (no token fetch)
//   - `all;` matrix selectors answer 207 with a JSON array

const { requestWithDigest } = require('./digest-auth');

const DEFAULT_TIMEOUT_MS = 3000;
const MAX_OUTLETS_PER_REQUEST = 8;

// name -> 1-based outlet label. null = a known name that is not on the strip.
const OUTLET_MAP = Object.freeze({
  router: 1,
  poe: 2,
  mini: 3,
  lights: 4,
  evo: null,
  nas: null,
});

// Names POWER_OUTLETS_SWITCHABLE may enable. Anything else in the env is rejected.
const SWITCHABLE_CANDIDATES = Object.freeze(['lights', 'evo']);
const DEFAULT_SWITCHABLE = Object.freeze(['lights']);

// Compared against the name lowercased with every non-alphanumeric removed, so
// "Mac Mini", "mac-mini" and "MAC_MINI" all hit "macmini".
const DENIED_NAMES = new Set([
  'mini', 'macmini', 'mac', 'studiomini', 'esmini', 'agent', 'miniagent',
  'router', 'gateway', 'udm', 'unifi', 'modem', 'internet', 'wan', 'network',
  'poe', 'poeswitch', 'switch', 'cameras', 'camera',
  'nas', 'synology', 'storage',
  'outlet1', 'outlet2', 'outlet3', '1', '2', '3',
]);
const DENIED_OUTLETS = new Set([1, 2, 3]);

function compactName(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isDeniedName(value) {
  return DENIED_NAMES.has(compactName(value));
}

function isDeniedOutlet(outlet) {
  return DENIED_OUTLETS.has(outlet);
}

function normalizeName(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function parseSwitchable(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { switchable: DEFAULT_SWITCHABLE.slice(), rejected: [] };
  }
  const switchable = [];
  const rejected = [];
  for (const part of raw.split(',')) {
    const name = normalizeName(part);
    if (!name) continue;
    const allowed = !isDeniedName(name) && SWITCHABLE_CANDIDATES.includes(name)
      && !(OUTLET_MAP[name] !== null && isDeniedOutlet(OUTLET_MAP[name]));
    if (allowed) {
      if (!switchable.includes(name)) switchable.push(name);
    } else if (!rejected.includes(name)) {
      rejected.push(name);
    }
  }
  return { switchable, rejected };
}

function parseBaseUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:' || !url.hostname) return null;
    return url.origin;
  } catch (_) {
    return null;
  }
}

function readPowerConfig(env) {
  const source = env || {};
  const { switchable, rejected } = parseSwitchable(source.POWER_OUTLETS_SWITCHABLE);
  if (rejected.length) {
    console.warn(`[es-mini-agent] power: POWER_OUTLETS_SWITCHABLE ignored ${rejected.join(',')} (never software-switched or unknown)`);
  }
  const username = typeof source.POWER_STRIP_USER === 'string' ? source.POWER_STRIP_USER : '';
  const password = typeof source.POWER_STRIP_PASS === 'string' ? source.POWER_STRIP_PASS : '';
  return {
    baseUrl: parseBaseUrl(source.POWER_STRIP_URL),
    credentials: username ? { username, password } : null,
    switchable,
    rejected,
  };
}

// The diag block. Config only: no strip I/O and never a credential.
function describePower(config) {
  const current = config || {};
  return {
    configured: !!current.baseUrl,
    auth: current.credentials ? 'configured' : 'none',
    outlets: Object.assign({}, OUTLET_MAP),
    switchable: Array.isArray(current.switchable) ? current.switchable.slice() : [],
    rejected: Array.isArray(current.rejected) ? current.rejected.slice() : [],
  };
}

function outcomeOf(result) {
  if (!result) return 'error';
  if (result.timedOut) return 'timeout';
  if (result.statusCode >= 200 && result.statusCode < 300) return 'ok';
  if (result.statusCode === 401) return result.attempted ? 'auth_failed' : 'auth_required';
  return Number.isInteger(result.statusCode) ? `http_${result.statusCode}` : 'unreachable';
}

function parseJsonBody(body) {
  if (typeof body !== 'string') return undefined;
  try { return JSON.parse(body); } catch (_) { return undefined; }
}

function createStripClient(config, options) {
  const request = options && typeof options.request === 'function' ? options.request : requestWithDigest;
  const timeoutMs = (options && options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const credentials = config.credentials || {};

  const call = async (method, restPath, body) => {
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') {
      headers['X-CSRF'] = 'x';
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    let result;
    try {
      result = await request({
        url: `${config.baseUrl}${restPath}`,
        method,
        headers,
        body: typeof body === 'string' ? body : null,
        username: credentials.username,
        password: credentials.password,
        timeoutMs,
        includeBody: true,
      });
    } catch (_) {
      result = null;
    }
    return { outcome: outcomeOf(result), data: parseJsonBody(result && result.body) };
  };

  return {
    // GET, not HEAD: the strip's health check is a real read of every relay.
    async readAll() {
      const states = await call('GET', '/restapi/relay/outlets/all;/physical_state/');
      if (states.outcome !== 'ok') return { outcome: states.outcome };
      if (!Array.isArray(states.data) || !states.data.every((v) => typeof v === 'boolean')) {
        return { outcome: 'bad_response' };
      }
      const names = await call('GET', '/restapi/relay/outlets/all;/name/');
      const labels = Array.isArray(names.data) && names.data.length === states.data.length ? names.data : null;
      return { outcome: 'ok', states: states.data, labels };
    },
    async readOne(outlet) {
      const res = await call('GET', `/restapi/relay/outlets/${outlet - 1}/physical_state/`);
      return typeof res.data === 'boolean' ? res.data : null;
    },
    async write(outlet, on) {
      // Last line of defence: whatever the tables above say, outlets 1-3 are
      // never written. A future edit that maps a name onto them fails here.
      if (!Number.isInteger(outlet) || outlet < 1 || outlet > 8 || isDeniedOutlet(outlet)) {
        return 'outlet_denied';
      }
      const res = await call('PUT', `/restapi/relay/outlets/${outlet - 1}/transient_state/`, `value=${on ? 'true' : 'false'}`);
      return res.outcome;
    },
  };
}

function resolveTargets(action, requested, switchable) {
  let names;
  if (requested === undefined || requested === null) {
    if (action !== 'status') return { error: 'outlets_required' };
    names = switchable.slice();
  } else if (requested === 'all') {
    names = switchable.slice();
  } else if (Array.isArray(requested)) {
    if (requested.length === 0) return { error: 'outlets_required' };
    if (requested.length > MAX_OUTLETS_PER_REQUEST) return { error: 'too_many_outlets' };
    names = [];
    for (const item of requested) {
      if (typeof item !== 'string' || !normalizeName(item)) return { error: 'outlet_name_invalid' };
      const name = normalizeName(item);
      if (!names.includes(name)) names.push(name);
    }
  } else {
    return { error: 'outlets_invalid' };
  }

  if (names.length === 0 && action !== 'status') return { error: 'no_switchable_outlets' };

  for (const name of names) {
    const known = Object.prototype.hasOwnProperty.call(OUTLET_MAP, name);
    if (action === 'status') {
      if (!known) return { error: 'unknown_outlet', outlet: name };
      continue;
    }
    if (isDeniedName(name) || (known && OUTLET_MAP[name] !== null && isDeniedOutlet(OUTLET_MAP[name]))) {
      return { error: 'outlet_denied', outlet: name };
    }
    if (!known) return { error: 'unknown_outlet', outlet: name };
    if (!switchable.includes(name)) return { error: 'outlet_not_switchable', outlet: name };
    if (OUTLET_MAP[name] === null) return { error: 'outlet_unmapped', outlet: name };
  }
  return { names };
}

async function status(client, names) {
  const all = await client.readAll();
  if (all.outcome !== 'ok') return { ok: false, action: 'status', reason: all.outcome };
  const outlets = {};
  for (const name of names) {
    const outlet = OUTLET_MAP[name];
    if (outlet === null) {
      outlets[name] = { outlet: null, on: null, note: 'not_on_strip' };
      continue;
    }
    const on = outlet <= all.states.length ? all.states[outlet - 1] : null;
    const label = all.labels && typeof all.labels[outlet - 1] === 'string' ? all.labels[outlet - 1] : null;
    outlets[name] = { outlet, on, label };
  }
  return { ok: true, action: 'status', outlets };
}

async function switchOutlets(client, action, names) {
  const on = action === 'on';
  const outlets = {};
  let ok = true;
  for (const name of names) {
    const outlet = OUTLET_MAP[name];
    const outcome = await client.write(outlet, on);
    const readBack = outcome === 'ok' ? await client.readOne(outlet) : null;
    outlets[name] = { outlet, result: outcome, on: readBack };
    if (outcome !== 'ok') ok = false;
    console.log(`[es-mini-agent] power: ${action} ${name}(${outlet}) -> ${outcome}${readBack === null ? '' : ` physical=${readBack ? 'on' : 'off'}`}`);
  }
  return { ok, action, outlets };
}

// payload: { action: 'status'|'on'|'off', outlets?: string[] | 'all' }
// context: { recording, uploading } — `off` is refused while either is true.
async function runPower(config, payload, context, options) {
  const current = config || {};
  const body = payload && typeof payload === 'object' ? payload : {};
  const action = typeof body.action === 'string' ? body.action.trim().toLowerCase() : 'status';
  if (action !== 'status' && action !== 'on' && action !== 'off') {
    return { ok: false, reason: 'unknown_action', action };
  }

  const switchable = Array.isArray(current.switchable) ? current.switchable : [];
  const targets = resolveTargets(action, body.outlets, switchable);
  if (targets.error) {
    const out = { ok: false, action, reason: targets.error };
    if (targets.outlet) out.outlet = targets.outlet;
    if (targets.error === 'outlet_denied') {
      console.warn(`[es-mini-agent] power: refused ${action} ${targets.outlet} (never software-switched)`);
    }
    return out;
  }

  if (action === 'off') {
    const ctx = context || {};
    if (ctx.recording) return { ok: false, action, reason: 'busy_recording' };
    if (ctx.uploading) return { ok: false, action, reason: 'busy_uploading' };
  }

  if (!current.baseUrl) return { ok: false, action, reason: 'power_unconfigured' };

  const client = createStripClient(current, options);
  if (action === 'status') return await status(client, targets.names);
  return await switchOutlets(client, action, targets.names);
}

module.exports = {
  DEFAULT_SWITCHABLE,
  OUTLET_MAP,
  createStripClient,
  describePower,
  isDeniedName,
  parseSwitchable,
  readPowerConfig,
  runPower,
};
