# Mini update — remote diagnostics + playable recordings

**For:** Robbie, on the studio Mac Mini · **From:** Anna · **Takes:** ~2-5 minutes
**What it does — TWO things in this one update:**
1. Adds a read-only "diag" command so we can check OBS's own performance stats and each camera's Source Record settings from here, without asking you to go stand at the machine. Changes nothing about how recording works.
2. **Fixes recordings so they actually play in a browser.** Right now the files land as 4K video with no "this is a video" label attached, which is why some players (Safari, QuickTime) refuse to open them at all. Going forward, every recording also gets a smaller, universally-playable copy generated automatically after it uploads — the original 4K file is untouched either way.

**Why we need the diag part:** every recording that has reached the cloud so far has silent audio, on all three cameras. We think the per-camera Source Record filters aren't picking up the EVO 8 (they'd be capturing each NDI camera's own audio, which is nothing, rather than the mixed audio). This update lets us confirm that remotely instead of guessing.

**You do NOT need to quit OBS.** This installer only replaces the background agent — it never touches the OBS process, so the shutdown quirk with 3× 4K NDI receivers doesn't come into play.

**One new dependency: ffmpeg.** The installer now checks for it and installs it via Homebrew automatically if it's missing — you shouldn't need to do anything, but if you see a message about ffmpeg during Step 2, that's expected and can take a couple of minutes the first time. If it can't install for any reason, the installer says so and keeps going — recording and upload are unaffected either way, only the playable-copy feature would be delayed until ffmpeg's on the machine.

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

## Step 4 — While you're in OBS anyway: raise the recording bitrate

Separate from the update above, but worth doing in the same sitting. Every camera's Source Record output is currently around 5.8-6.1 Mbps at 4K60 — on the low side for that resolution/frame rate, which can show up as extra motion smear on fast movement. It's been steady at that level on every date we've checked, so it's not a new problem, just worth tightening up.

For each camera's Source Record filter in OBS:
1. Open the filter's settings (same place you cloned it from cam1 when setting up cam2/cam3).
2. Find the video bitrate / encoder setting (exact wording depends on which encoder OBS picked — Apple VT / x264 / etc.).
3. Raise it to roughly **60 Mbps** (a normal target for 4K60 recording — feel free to go up to ~80 Mbps if disk space isn't a concern; anywhere in that range is a big improvement over ~6 Mbps).
4. Repeat for all three cameras so they stay consistent.

No need to restart anything after — it takes effect on the next recording.

## Step 5 — Report to Anna

Send her:
- The whole JSON output from Step 3 — that's the thing we actually need for the audio question, it tells us which audio track each camera is recording and whether OBS is dropping frames.
- A quick confirmation that you bumped the bitrate on all three cameras (Step 4), and to what value.

## Notes

- Nothing about how recording itself works changes — same cameras, same folders, same cloud upload path, same files. The playable-copy feature only adds a second, smaller file after the fact; if anything goes wrong generating it, it's silently skipped and the original recording is unaffected.
- `diag` is read-only. It cannot start, stop, or alter a recording.
- It's also locked to our admin key — a studio client using the booking app can never call it.
