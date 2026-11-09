# Context for Robbie's Claude: EVRYBDY Studios room Mac mini (bench-1)

You are helping Robbie, who runs the EVRYBDY Studios room called bench-1. Anna Bui built and maintains the system. This file tells you what the system is, what was done recently, what Robbie is being asked to do next, and what you must not touch. Updated 2026-11-08.

## The system in one paragraph

A podcast/video room. A **Mac mini** in the room runs OBS (records the cameras), a small Node service called the **ES agent** (`com.es.mini-agent`, a LaunchAgent for the user `megadesk-command`), and a helper that keeps OBS running (`com.es.obs-launcher`). A **room iPad** runs the ES kiosk app (TestFlight build 1.0 (48)), where guests start and stop sessions and see a live camera preview. Everything is coordinated by the ES cloud service at `api.evrybdystudios.com`. Recordings upload to cloud storage after each session.

## What happened recently

- **2026-11-06, 10:28 AM ET:** Robbie ran the one-command Mini update. Result SUCCESS: agent `2026.10.20-1 → 2026.11.05-1`, commit `20230f2`, installer `2026.11.06-v2`, no warnings. Anna confirmed it from the cloud side (the Mini reports that version and checks in normally). The previous install is untouched at `~/Documents/es-mini-agent`, and a backup is at `~/es-backups/mini-20261106T152738Z`.
- Robbie asked when the **local preview** can be switched on. He sees a noticeable delay on the live camera preview today.

## What "local preview" is

Today the iPad's live preview goes Mini → cloud → iPad, which adds delay. Local preview sends it Mini → iPad directly over the room network, through a small relay program (**MediaMTX**) on the Mini. All of the app, agent and cloud code for this is already installed. It is just switched off. Three steps are left:

1. **Anna:** create the address `preview-bench1.evrybdystudios.com` (points at the Mini's wired IP, 172.16.1.35) and a security certificate for it, then copy the two certificate files to the Mini (`~/es-preview-certs-inbox/`).
2. **Robbie:** run one line in Terminal on the Mini to install the relay (below).
3. **Anna and Robbie together:** a one-hour test window with nothing booked. Anna flips the switch, Robbie checks the iPad shows "● Live view · in room", and we test the fallback.

Installing the relay changes nothing for sessions until Anna flips the switch. If anything goes wrong at any point, the iPad falls back to the cloud preview by itself within about 5 seconds.

## Robbie's step: install the relay

Only after Anna says the certificate is on the Mini. Run it in **Terminal on the Mini's own screen** (not over SSH), logged in as `megadesk-command`, with nothing booked for the next 30 minutes:

```
cd ~/code/es-mini-agent && git fetch origin && git checkout --detach 02f97a954e00c302ceb793910a3ae598bada5a05 && /bin/bash scripts/install-preview-relay.sh
```

What it does: checks the Mac, the ports and the certificate, downloads MediaMTX v1.21.3 and verifies its fingerprint, installs it under `~/Library/Application Support/es-preview-relay`, starts it as the LaunchAgent `com.es.preview-relay`, and checks it answers. It ends with a block that starts `===== ES PREVIEW RELAY INSTALL REPORT =====`. **Copy that whole block to Anna in Slack.**

How to read it:
- `result: SUCCESS` → done. A `warnings: dns: … does not resolve` line only means the address isn't visible yet. Send it to Anna anyway.
- `STOPPED: nothing was changed` → a check failed before anything was installed. Send Anna the whole Terminal window.
- `result: FAILED, rolled back` → it installed, the check failed, and it undid itself. Send Anna the whole block.
- If macOS shows a prompt about **mediamtx** and finding devices on the local network, click **Allow**.

Safe commands you can suggest any time (they change nothing):

```
/bin/bash ~/code/es-mini-agent/scripts/install-preview-relay.sh --status
```

```
tail -40 ~/Library/Logs/es-preview-relay.log
```

To remove the relay (only if Anna asks):

```
/bin/bash ~/code/es-mini-agent/scripts/install-preview-relay.sh --uninstall
```

## The test window (later, with Anna)

Anna will send a short checklist. In outline:
1. Time a few camera switches on the iPad while it's still on cloud (a baseline).
2. Anna turns the switch on. Within about 30 seconds the iPad's status reads "● Live view · in room". No app restart needed.
3. Check a phone outside the room network still shows the preview ("via cloud". Phones always use cloud).
4. Stop the relay for a moment and check the iPad falls back to cloud within about 5 seconds, then comes back.
5. Record a 30-minute test take and confirm it uploads.

Anna can turn it off instantly at any time, and the iPad goes back to the cloud preview.

## Two questions Anna needs answered

- Is the room iPad on the **same network** as the Mini's wired connection? Which Wi-Fi name is the iPad on? (If the iPad is on a guest or isolated Wi-Fi, it can't reach the Mini and stays on cloud.)
- Is the delay on the **room iPad**, Robbie's **phone**, or both? Only the room iPad gets the faster path.

## Do not

- Do not open, print, copy or edit `~/Library/LaunchAgents/com.es.mini-agent.plist`. It holds passwords and keys.
- Do not run `git` inside `~/Documents/es-mini-agent`. That's the old live install, not a code checkout. The checkout is `~/code/es-mini-agent`.
- Do not edit files under `~/es-mini-agent-runtimes/` or `~/Library/Application Support/es-mini-agent/`, and do not run `install.sh` unless Anna sent the line.
- Do not run `launchctl unload`, `bootout` or `kill` on `com.es.mini-agent` or `com.es.obs-launcher`, and do not quit OBS during a booked session.
- Do not change the Mini's network settings or IP address (172.16.1.35 is what the new address points at).
- Do not run anything with `sudo`.
- If something looks wrong, collect the output and send it to Anna rather than trying fixes.

## Where things are on the Mini

| What | Where |
| --- | --- |
| Agent (running) | `~/es-mini-agent-runtimes/2026.11.05-1-20230f2` |
| Agent log | `~/es-mini-agent-runtimes/2026.11.05-1-20230f2/agent.log` (preview lines contain `ev=`; local preview shows `route=local`) |
| Relay (after step 2) | `~/Library/Application Support/es-preview-relay` |
| Relay log | `~/Library/Logs/es-preview-relay.log` |
| Backups | `~/es-backups/` |
| Code checkout | `~/code/es-mini-agent` (after the line above, it sits on commit `02f97a9`, which is expected) |
