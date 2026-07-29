# Mini update — turn on cam2 + cam3

**For:** Robbie, on the studio Mac Mini · **From:** Anna · **Takes:** ~2 minutes
**What it does:** the agent currently only records cam1. This tells it to record all three cameras you wired up. It also makes the camera list remotely editable from now on, so adding a cam4 later will never need you to touch this machine again.

**You do NOT need to quit OBS.** This installer only replaces the background agent — it never touches the OBS process, so the shutdown quirk you hit with 3× 4K NDI receivers doesn't come into play.

## Step 1 — Check what's currently set (optional, 5 seconds)

This prints which settings exist on this Mac without showing any secret values:

```bash
PL=~/Library/LaunchAgents/com.es.mini-agent.plist
getv() { /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:$1" "$PL" 2>/dev/null || true; }

for k in BUILDING_ID RECORD_CONTROL_KEY OBS_SOURCES OBS_WS_URL OBS_WS_PASSWORD \
         OBS_RECORD_DIR R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET R2_ENDPOINT \
         UPLOAD_CONFIRMED_WEBHOOK_URL; do
  v="$(getv "$k")"; [ -n "$v" ] && echo "  SET     $k" || echo "  MISSING $k"
done
```

Send Anna that list if anything unexpected shows as MISSING.

## Step 2 — Re-run the installer

Same recipe as last time: this reads every existing setting straight back off this Mac and only changes the camera list. Nothing else gets touched.

```bash
PL=~/Library/LaunchAgents/com.es.mini-agent.plist
getv() { /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:$1" "$PL" 2>/dev/null || true; }

BUILDING_ID="$(getv BUILDING_ID)" \
RECORD_CONTROL_KEY="$(getv RECORD_CONTROL_KEY)" \
OBS_SOURCES="cam1,cam2,cam3" \
OBS_WS_URL="$(getv OBS_WS_URL)" \
OBS_WS_PASSWORD="$(getv OBS_WS_PASSWORD)" \
OBS_RECORD_DIR="$(getv OBS_RECORD_DIR)" \
R2_ACCESS_KEY_ID="$(getv R2_ACCESS_KEY_ID)" \
R2_SECRET_ACCESS_KEY="$(getv R2_SECRET_ACCESS_KEY)" \
R2_BUCKET="$(getv R2_BUCKET)" \
R2_ENDPOINT="$(getv R2_ENDPOINT)" \
UPLOAD_CONFIRMED_WEBHOOK_URL="$(getv UPLOAD_CONFIRMED_WEBHOOK_URL)" \
bash <(curl -fsSL https://raw.githubusercontent.com/annabuies/es-mini-agent/main/install.sh)
```

⚠️ **Paste the whole block, including the `PL=` and `getv()` lines.** Running only the bottom half would blank the cloud-upload credentials — the installer rebuilds the settings file from scratch every time, so anything not passed in is erased.

The installer unloads/reloads the agent itself and ends with a green **SUCCESS** banner. A red FAILURE banner → `tail -n 50 ~/Documents/es-mini-agent/agent.error.log` and send that to Anna.

## Step 3 — Verify

```bash
KEY="$(getv RECORD_CONTROL_KEY)"
curl -s -X POST http://localhost:8787/record/status -H "Authorization: Bearer $KEY"
tail -n 20 ~/Documents/es-mini-agent/agent.log
```

Two things to look for:

1. The status JSON should now list **three** cameras: `"sources":["cam1","cam2","cam3"]`
2. The log should show `sources (env): cam1,cam2,cam3` plus the usual `listening` and `relay: polling` lines, with no repeated errors.

## Step 4 — Report to Anna

Send her: **"Mini updated — 3 cameras showing, log clean."** She'll fire a short test recording remotely and confirm all three feeds land in their folders.

## Notes

- Recording behaviour is otherwise unchanged: footage still lands locally in `~/es-mini-recordings/<camera>/` AND uploads to the cloud.
- From now on the camera list can be changed remotely — the agent checks for updates once a minute. It will never apply a change in the middle of a recording; a change made mid-session takes effect once that recording stops.
- If the remote list is ever empty or unreachable, the agent just keeps using the list it already has. It can't be left recording nothing.
