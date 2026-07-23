# Mini update — turn on the "footage saved" team notification

**For:** Robbie, on the bench Mac Mini · **From:** Anna · **Takes:** ~2 minutes
**What it does:** after every recording finishes uploading to the cloud, the team now gets a Slack message in the OS notifications channel with a link to the file. The mini just needs one new value so it knows where to report.

This batches with the pending agent update (the `saved:false` quirk fix) — one re-run covers both.

## Step 1 — Re-run the installer with the full environment

Same recipe as last time: reuse everything already on this Mac, add the ONE new value at the bottom.

```bash
PL=~/Library/LaunchAgents/com.es.mini-agent.plist
getv() { /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:$1" "$PL"; }

BUILDING_ID="$(getv BUILDING_ID)" \
RECORD_CONTROL_KEY="$(getv RECORD_CONTROL_KEY)" \
OBS_SOURCES="$(getv OBS_SOURCES)" \
OBS_WS_URL="$(getv OBS_WS_URL)" \
OBS_WS_PASSWORD="$(getv OBS_WS_PASSWORD)" \
OBS_RECORD_DIR="$(getv OBS_RECORD_DIR)" \
R2_ACCESS_KEY_ID="$(getv R2_ACCESS_KEY_ID)" \
R2_SECRET_ACCESS_KEY="$(getv R2_SECRET_ACCESS_KEY)" \
R2_BUCKET="$(getv R2_BUCKET)" \
R2_ENDPOINT="$(getv R2_ENDPOINT)" \
UPLOAD_CONFIRMED_WEBHOOK_URL="<<GET FROM ANNA>>" \
bash <(curl -fsSL https://raw.githubusercontent.com/annabuies/es-mini-agent/main/install.sh)
```

The installer unloads/reloads the agent itself and ends with a green **SUCCESS** banner. A red FAILURE banner → `tail -n 50 ~/Documents/es-mini-agent/agent.error.log` and send that to Anna.

## Step 2 — Verify

```bash
KEY="$(getv RECORD_CONTROL_KEY)"
curl -s -X POST http://localhost:8787/record/status -H "Authorization: Bearer $KEY"
tail -n 20 ~/Documents/es-mini-agent/agent.log
```

Status JSON should look the same as before (`uploads` field present, `feeds_writing: 0` when idle). Log should show `listening` + `relay: polling`, no repeated errors.

## Step 3 — Report to Anna

Send her: **"Mini updated — notify webhook set, log clean."** Anna then fires a short test recording remotely; when the upload confirms, the Slack message should appear in the OS notifications channel with the link. She'll confirm.

## Notes

- The new value contains a secret token inside the URL. If this file was sent with the real value filled in: keep it off shared drives and delete it after the update (Anna keeps the originals).
- Nothing else changes: recording, saving to this Mac, and cloud upload all behave exactly as they do today. Recordings still land locally in `~/es-mini-recordings/` AND in the cloud.
