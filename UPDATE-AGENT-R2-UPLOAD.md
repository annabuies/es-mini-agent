# UPDATE — es-mini-agent: recordings auto-upload to the cloud

**For: Claude Code running on Robbie's Mac mini (bench-1).**
**Date: 2026-07-22. Takes ~5 minutes. No OBS changes. Do this while NOT recording.**

## What this update does

- After every recording **stops**, the agent now uploads the finished file to EVRYBDY's cloud storage (Cloudflare R2) automatically, in the background. Anna can then view bench footage remotely.
- Also picks up the `saved:false` fix (stop now waits for OBS to finish writing the file).
- Recordings are **never deleted** from this Mac — the cloud copy is additional.
- Uploads pause automatically while a recording is in progress, so they never compete with capture.
- The agent restarts once (a few seconds). OBS, the camera, and all settings are untouched.

## Rules for you, Claude

- Never paste `RECORD_CONTROL_KEY`, `OBS_WS_PASSWORD`, or any `R2_*` value into Slack, a screenshot, a commit, or anywhere online. They are read locally and used locally only.
- Do not touch OBS settings, the `cam1` source, or anything in `~/es-mini-recordings`.
- Do not start a recording — Anna runs the camera test remotely after you report done.
- If any step fails, stop and report to Anna with the exact error. Do not improvise workarounds.

## Step 1 — Preflight (read-only)

```bash
curl -fsS http://localhost:8787/health
```

Expect `"ok":true`, `"building_id":"bench-1"`, and `"recording":false`. If the agent is unhealthy or currently recording, STOP and tell Anna.

Confirm the existing install has all six env values (print names only, values stay in the terminal):

```bash
PL=~/Library/LaunchAgents/com.es.mini-agent.plist
getv() { /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:$1" "$PL"; }
for k in BUILDING_ID RECORD_CONTROL_KEY OBS_SOURCES OBS_WS_URL OBS_WS_PASSWORD OBS_RECORD_DIR; do
  v="$(getv "$k" 2>/dev/null || true)"; [ -n "$v" ] && echo "$k: present" || echo "$k: MISSING"
done
```

All six must say `present` (and `OBS_SOURCES` should be `cam1` — that one you may echo). Any `MISSING` → STOP, tell Anna which one.

## Step 2 — Re-run the installer with the full environment

This re-downloads the updated agent code and rebuilds the launchd job. It reuses the values already on this Mac and adds the four new cloud-storage values below.

```bash
PL=~/Library/LaunchAgents/com.es.mini-agent.plist
getv() { /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:$1" "$PL"; }

BUILDING_ID="$(getv BUILDING_ID)" \
RECORD_CONTROL_KEY="$(getv RECORD_CONTROL_KEY)" \
OBS_SOURCES="$(getv OBS_SOURCES)" \
OBS_WS_URL="$(getv OBS_WS_URL)" \
OBS_WS_PASSWORD="$(getv OBS_WS_PASSWORD)" \
OBS_RECORD_DIR="$(getv OBS_RECORD_DIR)" \
R2_ACCESS_KEY_ID="<<GET FROM ANNA>>" \
R2_SECRET_ACCESS_KEY="<<GET FROM ANNA>>" \
R2_BUCKET="<<GET FROM ANNA>>" \
R2_ENDPOINT="<<GET FROM ANNA>>" \
bash <(curl -fsSL https://raw.githubusercontent.com/annabuies/es-mini-agent/main/install.sh)
```

The installer unloads/reloads the agent itself and ends with a green **SUCCESS** banner. A red FAILURE banner → `tail -n 50 ~/Documents/es-mini-agent/agent.error.log` and send that to Anna.

## Step 3 — Verify the new code is live

```bash
KEY="$(getv RECORD_CONTROL_KEY)"
curl -s -X POST http://localhost:8787/record/status -H "Authorization: Bearer $KEY"
```

The JSON **must contain an `"uploads"` field**, like:

```json
{"ok":true,"recording":false,"feeds_writing":0,"uploads":{"queued":0,"active":null,"last_confirmed":null}}
```

- `uploads` present → new code live AND cloud storage configured. ✅
- `uploads` missing → the R2 values didn't take. Check they're in the plist (`plutil -p "$PL" | grep -c R2_` should print 4+), then redo Step 2 carefully.
- `feeds_writing` should still behave as before (`0` when idle — if it turns `null`, an OBS env value got lost; redo Step 2, it must include ALL the values).

Also check the log is calm:

```bash
tail -n 20 ~/Documents/es-mini-agent/agent.log
```

Expect the `listening` and `relay: polling` lines, no repeated errors.

## Step 4 — Report to Anna

Send her: **"Mini updated — uploads field present, log clean."** and paste the Step-3 status JSON (it contains no secrets). Anna then fires a short test recording remotely; ~a few minutes later the footage appears in the cloud and she'll confirm.

From now on, after each recording stops you'll see `[upload-queue]` lines in `agent.log`; the line `[upload-queue] confirmed recordings/...` means that footage is safely in the cloud.

## Notes

- This has nothing to do with the EVO 8 audio interface — that's a separate later setup.
- If this file was sent with real values filled in: it contains live credentials. Keep it off shared drives and delete it after the update (Anna keeps the originals).
