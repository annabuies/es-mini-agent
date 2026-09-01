# es-mini-agent

**Production Mac Mini agent for EVRYBDY FLEET camera preview and recording.**

This zero-dependency Node service runs on a FLEET Mac Mini, polls the Cloudflare Worker outbound for commands, controls real OBS Source Record filters, and posts results back to the same relay. The Mini needs no inbound tunnel or public port.

## Requirements

- Node.js `>=22` (uses only built-ins, including the stable global `WebSocket` client for OBS control)
- OBS Studio 28+ with obs-websocket enabled
- Source Record filters and directories for every source in `OBS_SOURCES`

## Install

Nothing to install. `npm install` is a no-op (no dependencies).

## Configure

Core + optional env vars:

| var                  | required | example                                    | notes |
|----------------------|----------|--------------------------------------------|-------|
| `PORT`               | no       | `8787`                                     | default `8787` |
| `RECORD_POLL_URL`    | no       | `https://api.evrybdystudios.com`           | permanent Cloudflare target; fallback: `https://es-os-app.crmes.workers.dev` |
| `RECORD_CONTROL_KEY` | **yes**  | long random string                         | must match the Cloudflare Worker secret; agent refuses to start if unset |
| `BUILDING_ID`        | **yes**  | `bench-1`                                  | this Mini's identity; one Mini serves exactly one building |
| `OBS_WS_URL`         | **yes**  | `ws://127.0.0.1:4455`                      | real OBS control endpoint |
| `OBS_WS_PASSWORD`    | as set   | `(secret)`                                 | must match OBS websocket configuration |
| `OBS_SOURCES`        | **yes**  | `cam1,cam2,cam3`                           | real production source names |
| `OBS_RECORD_DIR`     | **yes**  | `~/es-mini-obs-recordings`                 | base directory containing one folder per source |

The installer defaults `RECORD_POLL_URL` to the permanent hostname and persists it in both `.env` and the generated launchd plist. Override it with the workers.dev fallback only when the permanent hostname is unavailable.

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

## Contract (what the Cloudflare relay expects back)

- `start`, `status`, `resume` → `{ ok, recording, feeds_writing }` (`feeds_writing` is verified from real output files)
- `stop` → `{ ok, saved }`
- `pause` → `{ ok, paused }`

Request body from the proxy: `{ building_id, client_code }`. Auth: `Authorization: Bearer <RECORD_CONTROL_KEY>`.

## OBS control

- Requires OBS Studio 28+ (obs-websocket v5 is built in). Enable/configure it in **Tools -> obs-websocket Settings** (port/password must match env vars here).
- Requires exeldro's **Source Record** plugin installed, with a Source Record filter added to each source listed in `OBS_SOURCES`.
- For `feeds_writing` detection to work, each source's Source Record filter **Path** must be set to `<OBS_RECORD_DIR>/<sourceName>/` (example: source `cam1` writes to `<OBS_RECORD_DIR>/cam1/`).
- Production installation requires non-empty `OBS_SOURCES`; do not treat an unconfigured OBS result as a successful recording.

## Install as a launchd LaunchAgent (auto-start + auto-restart)

1. Edit `com.es.mini-agent.plist`:
   - Keep `RECORD_POLL_URL` on `https://api.evrybdystudios.com`; use `https://es-os-app.crmes.workers.dev` only as the documented fallback.
   - Replace `REPLACE_ME_WITH_REAL_SECRET` with the secret matching the Cloudflare Worker.
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

The agent controls cameras and recording through OBS; it does not expose the Mini through an inbound HTTP tunnel. Command transport is the outbound Supabase-backed queue served by the Cloudflare Worker.
