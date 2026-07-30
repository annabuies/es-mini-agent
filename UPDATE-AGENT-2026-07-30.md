# Studio Mini update, 30 July

**Two parts. Part A is OBS only and needs no install. Part B is one installer re-run.**
Total time about 20 minutes including the proof test.

Part B replaces the install step in `UPDATE-AGENT-DIAG.md`. Do not run that older one as well, this supersedes it.

---

# PART A — drop the three Source Record filters to 1080p60

## What we already proved (no need to re-investigate)

Your test settled it:

| | measured |
|---|---|
| recorded by the clock | 60.0 s |
| local file on the Mini, before any upload | 19.58 s (cam1/cam2), 19.55 s (cam3) |
| frames captured | ~1175 over 60 real seconds = **~19.6 fps**, written at 60 fps |
| OBS "skipped frames due to encoding lag" | **96.9% / 97.1% / 97.5%** |
| OBS render lag over the same window | **0.1%** (3591 of 3594 frames drawn) |

Frames arrive fine and get drawn fine. The encoder discards about two thirds of them. It is already the Apple VideoToolbox hardware encoder, so there is nothing to switch to. Three simultaneous native 4K60 encodes exceed what the M4's hardware encoder can do. One fits, three do not.

**The network is innocent.** NDI is delivering at full rate. No need to look at the switch, the cables, or NDI bandwidth mode for this one.

## The change

Record **1920x1080 at 60 fps** per camera instead of the source's native 3840x2160.

Your reasoning is the one we are going with: 4K only existed for punch-in flexibility in post while chair positions were uncertain, and the preset system solves that better. Booking knows party size, the agent recalls the preset, cameras frame optically before recording. PTZ framing beats cropping anyway.

Three things improve at once: encoder load drops to roughly a quarter (that is the actual fix), the existing 6 Mbps goes from badly under-spec for 4K60 to appropriate for 1080p60, and storage and upload per session drop about 75%. The OBS canvas is already 1920x1080, so this matches what the rest of the system expects.

## Doing it

For **each** of cam1, cam2, cam3:

1. Right-click the source, **Filters**.
2. Select the **Source Record** filter.
3. Find the resolution / scale control. It is currently recording at the source's native size because that setting was never changed from its default.
4. Set it so the recording output is **1920x1080**. If the control offers a canvas-matched option instead of a typed size, that is equivalent here, because the canvas is already 1920x1080.
5. Leave everything else alone: bitrate, encoder, container, path, filename format, scale type, record mode, audio.

**Do not restart OBS.** The SIGTERM-wedge quirk still applies and nothing here needs a restart.

**Do not raise the bitrate yet.** The ~60 Mbps ask from the earlier runbook is on hold. Raising bitrate on an encoder that is already saturated can make the loss worse, and at 1080p the current 6 Mbps is about right anyway.

---

# PART B — one installer re-run

This picks up four fixes at once:

1. **Cloud storage moves from Cloudflare R2 to AWS S3.** New credentials, new bucket.
2. **The 1080p playback proxy gets fixed.** It has never once run on this machine. The installer detected the ffmpeg path and then discarded it, and the background service runs with a minimal PATH that excludes Homebrew, so it failed silently every time. Recording and master upload were never affected, which is why nothing looked wrong.
3. **The `diag` remote diagnostic** from the earlier runbook, if you have not already picked it up.
4. **Remote updates.** The agent can now fetch and install its own code updates when Anna asks it to, so future changes do not need you at the keyboard.

**This should be the last time anyone installs this by hand.** Point 4 is the reason. After this run, Anna can ship changes to the Mini remotely, and the agent refuses to update itself while a recording or an upload is in progress, so it can never interrupt a session.

## Step 1 — check what is currently set

```bash
PL=~/Library/LaunchAgents/com.es.mini-agent.plist
getv() { /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:$1" "$PL" 2>/dev/null || true; }

for k in PORT BUILDING_ID RECORD_CONTROL_KEY OBS_SOURCES OBS_WS_URL OBS_WS_PASSWORD \
         OBS_RECORD_DIR UPLOAD_CONFIRMED_WEBHOOK_URL; do
  v="$(getv "$k")"; [ -n "$v" ] && echo "  SET     $k" || echo "  MISSING $k"
done
```

Send Anna that list if anything other than `PORT` or `UPLOAD_CONFIRMED_WEBHOOK_URL` shows as MISSING. Those two are allowed to be missing: `PORT` falls back to 8787, and the webhook is supplied remotely now.

## Step 2 — re-run the installer

Anna will send you this block with the five `PASTE_` values already filled in. Everything else is read straight back off this Mac and is unchanged.

⚠️ **Paste the whole block, including the `PL=` and `getv()` lines.** The installer rebuilds the settings file from scratch every time, so anything not passed in is erased. Running only the bottom half would wipe your OBS settings and the control key.

```bash
PL=~/Library/LaunchAgents/com.es.mini-agent.plist
getv() { /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:$1" "$PL" 2>/dev/null || true; }

PORT="$(getv PORT)" \
BUILDING_ID="$(getv BUILDING_ID)" \
RECORD_CONTROL_KEY="$(getv RECORD_CONTROL_KEY)" \
OBS_SOURCES="$(getv OBS_SOURCES)" \
OBS_WS_URL="$(getv OBS_WS_URL)" \
OBS_WS_PASSWORD="$(getv OBS_WS_PASSWORD)" \
OBS_RECORD_DIR="$(getv OBS_RECORD_DIR)" \
UPLOAD_CONFIRMED_WEBHOOK_URL="$(getv UPLOAD_CONFIRMED_WEBHOOK_URL)" \
S3_ACCESS_KEY_ID="PASTE_ACCESS_KEY_ID" \
S3_SECRET_ACCESS_KEY="PASTE_SECRET_ACCESS_KEY" \
S3_BUCKET="PASTE_BUCKET" \
S3_ENDPOINT="PASTE_ENDPOINT" \
S3_REGION="PASTE_REGION" \
AWS_ROLE_ARN="PASTE_ROLE_ARN" \
bash <(curl -fsSL https://raw.githubusercontent.com/annabuies/es-mini-agent/main/install.sh)
```

Note: the old `R2_*` settings are deliberately not carried over. This is a clean switch to AWS, and keeping both would leave it ambiguous which one is actually live.

## Step 3 — confirm the new agent is healthy

```bash
PL=~/Library/LaunchAgents/com.es.mini-agent.plist
getv() { /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:$1" "$PL" 2>/dev/null || true; }
KEY="$(getv RECORD_CONTROL_KEY)"; PORT="$(getv PORT)"; PORT="${PORT:-8787}"

curl -s -X POST "http://127.0.0.1:$PORT/record/diag" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{}' \
  | python3 -m json.tool
```

**Pass looks like:**

- a `storage` block whose `region` is the region Anna gave you and whose `credentials.mode` is **`assume_role`**
- an `ffmpeg` block with a real path such as `/opt/homebrew/bin/ffmpeg` and `source` of **`env`** (this is the proxy fix landing, `path` would mean it is still broken)
- a `filters` block listing all three cameras

Nothing in that output is a secret, so it is safe to paste back.

---

# THE PROOF TEST (this is what closes both parts)

Do this after Part A and Part B are both done.

1. Start a recording, confirm all three cameras are writing.
2. Hold **60 seconds by the clock**.
3. Stop.
4. Check the **local files on the Mini first**, before worrying about any upload:

```bash
for c in cam1 cam2 cam3; do
  f=$(ls -t ~/es-mini-recordings/$c/*.mkv | head -1)
  echo "$c: $(basename "$f")"
  ffprobe -v error -select_streams v:0 \
    -show_entries stream=width,height,nb_read_frames,r_frame_rate \
    -show_entries format=duration -count_frames -of default=nw=1 "$f"
done
```

**Pass looks like:**

| | before | required after |
|---|---|---|
| duration | 19.58 s | **~60 s** |
| frames | ~1175 | **~3600** |
| width x height | 3840x2160 | **1920x1080** |

5. Then the independent check, OBS's own log:

```bash
LOGDIR=~/Library/"Application Support"/obs-studio/logs
grep "skipped frames due to encoding lag" "$LOGDIR/$(ls -t "$LOGDIR" | head -1)" | tail -5
```

Should be **near 0%**, down from 97%.

**If it still drops frames at 1080p60, stop and report the numbers rather than changing other settings.** The next lever is 60 fps to 30 fps, which halves the load again, and that is Anna's call.

---

# Do not do these

- Do not restart OBS (the SIGTERM wedge with three 4K NDI receivers).
- Do not raise the bitrate yet, see Part A.
- Do not delete anything from `~/es-mini-recordings/`.
- Do not assume this fixes cam3's freezes. cam3 showed contiguous dead freezes of 0.42 s and 1.53 s in earlier takes that cam1 and cam2 did not. That is a second, separate fault in its own NDI path, worth checking its cable and switch port independently once this is confirmed.

# Why this mattered

Every 3-camera recording so far kept about a third of the footage and wrote it labelled as 60 fps, so a 60 minute session became a ~20 minute file playing back at roughly 3x speed. That is what "laggy" has been the whole time. It is data loss rather than a quality setting, which is why nothing should record for a real client until the proof test above passes.
