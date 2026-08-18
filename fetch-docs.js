'use strict';

// Read-only retrieval of operator write-ups from the Mini's ~/Downloads.
//
// Why this exists: Claude Code sessions run ON the studio Mini and leave their
// incident write-ups in that machine's Downloads folder (e.g. the 2026-08-18
// camera/DHCP outage report). The Mini is outbound-only — no SSH, no inbound
// port — so without this op the only way to read such a file is a human at
// that keyboard. This op returns the newest text documents through the same
// record-command queue every other operator op already uses.
//
// Security posture, in the same spirit as self-update.js:
//   * NO INPUT. The poll path calls handleOp(cmd.op, {}) with a hardcoded empty
//     body and the queue has no args column, so nothing remote can name a path.
//     The op reads only ~/Downloads, only basenames readdir itself returned —
//     traversal is impossible by construction.
//   * TEXT DOCUMENTS ONLY (.md / .txt). Never media, never archives, never
//     dotfiles. Symlinks are skipped so a link in Downloads cannot make this
//     read a file that lives elsewhere.
//   * BOUNDED. At most MAX_DOCS files, MAX_DOC_BYTES per file and
//     MAX_TOTAL_BYTES overall, so the result row stays a sane jsonb payload no
//     matter what accumulates in Downloads.
//   * READ-ONLY and side-effect free: cannot touch OBS, recordings, uploads, or
//     any agent state, so it is always safe to queue — even mid-session.

const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const DOC_NAME_RE = /^[^.].*\.(md|txt)$/i;
const MAX_DOCS = 5;
const MAX_DOC_BYTES = 60 * 1024;
const MAX_TOTAL_BYTES = 150 * 1024;
const MAX_LISTING = 30;
const OP_TIMEOUT_MS = 10 * 1000;

// HARD DEADLINE on the whole op. Learned 2026-08-18 the expensive way: on a
// Mac, ~/Downloads is TCC-protected, and a launchd process without the grant
// can BLOCK inside readdir while macOS waits on a consent dialog nobody is
// there to click. The first fetch_docs ever queued did exactly that and wedged
// the poll loop (its reentry guard stays set while handleOp is in flight), so
// the studio's whole remote record control went dark until a restart. An op may
// fail; it may never hang the loop. The underlying fs promise is left pending
// on timeout — that is fine, the loop must move on.
function fetchDocs(opts) {
  return Promise.race([
    fetchDocsInner(opts),
    new Promise((resolve) => {
      const t = setTimeout(() => resolve({
        ok: false,
        reason: 'downloads_timeout',
        detail: 'read did not finish in ' + OP_TIMEOUT_MS + 'ms — likely the macOS Downloads privacy (TCC) grant is missing for the agent. Grant Files and Folders / Full Disk Access to node on the Mini, then retry.',
      }), OP_TIMEOUT_MS);
      t.unref();
    }),
  ]);
}

// opts.dirOverride exists for tests only; the agent always calls fetchDocs().
async function fetchDocsInner(opts) {
  const dir = (opts && opts.dirOverride) || path.join(os.homedir(), 'Downloads');

  let names;
  try {
    names = await fsp.readdir(dir);
  } catch (e) {
    return { ok: false, reason: 'downloads_unreadable', detail: String(e && (e.message || e)).slice(0, 300) };
  }

  const candidates = [];
  for (const name of names) {
    if (!DOC_NAME_RE.test(name)) continue;
    let st;
    try {
      st = await fsp.lstat(path.join(dir, name));
    } catch (_) {
      continue; // vanished between readdir and lstat — not worth failing the op
    }
    if (!st.isFile()) continue; // skips symlinks too: lstat never follows
    candidates.push({ name, size: st.size, mtime: st.mtime.toISOString(), mtimeMs: st.mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const listing = candidates.slice(0, MAX_LISTING).map(({ name, size, mtime }) => ({ name, size, mtime }));

  const docs = [];
  let totalBytes = 0;
  for (const entry of candidates.slice(0, MAX_DOCS)) {
    if (totalBytes >= MAX_TOTAL_BYTES) break;
    const budget = Math.min(MAX_DOC_BYTES, MAX_TOTAL_BYTES - totalBytes);
    let fh;
    let content;
    let truncated;
    try {
      fh = await fsp.open(path.join(dir, entry.name), 'r');
      const buf = Buffer.alloc(budget);
      const { bytesRead } = await fh.read(buf, 0, budget, 0);
      content = buf.slice(0, bytesRead).toString('utf8');
      truncated = entry.size > bytesRead;
      totalBytes += bytesRead;
    } catch (e) {
      docs.push({ name: entry.name, error: String(e && (e.message || e)).slice(0, 200) });
      continue;
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
    docs.push({ name: entry.name, size: entry.size, mtime: entry.mtime, truncated, content });
  }

  return { ok: true, dir, doc_count: candidates.length, listing, docs };
}

module.exports = { fetchDocs };
