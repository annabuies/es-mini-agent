# Mini update — add remote diagnostics

**For:** Robbie, on the studio Mac Mini · **From:** Anna · **Takes:** ~2 minutes
**What it does:** adds a read-only "diag" command so we can check OBS's own performance stats and each camera's Source Record settings from here, without asking you to go stand at the machine. It changes nothing about how recording works.

**Why we need it:** every recording that has reached the cloud so far has silent audio, on all three cameras. We think the per-camera Source Record filters aren't picking up the EVO 8 (they'd be capturing each NDI camera's own audio, which is nothing, rather than the mixed audio). This update lets us confirm that remotely instead of guessing.

**You do NOT need to quit OBS.** This installer only replaces the background agent — it never touches the OBS process, so the shutdown quirk with 3× 4K NDI receivers doesn't come into play.

## Step 1 — Check what's currently set (optional, 5 seconds)

Prints which settings exist on this Mac without showing any secret values:

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

This reads every existing setting straight back off this Mac and changes nothing about your config — it only updates the agent code.

```bash
PL=~/Library/LaunchAgents/com.es.mini-agent.plist
getv() { /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:$1" "$PL" 2>/dev/null || true; }

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
UPLOAD_CONFIRMED_WEBHOOK_URL="$(getv UPLOAD_CONFIRMED_WEBHOOK_URL)" \
bash <(curl -fsSL https://raw.githubusercontent.com/annabuies/es-mini-agent/main/install.sh)
```

⚠️ **Paste the whole block, including the `PL=` and `getv()` lines.** Running only the bottom half would blank the cloud-upload credentials and the notify webhook — the installer rebuilds the settings file from scratch every time, so anything not passed in is erased.

The installer unloads/reloads the agent itself and ends with a green **SUCCESS** banner. A red FAILURE banner → `tail -n 50 ~/Documents/es-mini-agent/agent.error.log` and send that to Anna.

## Step 3 — Verify

```bash
KEY="$(getv RECORD_CONTROL_KEY)"
curl -s -X POST http://localhost:8787/record/diag -H "Authorization: Bearer $KEY"
```

You should get back a block of JSON containing `"stats"` (frame rate, dropped frames, CPU) and `"filters"` (one entry per camera). If it comes back `{"ok":false,"reason":"not_found"}` the update didn't take — tell Anna.

If it says `"error":"obs_unreachable"` that just means OBS isn't running right now; start OBS and try again.

## Step 4 — Report to Anna

Send her the whole JSON output from Step 3. That's the thing we actually need — it tells us which audio track each camera is recording, and whether OBS is dropping frames.

## Notes

- Nothing about recording changes. Same cameras, same folders, same cloud upload.
- `diag` is read-only. It cannot start, stop, or alter a recording.
- It's also locked to our admin key — a studio client using the booking app can never call it.
