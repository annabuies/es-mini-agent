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
| `OBS_WS_URL`         | no       | `ws://127.0.0.1:4455`         | optional — enables real OBS control; omit for demo mode |
| `OBS_WS_PASSWORD`    | no       | `(empty)`                     | optional — enables real OBS control; omit for demo mode |
| `OBS_SOURCES`        | no       | `cam1,cam2`                   | optional — enables real OBS control; omit for demo mode |
| `OBS_RECORD_DIR`     | no       | `~/es-mini-obs-recordings`    | optional in demo mode; required when `OBS_SOURCES` is set |
| `MASTER_RECORD`      | no       | `1`                           | defaults to `1` when `OBS_SOURCES` is set; use `0` to disable the OBS main recording rollback |
| `AUDIO_SPLIT`        | no       | `1` with master recording     | split confirmed master audio tracks; use `0` to keep the master but skip mic files |
| `POWER_STRIP_URL`    | no       | `http://172.16.1.40`          | Digital Loggers Pro 10 (`studio-power`); unset → `power` op answers `power_unconfigured` |
| `POWER_STRIP_USER` / `POWER_STRIP_PASS` | no | `(empty)`             | strip digest login; lives only in the live plist on this Mini, never in git |
| `POWER_OUTLETS_SWITCHABLE` | no | `lights`                       | comma-separated; only `lights` / `evo` accepted, `router` / `poe` / `mini` / `nas` refused in code |
| `RTSP_CAPTURE_SOURCES` | no     | `cam1`                        | cameras recorded by `ffmpeg -c copy` from their RTSP stream instead of Source Record. Unset or `off` → Source Record for every camera (default). Master/audio stay on OBS |
| `RTSP_URL_CAM1` / `_CAM2` / `_CAM3` | with the above | `rtsp://user:pass@<camera-ip>:554/1` | one per listed camera (`RTSP_URL_<SOURCE>`); carries the camera login, lives only in the live plist; never logged |
| `RTSP_TRANSPORT`     | no       | `tcp`                         | `tcp` (default) or `udp` |
| `RTSP_AUDIO`         | no       | `0`                           | `copy` keeps the camera's own audio track; default video only (studio mics are in master + `audio/micN`) |
| `RTSP_VIDEO_TAG`     | no       | `hvc1`                        | set `hvc1` for H.265 cameras so QuickTime plays the ISO file; leave empty for H.264 |
| `RECORDING_PROBE_GATE` | no     | `1`                           | `0` turns off the zero-stream upload gate (rollback only) |

### RTSP stream-copy camera capture (opt-in)

For each camera in `RTSP_CAPTURE_SOURCES` the agent skips that camera's Source Record calls and runs one `ffmpeg -rtsp_transport tcp -i <url> -map 0:v:0 -c copy` per take, writing fragmented MP4 to `<OBS_RECORD_DIR>/<cam>/<YYYY-MM-DD hh-mm-ss>.mp4` (the OBS naming, so uploads and `feeds_writing` are unchanged). Nothing is encoded on the Mini. Start fails with `rtsp_start_failed` (and rolls the OBS cameras and master back) if a camera does not deliver data within 10 s. Limits: stream copy cannot pause, so an RTSP file keeps recording through a pause and the stop result lists the paused spans (`rtsp[].paused_spans_s`) for the edit; the file starts at the camera's first keyframe, so it is not frame-aligned with master.

Before upload every camera and master recording is probed with `ffprobe`. A file with zero streams (or one ffprobe cannot read that is under 64 KiB) is not uploaded: it moves to `<cam>/quarantine/` and a camera is reported with the existing `sizeBytes: 0` "recording failed" webhook plus `invalid`, `file_size_bytes`, `streams`.

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
- `stop` → `{ ok, saved }`
- `pause` → `{ ok, paused }`
- `look` → `{ ok, look, cameras: { cam1: 'ok'|'timeout'|'http_<code>'|'auth_required'|'error' }, reason? }`

`look` requests include `{ building_id, look }`. The agent refuses look changes while a take is recording or paused or while the upload queue is draining, recalls mapped cameras in parallel with a three-second timeout per camera, and never moves a camera omitted from the selected look. Auth: `Authorization: Bearer <RECORD_CONTROL_KEY>`.

`PTZ_HTTP_USER` and `PTZ_HTTP_PASS` are read (HTTP digest auth for preset recall and camera settings). They live in the env block of the **live** LaunchAgent plist, `~/Library/LaunchAgents/com.es.mini-agent.plist`. The copy that used to sit in `~/Documents/es-mini-agent/` was an env-less template, not the live file (the installer removes it since 2026.09.27-2). Camera HTTP paths are under `/cgi-bin/` (`/cgi-bin/param.cgi`, `/cgi-bin/ptzctrl.cgi`); the bare `/param.cgi` returns 404.

PTZ look support was rebased onto `10fa9a8` on 2026-09-05.

- `power` → `{ ok, action, outlets: { lights: { outlet, on, label?, result? } }, reason? }`

`power` requests carry `{ action: 'status'|'on'|'off', outlets?: string[] | 'all' }`. `status` defaults to every switchable outlet and may also read (never write) `router`, `poe` and `mini`; `on`/`off` require an explicit list or `'all'` (= every switchable outlet). Outlet map on the strip: 1 Router, 2 PoE, 3 Mini, 4 Lights, 5–8 spare; `evo` and `nas` are known names with no outlet. Router, PoE, Mini and NAS (plus aliases and outlets 1–3 by number) are refused with `outlet_denied` no matter what the env says; `off` is refused while recording/paused (`busy_recording`) or uploading (`busy_uploading`). Writes use the DLI REST `transient_state` so the strip's own power-loss restore (all on) always wins after a reboot. `diag.power` reports `{ configured, auth, outlets, switchable, rejected, health }`. When `POWER_STRIP_URL` is set the agent reads the relay states every 5 minutes (a GET, never a write) and reports `{ ok, reason, lights_on, fail_count, checked_at }` as `health` and as `power` in the heartbeat; es-fleet-heartbeat posts to #os after two failed checks in a row.

A 0-byte recording file is never uploaded (S3 multipart needs at least one byte). A camera file is reported through the normal `upload_confirmed` webhook with `sizeBytes: 0`, which the cloud posts as a failed recording; audio/master files are only logged. Upload states left by the old `runMultipartUpload requires sizeBytes` failure are dropped on the next sweep.

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
