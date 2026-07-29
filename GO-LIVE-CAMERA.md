# Go live with the camera — leave demo mode

**You are Claude Code running on Robbie's Mac mini.** Your job: get OBS installed, get the real PTZOptics camera showing a live picture in OBS, then flip the EVRYBDY agent **out of demo mode** so it records that camera for real. When you're done, Anna fires a single command from her laptop and sees a real feed writing to disk.

> **Honesty rule (non-negotiable):** never report "ready" or "live" unless a real recording actually wrote a **growing** file to disk AND the agent reported `feeds_writing` **≥ 1** (not `null`, not `0`). `null` means you're still in demo mode. If something failed, say exactly what failed and stop. Do not paper over it.
>
> **You do setup only.** Once the agent is running it drives OBS on its own with no AI in the record path. Do not wire yourself into recording.

---

## What's already done (don't touch it)

The cloud side is fully wired and is **not** the demo. On Vercel (`es-os-app`), `RECORD_CONTROL_KEY`, `ES_SUPABASE_URL`, `ES_SUPABASE_KEY`, and `RECORD_TARGET_BUILDING_ID=bench-1` are all set. The relay enqueues real commands to Supabase and the mini polls them outbound every second. **Nothing needs a tunnel or an inbound port on this Mac.**

**The demo is 100% on this mini:** the agent runs in demo mode whenever `OBS_SOURCES` is empty, and in demo mode every command returns `feeds_writing: null` and touches no camera. This runbook's whole point is to install the camera and reinstall the agent WITH `OBS_SOURCES=cam1`.

**Success = one line:** from Anna's laptop, `POST /api/record {"op":"start"}` returns `"live": true` and `"feeds_writing": 1` (or higher). That is a real camera recording. Anything with `feeds_writing: null` is still demo.

---

## Values (Anna fills these before sending you this file)

| Name | Value | Notes |
|---|---|---|
| `RECORD_CONTROL_KEY` | `<<GET FROM ANNA>>` | MUST match the value already set on Vercel for `es-os-app`. Anna reveals it in the Vercel dashboard. |
| `BUILDING_ID` | `bench-1` | This mini's id. Leave as `bench-1` unless Anna says otherwise. It must match `RECORD_TARGET_BUILDING_ID` on Vercel. |
| `OBS_SOURCES` | `cam1` | The OBS source name for the camera. One word, no spaces. **This is the setting that leaves demo mode.** |
| `OBS_RECORD_DIR` | `$HOME/es-mini-recordings` | Where OBS writes per-camera folders. |
| `OBS_WS_PASSWORD` | `<<SET IN STEP 6>>` | The obs-websocket password you set in Step 6. |
| `OBS_WS_URL` | `ws://127.0.0.1:4455` | Default. Only change if you use a different port. |

If `RECORD_CONTROL_KEY` is still the literal `<<GET FROM ANNA>>` placeholder, **STOP** and ask Anna for it. Nothing works without it, and it must match Vercel exactly.

---

## Step 0 — Preflight (automate, then report a table)

Run these and report what you find. Don't fix anything yet:

```bash
sw_vers                                   # macOS version
uname -m                                  # arm64 (Apple Silicon) or x86_64
node -v 2>/dev/null || echo "node: MISSING"
which brew >/dev/null 2>&1 && echo "brew: ok" || echo "brew: MISSING"
ls -d /Applications/OBS.app >/dev/null 2>&1 && \
  defaults read /Applications/OBS.app/Contents/Info.plist CFBundleShortVersionString || echo "OBS: not installed"
pgrep -x OBS >/dev/null && echo "OBS: running" || echo "OBS: not running"
ls ~/Documents/es-mini-agent >/dev/null 2>&1 && echo "agent repo: present" || echo "agent repo: absent (installer will fetch it)"
```

Requirements you'll satisfy below: **Node ≥ 22**, **OBS ≥ 28**, the **Source Record** plugin, and a **DistroAV/NDI or RTSP** picture in OBS.

---

## Step 1 — Node ≥ 22 (automate)

```bash
node -v 2>/dev/null | grep -qE 'v(2[2-9]|[3-9][0-9])' && echo "node ok" || brew install node
node -v   # must print v22 or higher
```
No `brew`? Install Homebrew from https://brew.sh first, then re-run. Do not continue until `node -v` ≥ v22.

---

## Step 2 — Install OBS ≥ 28 (automate)

```bash
ls -d /Applications/OBS.app >/dev/null 2>&1 || brew install --cask obs
defaults read /Applications/OBS.app/Contents/Info.plist CFBundleShortVersionString   # confirm >= 28
```
If OBS is present but < 28: `brew upgrade --cask obs` (or download from https://obsproject.com). Below 28 there is no built-in websocket and the whole flow fails. Open OBS once so it creates its config, then continue.

---

## Step 3 — Source Record plugin (automate, verify)

The agent records each camera via exeldro's **Source Record** filter, not OBS's main "Start Recording." Install the latest macOS release:

```bash
# find the latest macOS .pkg asset
curl -s https://api.github.com/repos/exeldro/obs-source-record/releases/latest \
  | grep -Eo '"browser_download_url": *"[^"]*macos[^"]*\.pkg"' | grep -Eo 'https[^"]*' | head -1
```
Download and install it:
```bash
curl -fsSL "<the .pkg url from above>" -o /tmp/source-record.pkg
sudo installer -pkg /tmp/source-record.pkg -target /   # asks Robbie for his Mac password
```
If the API returns no macOS `.pkg` (asset names change), download the release zip and drop the `.plugin` bundle into `~/Library/Application Support/obs-studio/plugins/`. Then verify it landed:
```bash
ls "/Applications/OBS.app/Contents/PlugIns" 2>/dev/null | grep -i source-record
ls ~/Library/Application\ Support/obs-studio/plugins 2>/dev/null | grep -i source-record
```
**OBS must be fully quit and reopened after installing any plugin.** Have Robbie do that (or `killall OBS` then reopen).

---

## Step 4 — Get the PTZOptics camera showing a LIVE picture in OBS

This is the "give us light" step: at the end of it Robbie should **see the camera image in the OBS preview.**

**Physical first (ask Robbie to confirm):**
- Camera is powered (PoE) and connected to the **same network/switch** as this mini.
- There is actual light on whatever the camera points at, so the feed isn't black. A desk lamp is fine for the bench. The production room uses the Hue rig; the bench just needs enough light to see something.

**Preferred path — NDI (the PTZOptics Move 4K is an NDI camera):**
1. Install the **DistroAV** OBS plugin (the maintained successor to obs-ndi) plus the NDI runtime it depends on. Asset names change, so fetch the current macOS build:
   ```bash
   curl -s https://api.github.com/repos/DistroAV/DistroAV/releases/latest \
     | grep -Eo '"browser_download_url": *"[^"]*[mM]ac[^"]*\.pkg"' | grep -Eo 'https[^"]*' | head -3
   ```
   Install the OBS plugin `.pkg`. If DistroAV prompts on first launch to install the NDI runtime, let it (or grab the NDI runtime/tools for macOS from the link it shows). Fully quit and reopen OBS after installing.
2. On the camera: make sure **NDI output is enabled** in the camera's web admin page (PTZOptics NDI models ship with it on, but confirm), and that the camera and mini are on the same subnet.
3. In OBS: **Sources → + → NDI Source → OK**, then in Properties pick the PTZOptics camera from the **Source name** dropdown. If the dropdown is empty, NDI discovery isn't seeing it yet — recheck same-network + NDI-enabled, and that DistroAV loaded (OBS → Tools should list an NDI entry).

**Fallback path — RTSP (if NDI is fussy):**
- In OBS: **Sources → + → Media Source**, uncheck **Local File**, set **Input** to the camera's RTSP URL. The exact path depends on the PTZOptics model/firmware — look it up on the camera's own network/streaming settings page (it's commonly `rtsp://<camera-ip>/1` for the main HD stream). Set **Input Format** to `rtsp`. Optionally check "Restart playback when source becomes active."

**Verify (the real check):** Robbie should now **see live video in the OBS preview.** If it's black or frozen, stop here and fix the picture before touching the agent. A live picture in OBS is the prerequisite for everything below.

---

## Step 5 — Name the source `cam1` + add the Source Record filter (Robbie clicks, you verify)

Ask Robbie:

> **Rename the camera source to exactly `cam1`** (right-click the source → Rename).
> **Then:** right-click `cam1` → **Filters** → under "Audio/Video Filters" click **+** → **Source Record** → set **Path** to `<OBS_RECORD_DIR>/cam1/` → leave the rest default → Close.

The Path must be exactly `<OBS_RECORD_DIR>/cam1/`, because the agent detects "is this feed writing?" by watching that exact folder. Create it first so the path exists:
```bash
mkdir -p "$HOME/es-mini-recordings/cam1"
```
Sanity check (ask Robbie to switch scenes once so OBS saves):
```bash
grep -rl '"name": *"cam1"' ~/Library/Application\ Support/obs-studio/basic/scenes/ 2>/dev/null \
  && echo "cam1 source: found" || echo "cam1 source: NOT found"
grep -rli 'source_record' ~/Library/Application\ Support/obs-studio/basic/scenes/ 2>/dev/null \
  && echo "source_record filter: present" || echo "source_record filter: NOT present"
```

---

## Step 6 — Enable obs-websocket (Robbie clicks, you verify)

Ask Robbie:

> **In OBS: Tools → WebSocket Server Settings → check "Enable WebSocket server" → Server Port `4455` → check "Enable Authentication" → set a password → Apply → OK.** Tell me the password.

Record it as `OBS_WS_PASSWORD`, then confirm it's listening:
```bash
nc -z 127.0.0.1 4455 && echo "obs-websocket: listening on 4455" || echo "obs-websocket: NOT listening — recheck the OBS setting"
```
Do not continue until port 4455 is listening.

---

## Step 7 — Reinstall the agent WITH OBS mode ON (this is what kills demo mode)

Run the installer with **all** the OBS env vars. The presence of `OBS_SOURCES` is the single thing that moves the agent from demo to live:

```bash
BUILDING_ID="bench-1" \
RECORD_CONTROL_KEY="<<GET FROM ANNA>>" \
OBS_SOURCES="cam1" \
OBS_WS_URL="ws://127.0.0.1:4455" \
OBS_WS_PASSWORD="<<the password from Step 6>>" \
OBS_RECORD_DIR="$HOME/es-mini-recordings" \
bash <(curl -fsSL https://raw.githubusercontent.com/annabuies/es-mini-agent/main/install.sh)
```

The installer writes a launchd service, starts it, and ends by hitting `http://localhost:8787/health`. On FAILURE, read `~/Documents/es-mini-agent/agent.error.log`, fix the cause (usually a missing env var or OBS not running), and re-run the same command. Then confirm it's healthy and actually polling:
```bash
curl -s http://localhost:8787/health
tail -n 30 ~/Documents/es-mini-agent/agent.log     # should show: relay: polling https://es-os-app.vercel.app/api/record
```

---

## Step 8 — THE REAL TEST, run locally on the mini (this is the gate)

OBS must be **running** with the live `cam1` picture. Then:

```bash
KEY="<<GET FROM ANNA>>"
BID="bench-1"
REC="$HOME/es-mini-recordings/cam1"

curl -s -X POST http://localhost:8787/record/start \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d "{\"building_id\":\"$BID\"}"
sleep 3
echo "--- files after start (want a growing .mkv/.mp4) ---"; ls -la "$REC"

curl -s -X POST http://localhost:8787/record/status \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d "{\"building_id\":\"$BID\"}"
sleep 5
echo "--- file should have GROWN ---"; ls -la "$REC"

curl -s -X POST http://localhost:8787/record/stop \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d "{\"building_id\":\"$BID\"}"
echo "--- final file (closed, non-zero) ---"; ls -la "$REC"
```

**Pass conditions (ALL must hold):**
1. `start` → `{"ok":true,"recording":true,...}`
2. A real video file appears in `~/es-mini-recordings/cam1/` and **grows** between the two `ls` calls
3. `status` → **`feeds_writing` ≥ 1** (NOT `null` — `null` means demo mode didn't flip)
4. `stop` → `{"ok":true,"saved":true}`, file closed with non-zero size

If `feeds_writing` is `null`: OBS mode did not engage. Check `OBS_SOURCES` made it into the plist (`plutil -p ~/Library/LaunchAgents/com.es.mini-agent.plist | grep -A1 OBS_SOURCES`), OBS is running, and the ws password is right. Re-run Step 7 with corrected values.

---

## Step 9 — Leave it live, tell Anna, she tests from her end

Once Step 8 passes:
- **Leave OBS open and the mini awake** (System Settings → Displays/Energy: prevent sleep). The agent polls the relay every second, so as long as it's awake, Anna's command reaches it in ~1s.
- Tell Anna: **"bench-1 is live, OBS_SOURCES=cam1, Step 8 passed, feeds_writing was N."** Paste the actual `status` JSON.

**Anna's end (from her laptop, no key needed, the relay handles auth):**
```bash
curl -s -X POST https://es-os-app.vercel.app/api/record -H 'Content-Type: application/json' -d '{"op":"start"}'
curl -s -X POST https://es-os-app.vercel.app/api/record -H 'Content-Type: application/json' -d '{"op":"status"}'
curl -s -X POST https://es-os-app.vercel.app/api/record -H 'Content-Type: application/json' -d '{"op":"stop"}'
```
She's looking for `"live": true` and `"feeds_writing": 1` (or higher). `null` = still demo. `"error":"timeout"` = mini asleep or not polling.

---

## Report back to Anna

Short and honest:
- macOS + OBS version, Node version
- How the camera got into OBS (NDI/DistroAV or RTSP) and whether the preview showed a live picture
- obs-websocket listening? (yes/no)
- Agent `/health` JSON, and did the log show it polling the relay?
- **Step 8 result:** did a real file grow, and what was `feeds_writing`? Include the actual `status` JSON.
- Anything that failed and what you did about it

---

## Troubleshooting

- **`feeds_writing: null`** → demo mode still on. `OBS_SOURCES` missing from the plist, OBS not running, or wrong ws password. See Step 8.
- **`feeds_writing: 0` while recording** → OBS mode is on but no file is growing. The Source Record filter **Path** doesn't match `<OBS_RECORD_DIR>/cam1/`, or the filter isn't on `cam1`. Re-check Step 5.
- **Black/frozen preview** → camera light or the NDI/RTSP source, not the agent. Fix the picture in OBS first (Step 4).
- **Agent won't boot** → `tail -n 50 ~/Documents/es-mini-agent/agent.error.log`. `Cannot find module './obs-control'` means the download was incomplete — re-run Step 7.
- **Anna gets `"error":"timeout"`** → the mini isn't polling: mini asleep, agent not running (`curl localhost:8787/health`), or wrong `RECORD_CONTROL_KEY` (must match Vercel).
- **Deeper reference:** `SETUP-MAC-MINI.md` in this repo has the original bench walkthrough and the optional R2 upload test (Step 8 there). File transfer/R2 is a **separate, later** gate — do not let it block today's camera proof.
