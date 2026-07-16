# Mac mini camera bench setup — runbook for Claude Code

**You are Claude Code running on Robbie's Mac mini.** Your job: get this mini recording a real camera through OBS and confirm the EVRYBDY FLEET agent can drive it. Work top to bottom. Automate every terminal step yourself. For the few OBS GUI steps you cannot click, give Robbie the exact instructions and then **verify the result** before moving on. Do not claim a step is done until you have checked it.

> **Honesty rule (non-negotiable):** never report "ready" unless a real recording actually wrote a growing file to disk AND the agent reported at least one feed writing. If something failed, say exactly what failed and stop. Do not paper over it.
>
> **You do setup only.** Once the agent is running it drives OBS on its own with no AI in the loop — that is by design. Do not wire yourself into the record path.

---

## Values (Anna fills the placeholders before sending this to Robbie)

| Name | Value | Notes |
|---|---|---|
| `RECORD_CONTROL_KEY` | `<<RECORD_CONTROL_KEY>>` | MUST match what's set on Vercel for es-os-app. Secret. |
| `BUILDING_ID` | `bench-1` | The bench mini's id. Leave as `bench-1` unless Anna says otherwise. |
| `OBS_SOURCES` | `cam1` | The OBS source name for the first camera. One name, no spaces. |
| `OBS_RECORD_DIR` | `$HOME/es-mini-recordings` | Where OBS writes per-source folders. |
| `OBS_WS_PASSWORD` | `<<OBS_WS_PASSWORD>>` | The obs-websocket password Robbie sets in step 4. |
| `OBS_WS_URL` | `ws://127.0.0.1:4455` | Default; only change if Robbie uses a different port. |

R2 upload creds are OPTIONAL and not needed to prove the camera. Skip anything R2 unless Anna also supplied `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` / `R2_ENDPOINT`.

If `RECORD_CONTROL_KEY` is still the literal `<<RECORD_CONTROL_KEY>>` placeholder, STOP and tell Robbie to get it from Anna — nothing works without it.

---

## Step 0 — Preflight (you automate, then report a table)

Run these and report what you find. Do not fix anything yet, just gather:

```bash
sw_vers                                   # macOS version
uname -m                                  # arm64 (Apple Silicon) or x86_64
node -v 2>/dev/null || echo "node: MISSING"
which brew >/dev/null 2>&1 && echo "brew: ok" || echo "brew: MISSING"
ls -d /Applications/OBS.app >/dev/null 2>&1 && \
  defaults read /Applications/OBS.app/Contents/Info.plist CFBundleShortVersionString || echo "OBS: not installed"
ls ~/Library/Application\ Support/obs-studio/plugins 2>/dev/null | grep -i source-record || echo "source-record plugin: not found"
pgrep -x OBS >/dev/null && echo "OBS: running" || echo "OBS: not running"
```

Requirements: **Node ≥ 22**, **OBS ≥ 28** (28 is when obs-websocket became built in), **Source Record plugin present**. The next steps install whatever is missing.

---

## Step 1 — Node ≥ 22 (you automate)

If node is missing or the major version is < 22:
```bash
brew install node        # or: brew upgrade node
node -v                   # confirm >= v22
```
If there's no `brew`, install Homebrew first from https://brew.sh, then re-run. Do not continue until `node -v` prints v22 or higher.

---

## Step 2 — OBS ≥ 28 (you automate)

If OBS is not installed:
```bash
brew install --cask obs
```
If OBS is installed but older than 28, tell Robbie to update it (`brew upgrade --cask obs`, or download from https://obsproject.com). Confirm the version is ≥ 28 before continuing — below 28 there is no built-in websocket and this whole flow fails.

---

## Step 3 — Source Record plugin (you automate, verify carefully)

The agent does NOT use OBS's main "Start Recording." It records each camera separately via a **Source Record** filter (exeldro's plugin). Install the latest macOS release:

```bash
# find the latest macOS installer asset
curl -s https://api.github.com/repos/exeldro/obs-source-record/releases/latest \
  | grep -Eo '"browser_download_url": *"[^"]*macos[^"]*\.pkg"' | grep -Eo 'https[^"]*' | head -1
```
Download that `.pkg` and install it:
```bash
curl -fsSL "<the .pkg url from above>" -o /tmp/source-record.pkg
sudo installer -pkg /tmp/source-record.pkg -target /
```
`sudo` will prompt for Robbie's Mac password — ask him to type it. If the API returns no macOS `.pkg` (asset names change), fall back: download the release zip, and drop the `.plugin` bundle into `~/Library/Application Support/obs-studio/plugins/`. Either way, **verify** it landed:
```bash
ls "/Applications/OBS.app/Contents/PlugIns" 2>/dev/null | grep -i source-record
ls ~/Library/Application\ Support/obs-studio/plugins 2>/dev/null | grep -i source-record
```
OBS must be **fully quit and reopened** after installing a plugin for it to load. Have Robbie do that (or `killall OBS` then reopen), then confirm the filter exists in step 5.

> **Note on the camera itself:** the PTZOptics Move 4K is an NDI camera. Getting its picture *into* OBS is Robbie's job (either the DistroAV / obs-ndi plugin for NDI, or an RTSP "Media Source"). This runbook assumes the camera is already showing as a source in OBS. If it isn't yet, pause here and let Robbie get the picture up first.

---

## Step 4 — Enable obs-websocket (Robbie clicks, you verify)

Ask Robbie to do this in OBS (you can't click OBS menus):

> **In OBS: Tools → WebSocket Server Settings → check "Enable WebSocket server" → set Server Port to `4455` → check "Enable Authentication" → set a password → Apply → OK.** Tell me the password you set.

Record that password as `OBS_WS_PASSWORD`. Then verify the server is actually listening:
```bash
nc -z 127.0.0.1 4455 && echo "obs-websocket: listening on 4455" || echo "obs-websocket: NOT listening — recheck the OBS setting"
```
Do not continue until that port is listening.

---

## Step 5 — Camera source + Source Record filter (Robbie clicks, you verify)

Ask Robbie:

> **In OBS: make sure the camera source is named exactly `cam1`** (rename it if needed — right-click the source → Rename).
> **Then add the recorder filter:** right-click `cam1` → Filters → under "Audio/Video Filters" click **+** → **Source Record** → set **Path** to `<OBS_RECORD_DIR>/cam1/` (I'll create that folder for you) → leave the rest default → Close.

You create the folder first so the path exists:
```bash
mkdir -p "<OBS_RECORD_DIR>/cam1"
```
Verify the source name and filter actually exist by reading OBS's saved scene collection (OBS saves on change; ask Robbie to switch scenes once or press the OBS save if nothing appears):
```bash
grep -rl '"name": *"cam1"' ~/Library/Application\ Support/obs-studio/basic/scenes/ 2>/dev/null \
  && echo "cam1 source: found" || echo "cam1 source: NOT found in any scene collection"
grep -rli 'source_record' ~/Library/Application\ Support/obs-studio/basic/scenes/ 2>/dev/null \
  && echo "source_record filter: present" || echo "source_record filter: NOT present"
```
The real proof is step 7 (a file appears when recording). This is just an early sanity check.

---

## Step 6 — Install / refresh the agent with OBS mode ON (you automate)

Run the one-command installer with all the env vars. This downloads the current agent (including `obs-control.js` + `r2-upload.js`), writes a launchd service, and starts it:

```bash
BUILDING_ID="bench-1" \
RECORD_CONTROL_KEY="<<RECORD_CONTROL_KEY>>" \
OBS_SOURCES="cam1" \
OBS_WS_URL="ws://127.0.0.1:4455" \
OBS_WS_PASSWORD="<<OBS_WS_PASSWORD>>" \
OBS_RECORD_DIR="$HOME/es-mini-recordings" \
bash <(curl -fsSL https://raw.githubusercontent.com/annabuies/es-mini-agent/main/install.sh)
```

The installer ends by hitting `http://localhost:8787/health` and printing SUCCESS or FAILURE. If it prints FAILURE, read the error log it points you to (`~/Documents/es-mini-agent/agent.error.log`) and fix the cause (usually a missing env var or OBS not running), then re-run the same command. Do not proceed on a FAILURE.

Confirm OBS mode actually engaged (not demo mode) — the log should show it connecting to OBS, and health should be ok:
```bash
curl -s http://localhost:8787/health
tail -n 30 ~/Documents/es-mini-agent/agent.log
```

---

## Step 7 — THE REAL TEST: record → file → feeds_writing (you automate, this is the gate)

OBS must be **running** for this (the agent drives it). With the camera live in OBS:

```bash
KEY="<<RECORD_CONTROL_KEY>>"
BID="bench-1"
REC="$HOME/es-mini-recordings/cam1"

# start
curl -s -X POST http://localhost:8787/record/start \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"building_id\":\"$BID\"}"

sleep 3
echo "--- files after start (should be a growing .mkv/.mp4) ---"; ls -la "$REC"

# status — feeds_writing must be >= 1
curl -s -X POST http://localhost:8787/record/status \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"building_id\":\"$BID\"}"

sleep 5
echo "--- file should have grown ---"; ls -la "$REC"

# stop
curl -s -X POST http://localhost:8787/record/stop \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"building_id\":\"$BID\"}"

echo "--- final file (should be closed, non-zero size) ---"; ls -la "$REC"
```

**Pass conditions (all must hold):**
1. `start` returns `{"ok":true,"recording":true,...}`
2. A real video file appears in `~/es-mini-recordings/cam1/` and **grows** between the two `ls` calls
3. `status` returns `feeds_writing` ≥ 1 (NOT null — null means demo mode, meaning OBS mode didn't engage)
4. `stop` returns `{"ok":true,"saved":...}` and the file is closed with non-zero size

If `feeds_writing` is `null`: OBS mode did not engage. Check that `OBS_SOURCES=cam1` made it into the plist (`plutil -p ~/Library/LaunchAgents/com.es.mini-agent.plist | grep -A1 OBS_SOURCES`), that OBS is running, and that the websocket password is correct. Re-run step 6 with corrected values.

---

## Step 8 — (Optional) prove the R2 upload pipeline

Only if Anna supplied R2 creds. This uploads a synthetic file to Cloudflare R2 to prove the upload half without needing finished footage:
```bash
curl -s -X POST http://localhost:8787/r2test/start \
  -H "Authorization: Bearer <<RECORD_CONTROL_KEY>>" -H 'Content-Type: application/json' -d '{}'
# then poll /r2test/status?testId=<id> until done; it deletes its own test object after.
```
(Skip entirely if no R2 creds were provided — the camera test in step 7 is what matters today.)

---

## Step 9 — Report back to Anna

Give a short, honest status. Include:
- macOS + OBS version, Node version
- obs-websocket listening? (yes/no)
- Did the agent connect to OBS? (from the log)
- **Step 7 result:** did a real file get written, and what was `feeds_writing`? Include the actual `status` JSON.
- The `/health` JSON
- Anything that failed and what you did about it

Then tell Robbie to **leave OBS open and the mini awake** — Anna will fire a record from the phone app through the relay to confirm the same flow works end to end from her side. She does not need to touch this mini; she verifies remotely.

---

### If you get stuck
- Agent won't boot → `tail -n 50 ~/Documents/es-mini-agent/agent.error.log`. A `Cannot find module './obs-control'` error means the download didn't pull that file — re-run step 6.
- `feeds_writing: null` → OBS mode is off (env var or OBS-not-running or wrong ws password). See step 7.
- Rollback the agent to the last known-good demo version: re-run the installer but first `cd ~/Documents/es-mini-agent && git fetch && git checkout pre-obs-agent-2026-07-16` (only if the repo was cloned; the curl installer always pulls latest `main`).
