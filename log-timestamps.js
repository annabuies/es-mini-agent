'use strict';

const util = require('node:util');

const INSTALL_STATE = Symbol.for('es-mini-agent.console-timestamps-installed');
const ISO_PREFIX_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z(?:\s|$)/;
const AGENT_TAG = '[es-mini-agent]';
const METHODS = ['log', 'info', 'warn', 'error'];

function prefixLine(line, timestamp) {
  if (ISO_PREFIX_RE.test(line)) return line;
  if (line === AGENT_TAG || line.startsWith(AGENT_TAG + ' ')) {
    return `${timestamp} ${line}`;
  }
  return `${timestamp} ${AGENT_TAG}${line ? ' ' + line : ''}`;
}

function installConsoleTimestamps(options = {}) {
  const target = options.console || console;
  if (target[INSTALL_STATE]) return false;

  const now = typeof options.now === 'function' ? options.now : () => new Date();
  // launchd sends stdout to agent.log and stderr to agent.error.log, and agent.log
  // is the one people read. On Sep 29 every RTSP fallback and reconnect warning
  // went only to agent.error.log, so the fallback looked silent (es-mini-agent #10).
  // With teeWarnings, warn/error lines are written to both.
  const teeWarnings = !!options.teeWarnings;
  const originalLog = target.log;
  Object.defineProperty(target, INSTALL_STATE, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  for (const method of METHODS) {
    const original = target[method];
    if (typeof original !== 'function') continue;
    target[method] = function timestampedConsoleMethod(...args) {
      const timestamp = now().toISOString();
      const rendered = util.format(...args);
      for (const line of rendered.split('\n')) {
        const out = prefixLine(line, timestamp);
        original.call(target, out);
        if (teeWarnings && (method === 'warn' || method === 'error') && typeof originalLog === 'function') originalLog.call(target, out);
      }
    };
  }

  return true;
}

module.exports = { installConsoleTimestamps };
