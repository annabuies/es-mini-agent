'use strict';

const fs = require('node:fs/promises');

/**
 * Read filesystem capacity for a directory. Disk telemetry is best-effort and
 * must never make the agent fail to start or poll.
 */
async function sampleDiskUsage(dir) {
  try {
    const stats = await fs.statfs(dir);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    if (!Number.isFinite(freeBytes) || freeBytes < 0
      || !Number.isFinite(totalBytes) || totalBytes < 0) return null;
    return {
      free_bytes: freeBytes,
      total_bytes: totalBytes,
      checked_at: new Date().toISOString(),
    };
  } catch (_) {
    return null;
  }
}

module.exports = { sampleDiskUsage };
