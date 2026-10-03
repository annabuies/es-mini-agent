# es-mini-agent

**This agent proves the app-to-Mini connection is real. It now supports optional OBS Source Record control while keeping the existing in-memory demo mode as the default fallback.**

Small zero-dependency Node HTTP service that runs on a FLEET Mac Mini (or a bench-test Mac standing in for one). The Cloudflare Worker at `api.evrybdystudios.com` (`es-os-app`) forwards record and PTZ look commands here once `RECORD_CONTROL_KEY` is set. If OBS env vars are omitted, the legacy demo/mock recording path remains unchanged; PTZ look recall remains available from remotely supplied building config.

## Requirements

- Node.js `>=22` (uses only built-ins, including the stable global `WebSocket` client for OBS control).

## Install

Nothing to install. `npm install` is a no-op (no dependencies).

## Configure

Core + optional env vars:

| var                  | required | example                       | notes |
|----------------------|----------|-------------------------------|-------|
| `PORT`               | no       | `8787`                        | default `8787` |
| `RECORD_CONTROL_KEY` | **yes**  | long random string            | must match the value set on the Cloudflare Worker `es-os-app` (`api.evrybdystudios.com`); agent refuses to start if unset |
| `BUILDING_ID`        | **yes**  | `bench-1`                     | this Mini's identity; one Mini serves exactly one building |
| `RECORD_POLL_URL`    | no       | `https://api.evrybdystudios.com` | outbound OS record poll host; persisted by `install.sh` so a reinstall cannot fall back to Vercel |
| `POLL_INTERVAL_MS`   | no       | `250`                         | command poll interval while the room is in use (a take is running, or a command came in during the last 2 minutes); minimum `100`. Not written by `install.sh` |
| `POLL_IDLE_INTERVAL_MS` | no    | `1000`                        | command poll interval when the room is idle; never below `POLL_INTERVAL_MS`. Not written by `install.sh` |
| `OBS_WS_URL`         | no       | `ws://127.0.0.1:4455`         | optional — enables real OBS control; omit for demo mode |
| `OBS_WS_PASSWORD`    | no       | `(empty)`                     | optional — enables real OBS control; omit for demo mode |
| `OBS_SOURCES`        | no       | `cam1,cam2`                   | optional — enables real OBS control; omit for demo mode |
| `OBS_RECORD_DIR`     | no       | `~/es-mini-obs-recordings`    | optional in demo mode; required when `OBS_SOURCES` is set |
| `MASTER_RECORD`      | no       | `1`                           | defaults to `1` when `OBS_SOURCES` is set; use `0` to disable the OBS main recording rollback |
| `AUDIO_SPLIT`        | no       | `1` with master recording     | split confirmed master audio tracks; use `0` to keep the master but skip mic files |
| `POWER_STRIP_URL`    | no       | `http://172.16.1.40`          | Digital Loggers Pro 10 (`studio-power`); unset → `power` op answers `power_unconfigured` |
| `POWER_STRIP_USER` / `POWER_STRIP_PASS` | no | `(empty)`             | strip digest login; lives only in the live plist on this Mini, never in git |
| `POWER_OUTLETS_SWITCHABLE` | no | `lights`                       | comma-separated; only `lights` / `evo` accepted, `router` / `poe` / `mini` / `nas` refused in code |

Set these variables in your shell for local development. For launchd, pass them to `install.sh`; it generates the live plist at `~/Library/LaunchAgents/com.es.mini-agent.plist`.

## Fleet heartbeat

The normal authenticated command poll includes a non-blocking heartbeat at most once per minute. It reports the agent release and self-update commit plus bounded recording, upload, and master state; it uses the existing poll URL and needs no new Mini environment variable. A cloud endpoint that has not yet received the matching database migration ignores these query parameters, so staged rollout leaves command polling unchanged.

## Run locally (quick bench test)

```bash
RECORD_CONTROL_KEY=devsecret BUILDING_ID=bench-1 node server.js
```

### curl examples

Health (no auth):

```bash
curl -s http://localhost:8787/health | jq
```

Start / status / pause / resume / stop (all require the bearer token):

```bash
KEY=devsecret
BID=bench-1

curl -s -X POST http://localhost:8787/record/start \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"building_id\":\"$BID\",\"client_code\":\"abc123\"}"

curl -s -X POST http://localhost:8787/record/status \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"building_id\":\"$BID\",\"client_code\":\"abc123\"}"

curl -s -X POST http://localhost:8787/record/pause \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"building_id\":\"$BID\",\"client_code\":\"abc123\"}"

curl -s -X POST http://localhost:8787/record/resume \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"building_id\":\"$BID\",\"client_code\":\"abc123\"}"

curl -s -X POST http://localhost:8787/record/stop \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"building_id\":\"$BID\",\"client_code\":\"abc123\"}"
```

Unauthorized should look like:

```bash
curl -s -X POST http://localhost:8787/record/start -d '{}'
# -> {"ok":false,"reason":"unauthorized"}
```

Wrong building should look like:

```bash
curl -s -X POST http://localhost:8787/record/start \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"building_id":"some-other-building"}'
# -> {"ok":false,"reason":"building_mismatch"}
```

## R2 dummy-upload test (optional, proves the upload pipeline without cameras)

These endpoints trigger a synthetic multipart upload to Cloudflare R2 so you can validate the "upload + confirmation" half of the pipeline without OBS or camera hardware.

- `POST /r2test/start` starts a background multipart upload test and returns immediately with `{ ok, testId, key }`.
- `GET /r2test/status?testId=<id>` returns the current in-memory progress for that test.
- `POST /r2test/abort` marks a test as aborted and asks the uploader loop to stop at the next safe part boundary.

Example:

```bash
KEY=devsecret

# start fresh test (300MB default)
curl -s -X POST http://localhost:8787/r2test/start \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{}'

# optional resume flow: reuse the same key after restart
curl -s -X POST http://localhost:8787/r2test/start \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"resume":true,"key":"bench-r2-test/bench-1_1752580000000.bin"}'

# poll status
curl -s "http://localhost:8787/r2test/status?testId=<TEST_ID>" \
  -H "Authorization: Bearer $KEY"

# abort
curl -s -X POST http://localhost:8787/r2test/abort \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"testId":"<TEST_ID>"}'
```

The uploader automatically pauses whenever a real recording is active (`state.recording === true`) and resumes after recording stops, and successful tests delete their own R2 test object afterward.

## On-stop recording upload (R2)

When R2 credentials are configured (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT`), real OBS recordings are automatically enqueued for upload on every `stop` call.

- Object key layout: `recordings/<building_id>/<source>/<filename>`
- Uploads are resumable across agent restarts via `.r2-uploads/*.state.json` (directory name kept for compatibility)
- Upload part transfer pauses while a recording is active and resumes when recording stops
- Recording files are never deleted from the Mac mini by this upload path
- Failed uploads are logged in `agent.log` and surfaced again during boot sweep; failed states are left in place and are not auto-retried

## Master recording (Mic 4)

When `OBS_SOURCES` is configured, the agent also controls OBS's main recording by default (`MASTER_RECORD=1`). The master starts, pauses, resumes, stops, and uploads with the three camera Source Record files as `recordings/<building_id>/master/<filename>`. It is an additional artifact: `cam1`, `cam2`, and `cam3` remain the only camera sources.

OBS must be configured with its main recording enabled for tracks 1–4, hybrid MP4 output, and the recording path `<OBS_RECORD_DIR>/master/`. The master’s 360p video is intentionally uploaded without a 1080p proxy. To roll back immediately, set `MASTER_RECORD=0` and reload the agent; that restores camera-only session behavior without changing OBS.

## Audio split (mic files)

After a master upload confirms, the agent probes its audio streams and stream-copies up to four standalone M4A files: `recordings/<building_id>/audio/<master-base>-mic1.m4a` through `mic4.m4a`. These upload as `kind: audio` and `source: mic<N>` with `audio/mp4` content type, so browser playback is available through the member link; no audio is re-encoded and audio jobs do not create proxies. Set `AUDIO_SPLIT=0` and reload the agent to roll back only this split while preserving the master upload.

## Contract (what the Cloudflare Worker expects back)

- `start`, `status`, `resume` → `{ ok, recording, feeds_writing }` (demo mode keeps `feeds_writing: null`; OBS mode reports a verified count when recording and `0` when idle)
- `stop` → `{ ok, saved }`, plus in OBS mode the file check below
- OBS-mode `start` and `status` (recording) also return `cameras: { camN: { capture_mode: 'rtsp'|'source_record', fallback, fallback_reason?, writing? } }` and `fallback_sources: [...]` (cameras configured for RTSP that are on Source Record this take). `feeds_writing` counts RTSP cameras by their files growing on disk. Idle `status` carries `last_take` (the last stop's `saved`, `health`, `files`, `failed_files`, `fallback_sources`).

### Stop: the file check (since 2026.09.30-1)

After stop, every camera file of the take is probed with ffprobe and compared with the master. The kiosk banner and the booking thread should key off this, not off whether a capture ran.

- `files: [{ source, size_bytes, ok, health }]`: every camera file this take wrote. `ok: false` means no usable video.
- `failed_files: [{ source, size_bytes, reason }]`: cameras with no usable file (`reason` is a lowercase slug: `no_file`, `rtsp_no_data`, `too_small`, `empty_file`, `no_video_stream`, `unreadable_file`).
- `health`: `ok`, `degraded` (a camera is more than 2 s shorter than the master beyond its measured resume waits, or RTSP measured more than 2 s of lost footage), `failed` (a camera has no usable file), or `unverified` (no ffprobe / no record dir).
- `saved` is `false` unless `health` is `ok` (or `unverified`) and every stop succeeded.
- `cameras: { camN: { capture_mode, fallback, fallback_reason?, health, reason?, size_bytes, duration_s?, master_duration_s?, short_by_s?, reconnects?, lost_s?, resume_wait_s? } }`, `fallback_sources`, `master: { health, duration_s }`.

The same per-camera fields ride on each file's `upload_confirmed` webhook (`capture_mode`, `fallback`, `fallback_reason`, `health`, `health_reason`, `duration_s`, `master_duration_s`, `short_by_s`, `reconnects`, `lost_s`, `resume_wait_s`, plus `take_health`, `fallback_sources`, `failed_sources`; the master's webhook carries the take-level three). A camera whose file has no usable video, or that wrote no file at all, is reported with `sizeBytes: 0` like an empty file. The agent log has one `[take]` line per stop, `WARN` whenever a camera fell back or the take is not `ok`.
- `pause` → `{ ok, paused }`
- `look` → `{ ok, look, cameras: { cam1: 'ok'|'timeout'|'http_<code>'|'auth_required'|'error' }, reason? }`

`look` requests include `{ building_id, look }`. The agent refuses look changes while a take is recording or paused or while the upload queue is draining, recalls mapped cameras in parallel with a three-second timeout per camera, and never moves a camera omitted from the selected look. Auth: `Authorization: Bearer <RECORD_CONTROL_KEY>`.

`PTZ_HTTP_USER` and `PTZ_HTTP_PASS` are read (HTTP digest auth for preset recall and camera settings). They live in the env block of the **live** LaunchAgent plist, `~/Library/LaunchAgents/com.es.mini-agent.plist`. The copy that used to sit in `~/Documents/es-mini-agent/` was an env-less template, not the live file (the installer removes it since 2026.09.27-2). Camera HTTP paths are under `/cgi-bin/` (`/cgi-bin/param.cgi`, `/cgi-bin/ptzctrl.cgi`); the bare `/param.cgi` returns 404.

PTZ look support was rebased onto `10fa9a8` on 2026-09-05.

- `power` → `{ ok, action, outlets: { lights: { outlet, on, label?, result? } }, reason? }`

`power` requests carry `{ action: 'status'|'on'|'off', outlets?: string[] | 'all' }`. `status` defaults to every switchable outlet and may also read (never write) `router`, `poe` and `mini`; `on`/`off` require an explicit list or `'all'` (= every switchable outlet). Outlet map on the strip: 1 Router, 2 PoE, 3 Mini, 4 Lights, 5–8 spare; `evo` and `nas` are known names with no outlet. Router, PoE, Mini and NAS (plus aliases and outlets 1–3 by number) are refused with `outlet_denied` no matter what the env says; `off` is refused while recording/paused (`busy_recording`) or uploading (`busy_uploading`). Writes use the DLI REST `transient_state` so the strip's own power-loss restore (all on) always wins after a reboot. `diag.power` reports `{ configured, auth, outlets, switchable, rejected, health }`. When `POWER_STRIP_URL` is set the agent reads the relay states every 5 minutes (a GET, never a write) and reports `{ ok, reason, lights_on, fail_count, checked_at }` as `health` and as `power` in the heartbeat; es-fleet-heartbeat posts to #os after two failed checks in a row.

A 0-byte recording file is never uploaded (S3 multipart needs at least one byte). A camera file is reported through the normal `upload_confirmed` webhook with `sizeBytes: 0`, which the cloud posts as a failed recording; audio/master files are only logged. Upload states left by the old `runMultipartUpload requires sizeBytes` failure are dropped on the next sweep.

## RTSP camera capture (stream copy)

A camera whose entry in `studios.fleet_buildings.cameras` has `"capture": "rtsp"` is recorded by ffmpeg straight from its own RTSP stream instead of OBS Source Record (added 2026.09.29-2, after Source Record's silent cam1 failures in issue #10). The video is copied as the camera sends it (H.264, no encode). Camera audio is left out: the bench-1 cameras send an empty AAC track, and an audio stream with no packets makes ffmpeg hold all video in memory until stop. Set `"rtsp_audio": true` on a camera to copy its audio once it carries sound (for example after the mixer is wired into the camera's 3.5 mm input). OBS still records the master and mic tracks and still drives the live preview.

- URL: `rtsp://<host>:554/1` by default (confirmed by Robbie on 2026-09-29: TCP, no login). Optional per-camera keys: `rtsp_path` (e.g. `"/2"`), `rtsp_port`, a full `rtsp_url`, `rtsp_audio`. Never put a password in `rtsp_url`; the table is readable by the app backend.
- Files: the camera's file is named after the take's master file (`cam1/<same name as master>.mp4`), so a take's files still match. A pause ends a segment and resume starts the next; a dropped connection is retried as a new segment after 0.25 s, then 1 s, then every 2 s (up to 20 per take). Segments (`<stamp> rtsp-partN.mp4`, fragmented MP4) are joined at stop, then deleted. Each reconnect and resume logs how long video took to come back. Stop reports reconnect outages as `lost_s` and the expected wait after each resume as `resume_wait_s` (see 2026.10.01-1).
- Safety: a camera is up at Start once ffmpeg reports video reaching the muxer (`-progress` `out_time`), within 8 s. If not, that camera is recorded by Source Record for that take, logged as `WARN FALLBACK camN ... reason=... detail=...` and reported in `fallback_sources` on start, status and stop. (Until 2026.09.30-1 the gate was 4 KiB on disk within 4 s, which a healthy camera with a 3 s GOP missed on 5 of 8 starts.)
- Stall: ffmpeg running with no new video on disk for 12 s logs `STALLED` and the camera stops counting as writing.
- Switching is a data change, picked up within 60 s (next take); no install, no restart. `RTSP_CAPTURE=0` in the plist turns it off on one Mini regardless of the table.
- `status` (while recording) and `diag` include an `rtsp` block: which cameras are on RTSP and, per recording camera, `writing`, `bytes`, `segments`, `restarts`, `paused`.
- Size: three cameras at the Sep 24 measured 32 Mbps are about 43 GB per recorded hour, versus about 24 GB per hour with Source Record (cam1 HEVC ~30 Mbps, cam2/3 ~12 Mbps).

Also since 2026.09.29-2: a camera file under 64 KiB is treated like a 0-byte file (reported as a failed recording with `sizeBytes: 0`, not uploaded). That catches Source Record's 1,737-byte zero-stream stub. The stop path no longer mistakes the upload queue's `*.proxy.mp4` temp file for a take's newest camera file.

### 2026.09.30-2 additions

- **Warnings reach `agent.log`.** launchd sends stdout to `agent.log` and stderr to `agent.error.log`. Every `console.warn` / `console.error` line is now written to both, so `grep WARN agent.log` shows fallbacks, reconnects and file-check failures. On Sep 29 they were only in `agent.error.log`.
- **0.5 s fragments.** RTSP parts are cut every 0.5 s as well as at keyframes (`-frag_duration 500000`). Video reaches disk ~0.2 s after the first keyframe instead of at the second, and a killed ffmpeg loses at most ~0.5 s.
- **Short joins keep every part.** ffmpeg's concat stops at a part whose last fragment was cut off (a SIGKILLed ffmpeg) and still exits 0, silently dropping the later parts. A join under 95% of its parts' bytes now counts as failed, and every part is kept and uploaded.
- **Delete after upload.** Camera and master originals are deleted once S3 holds a copy verified with a HeadObject size match, and only after the proxy or master audio split that reads them has finished. A failed upload keeps the file. `DELETE_AFTER_UPLOAD=0` in the LaunchAgent keeps originals. Three RTSP cameras are about 43 GB per recorded hour against ~100 GB free.
- **Newest-file lookup is recordings only** (`.mp4/.mov/.mkv/.flv/.ts`), so a sidecar or `.DS_Store` in a camera folder can never be taken for the take's file.

### 2026.09.30-3: proxies never run during a take

The proxy step is a software encode (libx264) of each 4K camera file. Until now it started right after each camera upload, up to three at once, and kept running if the next take started. On Sep 30 the three takes that started 40 to 56 s after an all-RTSP take were the ones where RTSP failed to start or dropped mid-take (`Failed reading RTSP data: End of file`); the takes after a long gap or after a small take were clean.

- Proxies run **one at a time**, at low priority (`nice -n 15`).
- A take start **stops a running proxy** before any camera capture starts (`[take] WARN stopped a running proxy encode`), and no proxy starts while a take is recording. The stopped proxy is redone after the take; the original stays on the Mini until its proxy is made.
- Deferred proxies are picked up again by the queue itself (they used to wait for the next agent restart).
- `uploads.proxies_pending` in `status` / `diag` counts proxies still to make.

### 2026.10.01-1: a normal pause no longer pages

A resume reconnects each RTSP camera while the OBS master resumes at once, so video is back ~1.1 s later on bench-1 (connect + first keyframe). That wait used to be added to `lost`, and stop logs `WARN camN saved ... lost=` whenever `lost` reaches 1 s. So every clean pause wrote a WARN that paged (overnight retest, 9/9 takes clean).

- Waiting for video after a resume is **`resume_wait`**, logged at info (`camN video back after 1.1 s (segment 2, resume)`) and reported as `resume_wait_s` on stop and on the webhook. It is not in `lost_s`.
- A resume is expected within **5 s** (healthy starts took up to 4.1 s against a 3 s GOP). A slower resume counts as lost and WARNs (`... resume); a resume is expected within 5.0 s, counted as lost`). A resume whose ffmpeg drops before any video is a reconnect outage counted from the resume.
- The file check allows a camera to be shorter than the master by its `resume_wait_s` on top of the usual 2 s, so many pauses in one take do not turn it `degraded`.
- Unchanged, still WARN: reconnects (`ffmpeg exited mid-take`, `video back after ... reconnect`, `saved ... reconnects=N lost=`), `STALLED`, `FALLBACK`, and `[take] WARN` for any take that is not `ok`.

### 2026.10.03-1: Record and Stop react sooner

Testers saw Record and Stop take 3-5 s to react on the kiosk. Part of that wait is in the agent:

- **Faster command poll while the room is in use.** Every tap waits for the agent's next poll of the Worker. The agent now polls every **250 ms** while a take is running or for 2 minutes after any command (the kiosk sends `preview_start` every 25 s while it shows the studio), and every 1 s as before when the room is idle. That takes the average wait for a tap from ~0.5 s to ~0.13 s. An idle studio makes no more requests than before; a room in use makes 240 a minute instead of 60 (each is one Worker GET plus one Supabase select; the Worker's rate limits apply only to POSTs). The heartbeat is still sent at most once a minute.
- **Failed polls back off.** If the Worker answers with an error, or with `ok: false` (Supabase failed), the next poll waits 1 s, then 2 s, until a poll succeeds. agent.log keeps at most one poll-error line a second, as before.
- **No settle wait when OBS wrote nothing.** Stop and cancel wait (in 0.9 s steps, up to 4) for OBS to finish writing the master and any Source Record camera. A take with only RTSP cameras and no master (`MASTER_RECORD=0`) used to sit through one 0.9 s step anyway; it now skips it. With the master recording, as on bench-1, stop still waits for it exactly as before.
- The agent log's startup line now reads `relay: polling .../api/record every 250ms while the room is in use, 1000ms when idle`.
- Each command's log line says how long the agent took to run it: `relay: claimed stop (<id>) -> posted result (op took 2.4 s)`. The rest of a slow tap is poll wait, the Worker and the kiosk.
- Not changed here, and the larger parts of a slow tap: Record waits until every RTSP camera has video (up to 8 s; healthy starts took up to 4.1 s), and Stop waits for the master file to settle (at least 0.9 s), the RTSP join and the file check before it answers.

## OBS control (optional)

- Requires OBS Studio 28+ (obs-websocket v5 is built in). Enable/configure it in **Tools -> obs-websocket Settings** (port/password must match env vars here).
- Requires exeldro's **Source Record** plugin installed, with a Source Record filter added to each source listed in `OBS_SOURCES`.
- For `feeds_writing` detection to work, each source's Source Record filter **Path** must be set to `<OBS_RECORD_DIR>/<sourceName>/` (example: source `cam1` writes to `<OBS_RECORD_DIR>/cam1/`).
- The OBS main recording path must be `<OBS_RECORD_DIR>/master/` so the four-track master stays alongside the camera recordings.
- If `OBS_SOURCES` is unset/empty, the agent stays in demo mode (same in-memory behavior as before).

## Install as a launchd LaunchAgent (auto-start + auto-restart)

1. Run the installer with the required environment values. It resolves Node, generates the live plist with the full environment block, and loads it:

   ```bash
   BUILDING_ID=bench-1 RECORD_CONTROL_KEY='your-long-secret' ./install.sh
   ```

   Re-run the installer to change launchd environment values. There is deliberately no `com.es.mini-agent.plist` template in the project folder; that stale copy was easy to mistake for the live plist.

2. Tail logs:

   ```bash
   tail -f ~/Documents/es-mini-agent/agent.log \
           ~/Documents/es-mini-agent/agent.error.log
   ```

3. Reload the generated plist manually if needed:

   ```bash
   launchctl unload ~/Library/LaunchAgents/com.es.mini-agent.plist
   launchctl load   ~/Library/LaunchAgents/com.es.mini-agent.plist
   ```

4. Stop for good, or run `./uninstall.sh` to remove both agent LaunchAgents:

   ```bash
   launchctl unload ~/Library/LaunchAgents/com.es.mini-agent.plist
   ```

`KeepAlive: true` means launchd restarts the process if it crashes — the "self-recovery agent" behavior the FLEET docs describe. `RunAtLoad: true` starts it immediately on load / on user login.

## What this agent explicitly does NOT do (yet)

- No direct control of physical camera/audio hardware outside OBS itself.
- No file writing of media.
- No persistence — state (`recording`, `paused`) is in-memory only and resets on restart. That is intentional for the bench-test phase.

Those come in a follow-up track once the physical studio rig exists.
