# ES local camera preview: switch-on for bench-1 (build plan, 2026-11-07)

This is the context and plan for the session that makes the in-room camera preview switchable on for Robbie's room (bench-1): a relay installer for the Mac mini, the DNS + certificate recipe, the Worker flag runbook, Robbie's field sheet and messages, the SOP hook for future properties, and a round-1 audit prompt. Read it top to bottom before touching anything. The jump-start prompt is at the end.

**Trigger (Robbie, Slack, 2026-11-06 ET):** at 10:28 AM ET he ran the one-command Mini update: `result: SUCCESS`, agent `2026.10.20-1 -> 2026.11.05-1`, commit `20230f20fdd3345451e947e907b26455daed787b`, package `a62d02a7…c802`, runtime `/Users/megadesk-command/es-mini-agent-runtimes/2026.11.05-1-20230f2`, backup `~/es-backups/mini-20261106T152738Z`, warnings none. Then: *"Now that the Mini is on 2026.11.05-1, when can we switch on the local preview?"* and *"I'm still seeing decent delay on the live feed but no big deal."*

**Short answer the plan supports:** every line of code for local preview is already live or installed (Worker `477be4e`, kiosk build 48, Mini `2026.11.05-1`). It ships **dark**. Three things remain, none of them an app release: a DNS name + certificate for the Mini (L1), the MediaMTX relay installed on the Mini (L2), and the Worker flag turned on for bench-1 in a supervised one-hour window (L3). This session builds the installer, the recipes and the sheets so those three steps are one command each.

## Build status

Not started. The next session fills this section in (commits per A item, test counts, changes from the plan).

## Goal

**Make the local preview switchable on for bench-1 with one command per step, prove nothing changes while the flag is off, and hand Anna a round-1 audit prompt.**

By the end of the session:

1. Branch `claude/es-local-preview-20261107` in `/Users/annabui/build/es-local-preview-20261107-mini` is ahead of `6feb8bd` (PR #27 tip) with one commit per A item, local only. `node --test --test-concurrency=1 --test-timeout=120000 test/*.test.js` passes with 0 fail and at least the baseline count (see "Live state" below for the number read this session; new tests add to it).
2. `scripts/install-preview-relay.sh` installs MediaMTX **v1.21.3** (pinned by version and SHA-256) as the per-user LaunchAgent `com.es.preview-relay` from the reviewed templates in `relay/`, with preflight (not recording, agent healthy, certificate present), readback (pid, control API answers, TLS answers with the room hostname, agent unchanged), `--status`, `--uninstall`, `--dry-run`, an idempotent re-run, and a paste-ready report block. Proven in a sandbox on Anna's Mac under `/bin/bash` 3.2 with PATH shims (no real launchctl, no real Mini, no network in tests).
3. Fail-before tests exist for: a hash mismatch (nothing written), running while recording (STOP), missing certificate (STOP), `--dry-run` (writes nothing), `--uninstall` (removes plist, folder and nothing else), rendered config has no `__PLACEHOLDER__` left and the same top-level keys as the template.
4. `docs/LOCAL-PREVIEW.md` holds the switch-on runbook L1–L5 for Anna, one command per step with readback and rollback, including the certificate recipe (issued on Anna's Mac, copied to the Mini) and the Worker flag commands.
5. `docs/LOCAL-PREVIEW-FIELD-SHEET.md` is Robbie's one-hour proof window (baseline on cloud, flag on, in-room checks, off-LAN phone, relay stop/start fallback, 30-minute take), with pass/fail and what to send Anna.
6. `docs/ROBBIE-MESSAGES-2026-11-07.md` holds three drafts: the answer to "when" (now), the relay install line (after the certificate is on the Mini), the window brief. Drafted, never sent.
7. `docs/NEW-PROPERTY.md`, the wiki SOP, `README.md`, `SETUP-MAC-MINI.md`, `CLAUDE.md` and the `relay/` template headers point at the installer. Tool notes updated (wiki worktree).
8. The **round-1 audit prompt** is in `docs/local-preview-switch-on-audit-round1-2026-11-07.md` and shown to Anna in full.

**Live boundary.** Nothing live changes in this session: no push, PR, release, Worker secret, DNS record, certificate, Supabase write, Slack message, and nothing on the Mini. That holds until Anna returns a round-1 **GO** and then says yes to **each** runbook step. Read-only access allowed: SSH to the Mini (commands in Access), `sb os` SELECT, `cf es wrangler deployments list` / `secret list`, `cf es api GET`, `dig`, `gh api`/`gh pr view`, GitHub release downloads to a scratch folder.

## Decisions already made (do not reopen)

| Decision | Source |
| --- | --- |
| Local preview is in scope and ships behind the per-room Worker flag `LOCAL_PREVIEW_ROOMS` (unset = off). The room kiosk tries the in-room relay first and falls back to Cloudflare. Phones never get a relay pass. | Anna approved S5 goal 2026-11-02; L0 built 2026-11-02 (app `4559602`+`8c9698f`, Mini `736b5b9`) |
| The installed build is the probe: no separate probe build. Turning it on = one Worker secret for bench-1, in a supervised window; turning it off = delete the secret. | RELEASE-STEPS-LOCAL-PREVIEW L0-e, 2026-11-02 |
| The relay is MediaMTX v1.21.3, WebRTC only (WHIP in from OBS, WHEP out to the kiosk), control API on 127.0.0.1:9997 only, every read/publish authorised by the Worker's `/api/preview-auth`. Config = `relay/mediamtx.yml`; LaunchAgent = `relay/com.es.preview-relay.plist`. | Mini `736b5b9` (L0-d), test `preview-relay-config.test.js` |
| The relay is a per-user LaunchAgent, installed under `~/Library/Application Support/es-preview-relay`, never under `~/Documents`, started after OBS, never by `install.sh` or self-update (not in `modules.txt`). | S5 RELEASE-STEPS L2; macOS TCC gotcha (tool notes) |
| Hostname `preview-bench1.evrybdystudios.com`, one per room; A record to the Mini's fixed LAN IP, **DNS only** (never proxied). | S5 RELEASE-STEPS L1 |
| **Robbie's 2026-11-06 install report verifies the 2026.11.05-1 install.** The S6 rule "no install.sh on the Mini until a GO" is retired by the one-command installer (audit GO 11-06). The `update` op is still never queued. Merging Mini PRs #25/#26/#27 is now unblocked by the install, and is Anna's call (B7). | Robbie report 2026-11-06 10:28 ET; memory es-mini-one-command-install-2026-11-06 |
| **New in this plan (Claude's call, Anna may overturn in B1):** the certificate is issued on **Anna's Mac** with lego (DNS-01, a Cloudflare token scoped to DNS edit on this zone) and the two files are copied to the Mini. The DNS token never lives on Robbie's Mini. Renewal is manual every ~60 days until a second property justifies automation (known limit 7). The 11-02 draft put lego and the token in the Mini's keychain; that stays the alternative. | this plan |
| **New in this plan:** Robbie runs the relay installer in Terminal on the Mini (same rule as the agent installer). SSH to the Mini is for read-only probes and for copying the certificate files (a write Anna does herself, B4). | S6 rule; 11-06 install path |
| **New in this plan:** no new heartbeat field for the preview route. The heartbeat has 24 bytes of headroom (2024 of 2048). Evidence of the route comes from the Mini's `[preview] ev=… route=local` log lines and the kiosk diagnostics panel. | post-TF48 MP audit 2026-11-05 |
| The master-MKV overlay readback (L6) and the delay target are Anna's decisions, not this build's. The field sheet measures; it claims no number. | S5 RESULT; MP lane 2026-11-05 |
| Build on top of `6feb8bd` (PR #27 tip), stacked on `20230f2` (= the installed agent) and the installer docs this plan extends. | this plan |
| Mechanical builds are done by Claude directly, not handed to Codex. | memory es-claude-builds-directly-not-codex |

## Live state, verified read-only on 2026-11-07 (04:40–05:10 UTC)

### Robbie's Mini (bench-1), over SSH `megadesk-command@100.75.212.27`

| Item | Value |
| --- | --- |
| Agent | `/health` `ok:true`, `uptime_s 47803` (since the 11-06 install), not recording; launchd `com.es.mini-agent` pid **1287** (matches Robbie's report), `com.es.obs-launcher` loaded |
| Heartbeat row `studios.fleet_buildings` | `agent_version 2026.11.05-1`, `agent_commit 20230f20fdd3345451e947e907b26455daed787b`, `last_seen_at 2026-11-07 04:44:25Z` (fresh). `last_state` has no `preview`/`local_relay` key (by design) |
| Network | **Ethernet en0: Manual 172.16.1.35**, mask 255.255.254.0, router 172.16.0.1, default route via en0. Wi-Fi en1: DHCP 172.16.1.164, same /23. So the fixed IP that L1 needs already exists: **172.16.1.35**. Wi-Fi is also up (see known limit 8) |
| Relay | **Not installed.** `curl 127.0.0.1:9997/v3/paths/list` → connection refused; no `es-preview-relay` under Application Support; LaunchAgents are the two `com.es.*` plus Dropbox/Elgato/Google/Loopback |
| Tools | Homebrew 7.0.7 at `/opt/homebrew/bin/brew` (not on the non-interactive SSH PATH); no `lego`, `mediamtx` or `certbot` in `/opt/homebrew/bin`; macOS 15.3.1 (unchanged); LocalHostName `Megadesks-Mac-mini`, HostName not set |
| Preview log (new runtime) | 8 `ev=` lines so far; last `2026-11-06T19:10:23Z ev=viewer_join … viewers=2 route=cloudflare camera=1`. Every preview today goes **via cloud** |

### Cloud (read-only)

| Item | Value |
| --- | --- |
| Live Worker | version `266905e7-ccda-4330-9337-63106428d263` (2026-11-05 12:11Z) = es-os-app `477be4e` = `origin/main`. Live HTML sha `2db46699457f350493e70fdb4341e118edba57447a36ae09af09d05bb5d83f2e` on `api.evrybdystudios.com` = `git show 477be4e:index.html` |
| Local preview code on the live Worker | **Yes.** `lib/preview-token.js`, `api/preview-auth.js`, the `record.js` offers and the kiosk WHEP client (`8c9698f`) are all ancestors of `477be4e`. `POST /api/preview-auth` answers **401** today (route wired, flag off) |
| Worker flag | `LOCAL_PREVIEW_ROOMS` is **not set**: not in `worker/wrangler.jsonc` vars, not in `cf es wrangler secret list` (26 secrets; `SESSION_SECRET` present, which the preview passes sign with) |
| Kiosk build | TestFlight **1.0 (48)** = `fd81cfb`, an ancestor of `477be4e`, so the kiosk already has the in-room client. Build 49 was archived on 11-05 with the old HTML and was **not** uploaded (post-TF48 ledger). Robbie's Nov 4 feedback was against 48 |
| Post-TF48 release | PRs app #72, hb #44, Mini #26 **OPEN**; Trigger `20261105.1` = `df7d1aa`; Worker still `477be4e`. Not needed for local preview; see Out of scope |
| DNS | `dig +short preview-bench1.evrybdystudios.com` → **empty** (L1 not done). `api.evrybdystudios.com` → 172.67.222.161 / 104.21.38.121 |
| Cloudflare zone | `evrybdystudios.com` zone id `fb5d83458a12fdbf740131db5abd672d`, status active, on the **ES** account (`cf es api GET /zones?name=…` lists it; the `ab` account returns none). Nameservers moved from SiteGround 2026-09-01. Whether the cached ES token can **write** DNS is unverified (B3) |
| MediaMTX | **v1.21.3 is the latest release** (published 2026-10-25). Assets: `mediamtx_v1.21.3_darwin_arm64.tar.gz` (27,617,580 bytes), `checksums.sha256` (715 bytes). Its SHA-256 is not recorded yet (A1 records it) |
| lego | latest v5.6.0 (2026-10-28); Homebrew bottle `lego 5.6.0`; **not installed** on Anna's Mac |
| Upcoming bench-1 bookings (ET) | Mon Nov 9 10:30–11:30, 12:00–13:00, 15:30–16:30 · Thu Nov 12 15:00–16:00 · Tue Nov 17 10:00–11:00 · Thu Nov 19 10:00–11:00 · Fri Nov 20 14:00–15:00 · Mon Nov 23 09:30–10:30. **Quiet candidates for L2/L3: Sat Nov 7, Sun Nov 8, Tue Nov 10, Wed Nov 11** |
| ES Ops dashboard audit (session `4e977121…`) | Round 1 **GO** for Anna to start its ROLLOUT.md; it also read bench-1 at `2026.11.05-1` (11-07 04:23Z). Separate track, nothing here depends on it |

### Repos

| Repo | Branch / worktree | Tip | Notes |
| --- | --- | --- | --- |
| es-mini-agent | `claude/es-local-preview-20261107` in `/Users/annabui/build/es-local-preview-20261107-mini` | `6feb8bd` (= PR #27 tip, stacked on #26 `20230f2`) | this plan is its first commit |
| es-mini-agent | `origin/main` | `6ca8015` | what the `update` op would pull; never queue it |
| es-mini-agent | PRs | #24, #25 (`9e2bbf4`), #26 (`20230f2`), #27 (`6feb8bd`) all OPEN; release `v2026.11.05-1` published 11-06 09:14Z | #25/#26 merge now unblocked (B7) |
| es-os-app | `origin/main` | `477be4e` | nothing to build here |
| ab-wiki | `claude/es-local-preview-20261107-wiki` in `/Users/annabui/build/es-local-preview-20261107-wiki` | from `c1bb443c` (one-command wiki branch tip, so `LEARNINGS/tools/macos-launchd.md` is present) | HANDOVER pointer + `LEARNINGS/tools/mediamtx.md` added by the planning session |
| Mini test baseline at `6feb8bd` | see "Baseline" line below | run by the planning session |

**Baseline (full Mini suite at `6feb8bd`, planning session, `node --test --test-concurrency=1 --test-timeout=120000 test/*.test.js`):** 285 tests, 284 pass, 0 fail, 1 skip, 483 s. Same as the 11-06 audit. New tests add to 285.

## How the system works

### The chain, flag on

| Step | Who | What | Cite |
| --- | --- | --- | --- |
| 1 | Kiosk | sends `preview_start` every 25 s while it shows the studio (room session) | app `api/record.js:1551` allowlist |
| 2 | Worker | parses `LOCAL_PREVIEW_ROOMS` (JSON `{room: https-origin}`; anything malformed = off; needs `SESSION_SECRET`) | `lib/preview-token.js:38-54` |
| 3 | Worker → Mini | the queued `preview_start` command carries `local: { whipUrl: <origin>/bench-1/whip, publishToken: pv1.publish.… }` (10-min pass). Flag off: payload unchanged | `api/record.js:1085-1088`, `lib/preview-token.js:103-109` |
| 4 | Mini | validates the offer (`https`, `/<room>/whip`, `pv1.publish.` token) | `server.js:771-782` |
| 5 | Mini → relay | `PATCH 127.0.0.1:9997/v3/config/paths/patch/bench-1` with `forward: [{dest: whips://<cf-host>:443/<path>}]` (the Cloudflare WHIP URL, never logged) | `server.js:785-806` |
| 6 | Mini → OBS | `SetStreamServiceSettings` whip_custom to the relay with the bearer pass, `StartStream`, then waits ≤ 3 s for the output to be active; any failure → clear the forward, publish straight to Cloudflare, `local_error` set | `server.js:874-911`, `:96` |
| 7 | Mini → Worker | result carries `local_relay: true/false` (+ `local_error`) only when a relay was offered | `server.js:2231-2233` |
| 8 | Worker → kiosk | only a **room** principal, and only when `result.local_relay === true`, gets `local: { whepUrl, token: pv1.read.…, expires_at }` (2-min pass). Phones get the plain cloud reply | `api/record.js:2145-2147`, `lib/preview-token.js:91-101` |
| 9 | Kiosk | validates the offer and, when not on local and not blocked, joins WHEP at the relay with `Authorization: Bearer <read pass>` **on the next keepalive, no relaunch needed** | `index.html:8915-8920`, `:8388-8406` |
| 10 | Relay → Worker | MediaMTX POSTs `{action, path, protocol, token, …}` to `https://api.evrybdystudios.com/api/preview-auth`; 2xx allows. Only WebRTC read/publish of an enabled room with its own unexpired pass passes | `api/preview-auth.js:21-27`, `relay/mediamtx.yml` `authMethod: http` |
| 11 | Kiosk | no first frame within **5 s**, a failed join, or a stale frame → back to Cloudflare and the relay is skipped for **10 min**. Labels: "● Live view · in room" / "● Live view · via cloud". Triple-tap the status line while local is offered for the diagnostics panel (path, first-frame ms, frame age, fallbacks) | `index.html:6840`, `:8408-8420`, `:8424-8426` |

Flag off: step 3 adds nothing, step 7 adds nothing, step 8 adds nothing. Tests pin this: app `test/s5-local-preview-api.test.js:116` ("flag off: the kiosk reply is exactly the Cloudflare reply, even if a Mini reports a relay"), Mini `test/preview-local-relay.test.js:162` (flag off never calls the relay).

### Why the Worker sees the secret

`worker/wrangler.jsonc:5-6` sets `compatibility_date 2026-09-01` with `nodejs_compat`, so Cloudflare populates `process.env` from vars and secrets (default since compatibility date 2025-04-01). `lib/preview-token.js` reads `process.env.LOCAL_PREVIEW_ROOMS` the same way the live code reads `process.env.SESSION_SECRET`. A `wrangler secret put` creates a new Worker version with the **current** deployed code (Cloudflare tool note 2026-10-25): record the version id before it.

### The relay (MediaMTX v1.21.3)

- `relay/mediamtx.yml`: `authMethod: http` → the Worker; `authHTTPExclude: [{action: api}]`; `api: true` on `127.0.0.1:9997`; rtsp/rtmp/hls/srt/moq off; `webrtc: true` on `:8889` with `webrtcEncryption: true` and the room certificate; `webrtcAllowOrigins: ['capacitor://localhost']`; `webrtcLocalUDPAddress :8189`; `webrtcIPsFromInterfaces: true`; path `__ROOM_PATH__` `source: publisher`, forward set at run time. Placeholders `__APP_DIR__`, `__ROOM_HOST__`, `__ROOM_PATH__`.
- `relay/com.es.preview-relay.plist`: `RunAtLoad`, `KeepAlive`, logs to `~/Library/Logs/es-preview-relay.log`. Placeholders `__APP_DIR__`, `__HOME__`.
- `test/preview-relay-config.test.js:12-21` pins every top-level key to the v1.21.3 key set (`mediamtx.yml` sha256 `47cbbb2b…`, fetched 2026-11-02).
- Native forwarding: `paths.<name>.forward: [{dest: whips://…}]`, settable at run time via `PATCH /v3/config/paths/patch/{name}` (verified 11-02 against v1.21.3 `api/openapi.yaml`).

### Known limits (document in `docs/LOCAL-PREVIEW.md`; do not fix here)

1. **Master MKV overlay.** The preview overlay sits in the OBS program scene that the master records, so camera choice likely shows in the master's picture. L6 readback (production storage read, Anna's yes) decides; a design change is out of scope.
2. **Relay → Cloudflare forward is unproven in the field.** The Mini declares `local_relay: true` when OBS's output to the relay is active (`server.js:893`); it does not check that the relay's forward to Cloudflare is flowing. If the forward fails, the kiosk is fine and **phones lose the cloud picture**. The field sheet's off-LAN phone check catches it; rollback = flag off.
3. **Internet down = no preview at all**, local or cloud, because every relay read/publish asks the Worker. The kiosk shows its existing "unavailable" card.
4. **Saved publish pass expires after 10 min** (`PUBLISH_TTL_SECONDS 600`). A stream restore after `stream_lost` more than 10 min into a preview re-publishes with the saved settings (`server.js:925-940`); with the relay path that bearer is expired, so the route can silently become cloud until the next full start (post-TF48 MP audit P3). The kiosk then shows "via cloud". A Mini follow-up, not this build.
5. **No heartbeat field** for the route (24 bytes headroom). Evidence = `agent.log` `[preview] ev=… route=local` and the kiosk diagnostics panel.
6. **Launch gap.** The relay, like OBS and the agent, runs only while `megadesk-command` is logged in (FileVault is off on bench-1).
7. **Certificate renewal is manual** (Let's Encrypt 90 days; recipe in LOCAL-PREVIEW.md; `--status` prints the expiry). Expiry goes into memory as a dated reminder when the certificate is issued.
8. **Two active interfaces** on the Mini (en0 wired manual, en1 Wi-Fi DHCP). The relay advertises both as ICE candidates; the DNS name points at en0. Harmless in the same /23; if ICE pairs oddly in the field, turning Wi-Fi off on the Mini is Robbie's one-tap fix.
9. **Field-open items from 11-02**: Cloudflare accepting MediaMTX's forwarded WHIP with explicit `:443`; MediaMTX's CORS match for `capacitor://localhost` in WKWebView (the WHEP POST sends `Authorization`, so a preflight happens); WHEP across the iPad's mDNS-obscured candidates; router DNS-rebinding protection stripping a public name that resolves to 172.16.x; whether ATS touches WebRTC media. Each one fails safe to cloud; the field sheet names the failing layer.
10. **The 11-02 instruction "close and reopen the kiosk app" is unnecessary**: the kiosk joins the relay on the next 25-s keepalive (`index.html:8915-8920`). Keep one relaunch in the sheet anyway, as the Guided Access check.

## Tool notes checked

| Tool | File · Last checked | Applies here |
| --- | --- | --- |
| macOS launchd / TCC (Mini) | `LEARNINGS/tools/macos-launchd.md` · 2026-11-06 (on the wiki worktree) | launchd won't run scripts from `~/Documents` → relay lives under `~/Library/Application Support/es-preview-relay`, LaunchAgent in `~/Library/LaunchAgents`. `/bin/bash` 3.2 (no assoc arrays, `mapfile`, `${var,,}`); tests under `/bin/bash`. `defaults` ignores `$HOME` → the installer never calls `defaults`. Bearer tokens via `curl -H @-` from stdin, never argv (the installer only calls `/health`, no token needed; `--status` may call `/record/status` the same way `install.sh` does). `set -o pipefail` + `grep -q` SIGPIPE → use `grep … >/dev/null`. Per-user LaunchAgent needs a logged-in user (limit 6). **New gotcha to add in A7:** over SSH use `launchctl bootstrap gui/$(id -u) <plist>` / `bootout`, not `load`; a GUI session must exist. |
| Cloudflare | `LEARNINGS/tools/cloudflare.md` · 2026-10-19 (+11-06 lines) | `secret put` creates a new version with the current code → record the version id first (`266905e7…`). `cf es wrangler …` works with `--config worker/wrangler.jsonc`; one top-level deploy per release (not needed here). `cf`/`sb` tokens cached under `~/.cache/{cf,sb}`; a cache miss can't refresh (keypi path gone). **Add in A7:** zone `evrybdystudios.com` is on the ES account (id `fb5d8345…`); an A record to an RFC1918 address must be DNS-only (`proxied:false`); DNS-01 via lego `--dns cloudflare` needs `CF_DNS_API_TOKEN` with Zone→DNS→Edit scoped to this zone. |
| MediaMTX | `LEARNINGS/tools/mediamtx.md` · **2026-11-07, created by the planning session** | v1.21.3 is latest (2026-10-25); asset names; key set pinned by test; HTTP auth body shape; forward via PATCH; control API local only. A1 adds the tar SHA-256 and anything the sandbox teaches. |
| Supabase | `LEARNINGS/tools/supabase.md` · 2026-11-06 | read-only here (`fleet_buildings`, `booking_reservations`); nothing to write. |
| Let's Encrypt / lego | none (covered inside `mediamtx.md` "certificate" section) | lego 5.6.0 via Homebrew on Anna's Mac; `lego … run` then `lego … renew --days 30`; files land in `<path>/certificates/<host>.crt|.key`. |
| TestFlight | n/a | no app build in this plan; kiosk 48 already has the client. |

## Out of scope (document, don't build)

| Item | What the code must still guarantee |
| --- | --- |
| Post-TF48 release (app #72, hb #44, Mini #26, migration 0124, Build 49) | Independent. If the Worker is redeployed from a newer `main`, the `LOCAL_PREVIEW_ROOMS` secret persists across deploys; the flag code is in every later `main`. |
| ES Ops dashboard Phase 0 rollout (audit GO 11-07) | Independent. Its heartbeat history reads the same `fleet_buildings` PATCH; no new heartbeat field here, so nothing changes for it. |
| Master-overlay design change (L6 outcome b) | The relay carries whatever OBS streams; nothing here alters scenes or outputs. |
| Automated certificate renewal on the Mini | `--status` prints the expiry; the runbook has the manual renew. |
| Delay target / latency acceptance | The field sheet records cloud and local medians; no claim. |
| FSU or any second property | `scripts/install-preview-relay.sh` takes room and hostname as inputs so a second room is the same command; the SOP gets a step, no FSU specifics. |
| Mini `preview_route` heartbeat field, publish-pass refresh (limit 4), forward health check (limit 2) | Documented in LOCAL-PREVIEW.md "follow-ups" with the cite; not built. |
| Headless / FileVault policy | unchanged (limit 6). |

## Work package A: Claude builds, local only

Order by dependency. One commit per item, trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Each item names its test requirement.

**A0. Re-verify, read-only (no commit).** Re-run the Access commands: `dig`, the SSH probe (IPs, relay absent, agent health), `cf es wrangler deployments list` + `secret list` (no `LOCAL_PREVIEW_ROOMS`), `sb os` heartbeat row, `gh pr list`. If anything differs from "Live state", note it in "Build status" before building. Run the full Mini suite once and record the count.

**A1. `scripts/install-preview-relay.sh` + `test/install-preview-relay.test.js`.** Why: L2 was a hand-typed 12-line recipe with "nothing here is tested"; Robbie needs one line with a report, like the agent installer.
- Inputs (env or flags): `ES_RELAY_ROOM` (default `bench-1`), `ES_RELAY_HOST` (required, e.g. `preview-bench1.evrybdystudios.com`), `ES_RELAY_CERT_DIR` (folder holding `<host>.crt` and `<host>.key`, default `$HOME/es-preview-certs-inbox`), `MEDIAMTX_VERSION=v1.21.3`, `MEDIAMTX_TAR_SHA256=<pinned>` (A1 downloads the darwin_arm64 tar once into the scratchpad, records its SHA-256 in the script and in this plan's Build status), `ES_RELAY_TAR` (offline path, for tests), `--dry-run`, `--status`, `--uninstall`, `--yes`.
- Preflight: arm64 + Darwin; `/bin/bash` 3.2 safe; a GUI session for the current user (`launchctl print gui/$(id -u)` succeeds); agent `/health` reachable and `recording:false`, `paused:false` (port from the agent plist `PORT`, default as `install.sh` does); certificate files present, key mode becomes 600; templates present next to the script (`relay/mediamtx.yml`, `relay/com.es.preview-relay.plist`); refuse if `com.es.preview-relay` is already loaded unless `--reinstall`.
- Install: download tar + `checksums.sha256` to a mode-700 temp dir, verify the tar against **both** the pinned SHA-256 and the checksums file, extract only `mediamtx`, `codesign`/`xattr -d com.apple.quarantine` the binary, place under `APP=$HOME/Library/Application Support/es-preview-relay` (mode 700), copy certs to `$APP/certs/certificates/`, render the two templates with `sed` using `|` delimiters (paths contain spaces), `chmod 600` the yml, `plutil -lint` the plist, `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.es.preview-relay.plist`.
- Readback (each a STOP + automatic `bootout` on failure): pid in `launchctl list`; `curl -s 127.0.0.1:9997/v3/paths/list` is JSON; `curl -sS --resolve "$HOST:8889:127.0.0.1" https://$HOST:8889/` completes TLS (any HTTP status), with `--cacert` not needed (public CA); certificate `-enddate` printed; agent `/health` still ok with the same pid; log file exists.
- Report block `===== ES PREVIEW RELAY REPORT =====` mirroring `install.sh`: result, mediamtx version + sha, room, host, folder, pid, cert expiry, agent pid unchanged, warnings, uninstall command, time UTC. Never prints key material or tokens.
- `--uninstall`: `bootout`, remove plist + `$APP`; refuses while the agent is recording. `--status`: pid, paths list, cert expiry, last 5 log lines. Idempotent re-run exits 0 with "ALREADY INSTALLED" when version, sha, host and config hash match.
- Tests (fake `HOME`, PATH shims for `launchctl`, `plutil`, `curl`, `codesign`, `xattr`, a fake agent on a free port, a local tar built from a stub binary): happy path writes the expected files and renders no `__…__`; rendered yml top-level keys == template keys (reuse `V1_21_3_KEYS` from `test/preview-relay-config.test.js`); sha mismatch → nothing under `$HOME` changes; recording → STOP; missing cert → STOP; `--dry-run` → no writes, no `launchctl`; readback failure → `bootout` called and exit 1; `--uninstall` removes exactly the plist and folder; re-run → ALREADY INSTALLED. Run under `/bin/bash`. Fail-before claims: run each negative case with the readback shim forced green to show the test would catch the opposite behaviour.

**A2. `docs/LOCAL-PREVIEW.md`.** Why: RELEASE-STEPS lives on an unmerged wiki branch and still says "Build 46"; Anna needs the current one-command-per-step runbook in the repo. Sections: what is live today (the table above, with hashes); L1 DNS (`cf es api POST /zones/fb5d83458a12fdbf740131db5abd672d/dns_records` with `{"type":"A","name":"preview-bench1","content":"172.16.1.35","ttl":300,"proxied":false}` or the dashboard; readback `dig`; rollback DELETE); L1b certificate on Anna's Mac (`brew install lego`; token scope; `lego --accept-tos --email <ops> --dns cloudflare --domains preview-bench1.evrybdystudios.com --path ~/es-preview-certs run`; readback `openssl x509 -enddate`; copy with `scp -i ~/.ssh/id_ed25519_es_mini <crt> <key> megadesk-command@100.75.212.27:es-preview-certs-inbox/` after `ssh … 'mkdir -p -m 700 es-preview-certs-inbox'`); L2 Robbie's one line (`cd ~/code/es-mini-agent && git fetch && git checkout <tag or commit> && ES_RELAY_HOST=… /bin/bash scripts/install-preview-relay.sh`; or the release-asset form once the script is in a release, Anna picks in B7); L3 flag on (`cf es wrangler deployments list` to note the version, then `printf '%s' '{"bench-1":"https://preview-bench1.evrybdystudios.com:8889"}' | cf es wrangler secret put LOCAL_PREVIEW_ROOMS --config worker/wrangler.jsonc`; readback `secret list` shows the name; functional readback = kiosk label); L4 pass/fail (from the field sheet); L5 keep or `cf es wrangler secret delete LOCAL_PREVIEW_ROOMS --config worker/wrangler.jsonc` (+ optional `--uninstall`); L6 master readback commands (Anna's yes); renewal recipe; known limits 1–10; follow-ups with cites. One command per step, no `#` comment lines inside commands, no `read -rs`.

**A3. `docs/LOCAL-PREVIEW-FIELD-SHEET.md`.** Why: Robbie's checklist from 11-02 says build 46 and asks for an app relaunch that is not needed. Update to: kiosk 48 (or 49 when it ships), Mini 2026.11.05-1, window ≈ 1 h outside bookings (candidates above), baseline on cloud (10 switches + 10 stopwatch photos), Anna sets the flag, kiosk reads "in room" within 30 s without relaunch, then one relaunch under Guided Access, diagnostics panel values, off-LAN phone "via cloud" and plays, Anna/Robbie `launchctl bootout gui/$(id -u)/com.es.preview-relay` → kiosk falls back within ~5 s, `bootstrap` again → "in room" on a later keepalive, 30-min take with ≥10 switches and one relay stop/start → files + master + Sessions entry. Pass/fail table for 06-1/06-2/06-5/06-3, what to send, and how to read the Mini log (`grep 'ev=' ~/es-mini-agent-runtimes/2026.11.05-1-20230f2/agent.log | tail -40`, look for `route=local`).

**A4. `docs/ROBBIE-MESSAGES-2026-11-07.md`.** Why: Robbie asked "when" and mentioned delay; Anna wants a plain answer she can send. Draft 1 (send now): the install report is confirmed from the cloud side (version + commit + fresh heartbeat); the delay he sees is the cloud path, and the in-room preview is exactly the fix; three steps left (a name + certificate for the Mini, the relay install = one line in Terminal, a one-hour test window with the switch on); two asks: is the room iPad on the same network as the Mini's wired connection (the Mini is 172.16.1.35), and which of Sat/Sun/Tue/Wed suits for the hour. Draft 2 (after B4): the install line in a code block plus "run it in Terminal on the Mac mini, nothing booked for 30 minutes, paste the report back". Draft 3: the window brief = the field sheet's Robbie half. No secrets, no client names, no em dashes.

**A5. Docs wiring.** `docs/NEW-PROPERTY.md` + wiki SOP (`Clients/ES/SOP-NEW-PROPERTY-ONBOARDING-2026-11-06.md`, wiki worktree) get an optional step "Local preview relay (per room): fixed IP, DNS name, certificate, `install-preview-relay.sh`, flag entry in `LOCAL_PREVIEW_ROOMS` (a JSON object: one key per room)"; `README.md`, `SETUP-MAC-MINI.md`, `CLAUDE.md` one line each; `relay/mediamtx.yml` and `relay/com.es.preview-relay.plist` headers now say "installed by `scripts/install-preview-relay.sh`" instead of "Anna's runbook L2". Test: `test/preview-relay-config.test.js` still passes (template unchanged apart from the comment); add an assertion that the template's placeholder set is exactly `{__APP_DIR__, __ROOM_HOST__, __ROOM_PATH__}` / `{__APP_DIR__, __HOME__}` (the installer depends on it).

**A6. Session log + tool notes (wiki worktree `/Users/annabui/build/es-local-preview-20261107-wiki`, branch `claude/es-local-preview-20261107-wiki`).** `Clients/ES/Session Logs/2026-11-07-es-local-preview-switch-on.md` in the format of `2026-11-06-mini-one-command-install.md`; `LEARNINGS/tools/mediamtx.md` (tar sha, sandbox findings, `Last checked` today); `cloudflare.md` (zone account, DNS-only A record, DNS-01 token scope); `macos-launchd.md` (`bootstrap gui/` vs `load`, relay LaunchAgent). Any gotcha the build hits goes into the tool file before A7.

**A7. Build status + memory.** Fill "Build status" (commits, counts, changes from the plan). Update memory `es-s5-kiosk-preview-2026-11-02.md` with a dated line and the `MEMORY.md` hook.

**A8. Round-1 audit prompt** `docs/local-preview-switch-on-audit-round1-2026-11-07.md`, in the format of `docs/mini-one-command-install-audit-round1-2026-11-06.md` (Where / What changed / What to check / Rules / Commands / Gates that are not code / Return format). It must: scope the review to `6feb8bd..HEAD`; ask for **one verdict**: GO or NO-GO for "Anna runs LOCAL-PREVIEW.md L1–L2 (DNS, certificate, Robbie's relay install) and then L3 (flag on for bench-1 in a supervised window)"; make the auditor read-only (no edits, pushes, deploys, secrets, DNS, SSH writes, Slack); require a sandbox reproduction for any claimed bug or the mark "unproven"; list concrete checks (hash/path traversal in the tar, nothing written before verification, bash 3.2, no secrets in output or argv, `bootout` on every failed readback, `--uninstall` scope, idempotency, placeholders, rendered yml key set, the docs match the script's flags and strings, the field sheet matches the code's fallback bounds 5 s / 10 min / 25 s keepalive, Robbie drafts have no secrets/client names/em dashes, no change to `*.js` in `modules.txt`, `install.sh`, `obs-launcher.sh`, `self-update.js`); list the gates that are not code (B1–B8 below, L6, the delay target, PR merge order); and **be shown to Anna inline in full**.

## Work package B: needs Anna (ask once, early, in one message; never blocks A)

| # | Ask | One step |
| --- | --- | --- |
| B1 | Confirm the certificate path: issued on your Mac with lego and copied to the Mini (plan default), or lego + DNS token on the Mini (11-02 draft). | reply "Mac" or "Mini" |
| B2 | Send Robbie draft 1 (after A4) and relay his two answers: is the room iPad on the Mini's network, and which day for the hour. | paste the reply |
| B3 | Cloudflare: confirm you can edit DNS on the ES account (zone `fb5d8345…`), or create a token scoped Zone→DNS→Edit on `evrybdystudios.com` only, kept in your keychain. Nothing is created until the GO. | `cf es verify` |
| B4 | After GO: L1 DNS record, L1b certificate on your Mac, copy the two files to the Mini (commands in LOCAL-PREVIEW.md). | one command per step |
| B5 | After B4: send Robbie draft 2; he runs the relay line in Terminal in a quiet 30 min; he pastes the report; Claude reads it back. | paste the report |
| B6 | L3 window: you set the flag (`secret put`), Robbie runs the field sheet, you delete or keep the flag (L5). | one command each |
| B7 | Repo: push the branch + PR stacked on #27 after GO; decide the merge order of #25/#26/#27 now that the install is verified; optionally attach `install-preview-relay.sh` to a release so Robbie's line can pin a hash like the agent installer. | `gh pr create …` (Claude drafts the command) |
| B8 | L6 master readback: a yes for one production storage read of a recent take (Claude runs the ffprobe/ffmpeg commands, read-only), then decision (a) accept or (b) design change. | reply yes + the take |

## Access

**Works (read-only, used by the planning session):**
```
ssh -o BatchMode=yes -o ConnectTimeout=8 -i ~/.ssh/id_ed25519_es_mini megadesk-command@100.75.212.27 'curl -s -m 3 http://127.0.0.1:${PORT:-8787}/health; launchctl list | grep com.es.; curl -s -m 2 http://127.0.0.1:9997/v3/paths/list || echo no-relay; networksetup -getinfo Ethernet; networksetup -getinfo Wi-Fi'
sb os "select building_id, agent_version, agent_commit, last_seen_at from studios.fleet_buildings"
sb os "select starts_at at time zone 'America/New_York' as starts_et, ends_at at time zone 'America/New_York' as ends_et, status from studios.booking_reservations where ends_at > now() and status not in ('released','expired','cancelled') order by starts_at limit 12"
cd /Users/annabui/code/es-os-app && cf es wrangler deployments list --config worker/wrangler.jsonc
cd /Users/annabui/code/es-os-app && cf es wrangler secret list --config worker/wrangler.jsonc
cf es api GET "/zones?name=evrybdystudios.com"
dig +short preview-bench1.evrybdystudios.com
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.evrybdystudios.com/api/preview-auth -H 'content-type: application/json' --data '{"action":"read","path":"bench-1","protocol":"webrtc","token":"x"}'
gh api repos/bluenviron/mediamtx/releases/tags/v1.21.3 --jq '.assets[] | .name + " " + (.size|tostring)'
curl -fL -o "$SCRATCH/mediamtx_v1.21.3_darwin_arm64.tar.gz" https://github.com/bluenviron/mediamtx/releases/download/v1.21.3/mediamtx_v1.21.3_darwin_arm64.tar.gz
```
The agent's `PORT` is in its plist; `install.sh` shows how to read it (`JS_ENVGET`). The relay `agent.log` lives in `~/es-mini-agent-runtimes/2026.11.05-1-20230f2/`; `~/Documents/es-mini-agent` is **unreadable over SSH** (TCC).

**Blocked by the classifier or by rule (Anna runs them):** `cf es wrangler secret put/delete`, `cf es api POST/DELETE` on DNS, `scp`/`ssh` that writes on the Mini, `launchctl` on the Mini, `git push`, `gh pr create`, `gh release`, Slack. One grep over several docs was denied once this session for no stated reason; re-run such a command as separate simple greps.

**Forbidden:** queueing the Mini `update` op; `install.sh` or self-update on the Mini; writing to `~/Documents/es-mini-agent`; running real `launchctl`, `defaults` or `plutil` against Anna's own `~/Library` in tests (fake `HOME` + PATH shims only); printing or committing any secret or token; sending messages.

## Rules

- Verify before relying: every hash, ID and count above was read on 2026-11-07; re-read in A0 and record differences.
- Fail-before tests for every fix and every guard: show the negative case fails without the guard.
- Offline checks: `cd /Users/annabui/build/es-local-preview-20261107-mini && /bin/bash -n scripts/install-preview-relay.sh && node --test --test-concurrency=1 --test-timeout=120000 test/install-preview-relay.test.js test/preview-relay-config.test.js test/preview-local-relay.test.js`, then the full suite once at the end. rtsp/upload tests can flake under load: rerun the file alone before calling it a failure. Kill only PIDs you started (no `pkill` patterns). `timeout(1)` does not exist on macOS.
- Pins: MediaMTX `v1.21.3` (latest, 2026-10-25); `/bin/bash` 3.2.57 on the Mini; node on the Mini `/usr/local/bin/node` v24.18.0 (the installer does not need node; if it uses it for JSON, use the plist's node path like `install.sh`); wrangler via `cf es wrangler` (4.127.1 local, 4.158.0 available; do not upgrade in this session).
- Anna's working style: plain language, short lines, one command per step in a code block, no `#` comment lines inside commands (interactive zsh has no comments), no `read -rs`. Secrets: never print, store or commit; if one leaks, list it to rotate as a reminder, not a blocker. Client messages are drafted, never sent.
- Docs and prompts stay in the repo (`docs/`), never on the Desktop.

## Open questions for the client (message pack; they don't block the build)

1. Is the room iPad on the same network as the Mini's wired port (172.16.0.0/23)? Which Wi-Fi name? (If the kiosk is on a guest/isolated SSID, the relay is unreachable and the kiosk stays on cloud.)
2. Does the room's router or campus DNS strip public names that resolve to private addresses? (Readback: `nslookup preview-bench1.evrybdystudios.com` on the room Wi-Fi after L1.)
3. Which day for the one-hour window: Sat Nov 7, Sun Nov 8, Tue Nov 10 or Wed Nov 11 (Mon Nov 9 has three bookings)?
4. Is Lockdown Mode off on the kiosk iPad, and which iOS version?
5. Is the delay he sees on the kiosk, the phone, or both? (Both go via cloud today; only the kiosk gets the in-room path.)

## Session return format

1. **Built:** table commit → item → one line, for A1–A8; tip hash; full-suite count (tests / pass / fail / skip) and the three focused files.
2. **Changes from the plan**, each with why.
3. **Live state deltas** found in A0.
4. **B asks** still open, one line each, in the order Anna should do them.
5. **Known limits** confirmed or added (numbered as above).
6. **Robbie draft 1** inline (for Anna to send).
7. **The audit prompt inline in full.**
8. One line: nothing live changed (or exactly what did, with Anna's yes).

## Jump-start prompt (paste into the next session)

```
ES local camera preview: switch-on for bench-1. This session is for building.

Read, in order:
1. /Users/annabui/build/es-local-preview-20261107-mini/docs/local-preview-switch-on-build-plan-2026-11-07.md (the plan; branch claude/es-local-preview-20261107 on 6feb8bd)
2. /Users/annabui/build/es-local-preview-20261107-mini/docs/INSTALL.md and docs/mini-one-command-install-build-plan-2026-11-06.md (the agent installer this mirrors; install.sh is the style reference)
3. Tool notes on the wiki worktree /Users/annabui/build/es-local-preview-20261107-wiki: LEARNINGS/tools/macos-launchd.md, cloudflare.md, mediamtx.md
4. relay/mediamtx.yml, relay/com.es.preview-relay.plist, test/preview-relay-config.test.js, test/install-v2.test.js (the shim pattern), and the plan's "How the system works" cites in server.js and es-os-app origin/main

Goal: finish work package A (A0–A8) in this session. End state: a tested, bash-3.2-safe scripts/install-preview-relay.sh with --status/--uninstall/--dry-run and a report block; docs/LOCAL-PREVIEW.md (runbook L1–L6, one command per step, known limits 1–10); docs/LOCAL-PREVIEW-FIELD-SHEET.md; docs/ROBBIE-MESSAGES-2026-11-07.md (3 drafts, never sent); SOP/README/CLAUDE.md wiring; wiki session log + tool notes; memory updated; the round-1 audit prompt in docs/ and shown to Anna in full.

Ground rules:
- Local commits only. Nothing live (no push, PR, release, Worker secret, DNS, certificate, SSH write, Supabase write, Slack, nothing on the Mini) until an audit GO and Anna's yes for each runbook step.
- Read-only live access allowed: the commands in the plan's Access section (SSH probe, sb os SELECT, cf es wrangler deployments/secret list, cf es api GET, dig, gh api, GitHub release download to the scratchpad).
- Send the B asks (B1–B8) in one message early, then keep building.
- Verify the plan against code and live data in A0; record deltas in Build status.
- Tests run under /bin/bash with a fake HOME and PATH shims; never touch the real ~/Library or launchd.

Finish with the return format at the end of the plan.
```
