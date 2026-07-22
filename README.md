# es-mini-agent

**This agent proves the app-to-Mini connection is real. It now supports optional OBS Source Record control while keeping the existing in-memory demo mode as the default fallback.**

Small zero-dependency Node HTTP service that runs on a FLEET Mac Mini (or a bench-test Mac standing in for one). The Vercel proxy at `es-os-app/api/record.js` forwards `/record/{start|stop|status|pause|resume}` calls here once `RECORD_CONTROL_URL` and `RECORD_CONTROL_KEY` are set on Vercel. If OBS env vars are omitted, the legacy demo/mock path remains unchanged.

## Requirements

- Node.js `>=22` (uses only built-ins, including the stable global `WebSocket` client for OBS control).

## Install

Nothing to install. `npm install` is a no-op (no dependencies).

## Configure

Core + optional env vars:

| var                  | required | example                       | notes |
|----------------------|----------|-------------------------------|-------|
| `PORT`               | no       | `8787`                        | default `8787` |
| `RECORD_CONTROL_KEY` | **yes**  | long random string            | must match the value set on Vercel; agent refuses to start if unset |
| `BUILDING_ID`        | **yes**  | `bench-1`                     | this Mini's identity; one Mini serves exactly one building |
| `OBS_WS_URL`         | no       | `ws://127.0.0.1:4455`         | optional — enables real OBS control; omit for demo mode |
| `OBS_WS_PASSWORD`    | no       | `(empty)`                     | optional — enables real OBS control; omit for demo mode |
| `OBS_SOURCES`        | no       | `cam1,cam2`                   | optional — enables real OBS control; omit for demo mode |
| `OBS_RECORD_DIR`     | no       | `~/es-mini-obs-recordings`    | optional in demo mode; required when `OBS_SOURCES` is set |

Copy `.env.example` for local dev, or edit the `EnvironmentVariables` dict in `com.es.mini-agent.plist` for launchd.

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
- Uploads are resumable across agent restarts via `.r2-uploads/*.state.json`
- Upload part transfer pauses while a recording is active and resumes when recording stops
- Recording files are never deleted from the Mac mini by this upload path
- Failed uploads are logged in `agent.log` and surfaced again during boot sweep; failed states are left in place and are not auto-retried

## Contract (what the Vercel proxy expects back)

- `start`, `status`, `resume` → `{ ok, recording, feeds_writing }` (demo mode keeps `feeds_writing: null`; OBS mode reports a verified count when recording and `0` when idle)
- `stop` → `{ ok, saved }`
- `pause` → `{ ok, paused }`

Request body from the proxy: `{ building_id, client_code }`. Auth: `Authorization: Bearer <RECORD_CONTROL_KEY>`.

## OBS control (optional)

- Requires OBS Studio 28+ (obs-websocket v5 is built in). Enable/configure it in **Tools -> obs-websocket Settings** (port/password must match env vars here).
- Requires exeldro's **Source Record** plugin installed, with a Source Record filter added to each source listed in `OBS_SOURCES`.
- For `feeds_writing` detection to work, each source's Source Record filter **Path** must be set to `<OBS_RECORD_DIR>/<sourceName>/` (example: source `cam1` writes to `<OBS_RECORD_DIR>/cam1/`).
- If `OBS_SOURCES` is unset/empty, the agent stays in demo mode (same in-memory behavior as before).

## Install as a launchd LaunchAgent (auto-start + auto-restart)

1. Edit `com.es.mini-agent.plist`:
   - Replace `REPLACE_ME_WITH_REAL_SECRET` with the same secret you set on Vercel.
   - Replace `REPLACE_ME_e_g_bench-1` with this Mini's `BUILDING_ID`.
   - Confirm the `ProgramArguments` node path matches `which node` on this Mac. On Apple Silicon w/ Homebrew it is typically `/opt/homebrew/opt/node@24/bin/node`.

2. Install and load:

   ```bash
   cp com.es.mini-agent.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.es.mini-agent.plist
   ```

3. Tail logs:

   ```bash
   tail -f ~/Documents/es-mini-agent/agent.log \
           ~/Documents/es-mini-agent/agent.error.log
   ```

4. Reload after edits:

   ```bash
   launchctl unload ~/Library/LaunchAgents/com.es.mini-agent.plist
   launchctl load   ~/Library/LaunchAgents/com.es.mini-agent.plist
   ```

5. Stop for good:

   ```bash
   launchctl unload ~/Library/LaunchAgents/com.es.mini-agent.plist
   ```

`KeepAlive: true` means launchd restarts the process if it crashes — the "self-recovery agent" behavior the FLEET docs describe. `RunAtLoad: true` starts it immediately on load / on user login.

## What this agent explicitly does NOT do (yet)

- No direct control of physical camera/audio hardware outside OBS itself.
- No file writing of media.
- No persistence — state (`recording`, `paused`) is in-memory only and resets on restart. That is intentional for the bench-test phase.

Those come in a follow-up track once the physical studio rig exists.
