## Build 45 part 1 (Mini, agent 2026.10.26-2): mic route check, look settle time, durable upload-notice retry

Plan: `ab-wiki/Clients/ES/docs/build45-phone-looks-readiness-mic-build-plan-2026-10-26.md` (A5, A6, A8). Based on `947a060` (watch-copy retry), which is based on #24 `9ba2f22`. The live Mini reports agent version `2026.10.20-1`, but its `agent_commit` comes from a persistent update-state file and does not prove the installed source SHA. Merge #24 first.

- **A6 mic route** (`audio-check.js`):
  - Every live check since 10-20 said `mic_not_recorded` on all four mics, while the master held four healthy tracks. The check assumed Mic N is on track N.
  - It now follows each mic's enabled tracks (`GetInputAudioTracks` "1".."6") into `RecTracks` (`parameterValue`, then `defaultParameterValue`).
  - An unknown side is `null`, never `mic_not_recorded`. A mic on no recorded track still flags.
  - Each mic reports `route: { tracks, rec_tracks }`.
  - The heartbeat builder moved to `heartbeat-state.js`. Its worst case is 1687 bytes, under the Worker's 2048-byte cap.
- **A5 look settle** (`ptz.js`):
  - A successful look returns `settle_ms` (`LOOK_SETTLE_MS`, default 4000, clamped 0–15000), `settled_at` and `elapsed_ms`.
  - It does **not** wait, because the agent runs one command at a time and the Worker gives a look 6.5 s.
- **A8 upload-notice outbox** (`webhook-outbox.js`, `storage-upload.js`, `upload-queue.js`):
  - A failed `upload_confirmed`, failed-camera or watch-failed notice goes to `<UPLOAD_STATE_DIR>/webhook-outbox.json`. It is retried at 1, 5, 15 and 60 min, then hourly, for 48 h. It survives restarts.
  - The exact body is re-sent, so the shim's idempotency key matches.
  - The heartbeat carries `webhook_pending: { count, oldest_age_s }`.
  - The webhook URL (`?key=`) is never written to disk or logged. The old code logged response bodies that could echo it; that is fixed.
  - Given-up notices now schedule their own 7-day expiry, so `webhook_pending` clears without another upload. A synchronous no-op flush also releases its in-flight guard, allowing later retries and pruning.
- **Upload state ordering** (`upload-queue.js`): the worker waits for the queued state write before processing a file. A 0-byte master could previously finish and delete its state while that write was still in flight, leaving a stale state file after the take.
- **Exact-take Stop recovery** (`server.js`): idle status retains the stopped take's `session_ref` with its save and file-health result. The app relay only accepts this as proof of Saved when the phone requests that same take, and it strips local file paths. This does not change the installed mic-only patch.
- **Version** `2026.10.26-2`. `modules.txt` gains `heartbeat-state.js` and `webhook-outbox.js`, and a new test follows every `require` from `server.js`.

Install **after** the honeybook shim (idempotency key) is live. Never via the `update` op until this and #24 are on `main`.

Audit tests: the initial parallel full suite ran 191 tests: 185 passed, 5 failed, 1 skipped. Four failures were timing-sensitive PTZ/RTSP assertions under concurrent load; PTZ passed 11/11 isolated and RTSP passed 23/23 on five isolated runs. The fifth failure exposed the queued-state write race fixed above. After the fix, the zero-byte upload suite passed 6/6, webhook retry suite 7/7, adjacent upload/watch-copy suite 5/5, and exact-take status test passed. The final serial full suite passed 191 of 192 tests with 1 skip and 0 failures in 268.7 seconds. CI review and a live install still remain.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
