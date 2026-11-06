# ES Mac mini: one-command install/update + new-property SOP (build plan, 2026-11-06)

This is the context and plan for the session that builds the one-command Mac mini installer, the new-property onboarding SOP, and Robbie's update instructions. Read it top to bottom before touching anything. The jump-start prompt is at the end.

Anna's ask (2026-11-06, in her words): "as the build now become really good and stable we need to make sure all future mac mini just need to run a command it will install everything as needed", "update the SOP as well and have a SOP instruction how we configure/onboard a new property to set this in motion", and "let Robbie know if there's anything the Mac mini needs to work on". Robbie (Slack, 2026-11-05 ET): the app worked perfectly, he dropped one company and is partnering with the company he met that day, studios will be installed soon, and he asked for "the Mac mini update that I have to do" so he can run it tomorrow (Nov 6 ET).

## Build status (2026-11-06, build session; local only)

- **A1–A8 done** on this branch (`20230f2..HEAD`), plus one self-review fix (`0867c7f`).
- Full suite: 283 tests / 282 pass / 0 fail / 1 skip before the fix. Installer files: 50/50 after it. Final count in the session return.
- `install.sh` v2 SHA-256 `8caa2507aae966a40bd48bb38da104ca67421248daf2ffe85c8c815b1dd2242f`. Round-1 audit prompt: `docs/mini-one-command-install-audit-round1-2026-11-06.md`.
- **Changes from this plan:**
  - `ES_MINI_COMMIT` is a required input (the tar name and folder need `<c7>`; identity = commit + hashes).
  - `ES_MINI_CONFIG` is read literally, not sourced (a `$` or backtick in a secret would run).
  - A healthy relay poll is silent in `agent.log`, so the readback checks the `relay: polling` start line plus no `poll GET 401/403`. Other relay errors are a warning.
  - A failed readback rolls back automatically.
  - `update-state.json` is written in the new folder, so `diag` and `agent_commit` show the real commit.
  - `AUTO_TUNNEL` (cloudflared quick tunnel) is dropped.
  - The S6 Phase I extract path bug (the tar extracts to `es-mini-agent-<V>-<c7>/`, not `<V>-<c7>/`) is handled in v2.
  - The plan's `api/record.js:657-661` heartbeat cite is `:965-990` at `477be4e`.
- **Not done here (Anna):** B1–B7.

## Goal

**Make every future Mac mini (and Robbie's existing one) installable or updatable with one command that carries over every setting, verifies what it installs, reads back the result and can roll back; write the SOP that takes a new property from "signed" to "first take"; draft Robbie's messages; then hand Anna an audit prompt.**

By the end of the session:

1. Branch `claude/es-mini-one-command-install-20261106` in `/Users/annabui/build/es-mini-one-command-20261106-mini` is ahead of `20230f2` with one commit per A item, local only. `node --test --test-concurrency=1 --test-timeout=120000 test/*.test.js` passes with 0 fail and at least the baseline count (258 tests, 257 pass, 1 skip at `20230f2`; new tests add to it).
2. `install.sh` (v2) installs a **pinned, hash-verified release** into a versioned folder outside `~/Documents`, carries over the **whole** live plist environment (not a fixed key list), refuses to run while the agent is recording or uploading, backs up first, reads back version/health/launchd, and offers `--rollback`. Proven end to end in a sandbox on Anna's Mac under `/bin/bash` 3.2 with PATH shims (no real launchctl, no real Mini).
3. `scripts/build-mini-package.sh` lives in the repo and reproduces the 2026-11-05 package byte for byte: tar SHA-256 `a62d02a7d2d1a1c24f61383f5361a42f1a7a22c87da969af4f09addf8ab3c802` for `20230f2`.
4. Fail-before tests exist for: the key-drop bug, running while recording, a hash mismatch, and rollback.
5. `docs/INSTALL.md` (Robbie's 3-step update + rollback), `docs/NEW-PROPERTY.md` (repo side) and the wiki SOP `Clients/ES/SOP-NEW-PROPERTY-ONBOARDING-2026-11-06.md` are written; README, `SETUP-MAC-MINI.md` and `CLAUDE.md` point at them.
6. `docs/ROBBIE-MESSAGES-2026-11-06.md` holds two drafts (health note now; update instruction once the release exists). Drafted, never sent.
7. The docs, memory and session log are updated, and the **round-1 audit prompt** is in the repo and shown to Anna in full.

**Nothing live changes in this session** (no push, PR, merge, GitHub release, Worker/Trigger deploy, Supabase write, Slack message, and nothing on the Mini) unless Anna returns a round-1 **GO** and then says yes to **each** runbook step. Read-only access allowed: SSH to the Mini (commands in Access), `sb os` SELECT, `cf es wrangler deployments list`, `gh pr view`.

## Decisions already made (do not reopen)

| Decision | Source |
| --- | --- |
| Every future Mac mini is set up with one command that installs everything needed. The same command updates an existing Mini. | Anna, 2026-11-06 (this ask) |
| Write an SOP for onboarding a new property, and update the existing setup SOP (`SETUP-MAC-MINI.md`) to point at it. | Anna, 2026-11-06 (mid-session message) |
| Robbie gets a message about what the Mini needs; it is drafted here, Anna sends it. | Anna, 2026-11-06; standing rule: client messages are drafted, never sent |
| Robbie runs the Mini update "tomorrow" (Nov 6 ET). Which path he uses is B1 (Anna). | Robbie Slack 2026-11-05 ET; Anna decides |
| The current Mini candidate is agent `2026.11.05-1` = commit `20230f2` (PR #26, stacked on #25 `9e2bbf4`). Package built 2026-11-05 at `/private/tmp/es-posttf48-mini-pkg/out/`. | post-TF48 ledger, RUNBOOK-ANNA-GATES §6 |
| Package identity = commit + per-file hashes, never the version string alone. Feature branches are never installed directly. | S6 runbook, 2026-11-02 |
| New runtimes go in their own folder outside `~/Documents`; the old folder is left untouched so rollback is a plist swap. | S6 runbook Phase I; TCC gotcha (see Tool notes) |
| **Until the new installer has an audit GO, the S6 rule stands:** never run `install.sh`, the curl one-liner, `update` or self-update on the Mini to switch runtimes. **This build replaces that rule** with "run the pinned installer"; the `update` op stays forbidden (it pulls GitHub `main`). | S6 runbook; CLAUDE.md; overridden by Anna's 2026-11-06 ask |
| Mini PRs #25 and #26 stay unmerged until the package install is verified, because the live `update` op pulls `main`. The new installer pins a commit, so merge order no longer matters for installs, but the rule stays until the `update` op is redesigned (out of scope). | RUNBOOK-ANNA-GATES §1; HANDOVER 2026-11-05 |
| Robbie types the commands in Terminal on the Mini; Anna approves the window. Running over SSH is allowed only for read-only probes. | S6 runbook; 11-05 runbook 6c "[confirm]" resolved by the TCC finding below |
| Build on top of `20230f2`, not `main` (`6ca8015`): the installer ships with the candidate the Mini will receive. | this plan (the installer must be tested against the same modules.txt it installs) |
| Mechanical builds are done by Claude directly, not handed to Codex. | memory es-claude-builds-directly-not-codex |

## Live state, verified read-only on 2026-11-06

### Robbie's Mini (`bench-1`), read over SSH at about 08:15 UTC

| Item | Value |
| --- | --- |
| Agent (from `diag`) | `"agent":"2026.10.20-1"`, `commit` `05e659ca…` (stale: from `update-state.json` of 2026-10-01), i.e. Build 42 `9ba2f22` + the Oct 26 mic hotfix |
| `/health` | `ok:true`, `uptime_s` 929248 (about 10.8 days), not recording |
| launchd | `com.es.mini-agent` pid 77993 and `com.es.obs-launcher` loaded; plist mode 600 |
| WorkingDirectory | `/Users/megadesk-command/Documents/es-mini-agent` (blocked over SSH: "Operation not permitted") |
| Node in plist | `/usr/local/bin/node` v24.18.0 (nodejs.org pkg; `/opt/homebrew/bin/node` does not exist) |
| Plist env keys (names only) | exactly the 22 keys `install.sh` writes; no hand-added key today, so nothing has been dropped yet |
| Backups | `com.es.mini-agent.plist.bak-20260907` only; no `~/es-backups`, no `~/es-mini-agent-runtimes` |
| Tools | Homebrew `/opt/homebrew/bin/brew`; `ffmpeg` + `ffprobe` from Homebrew; `/bin/bash` 3.2.57; login shell zsh |
| OBS | 32.1.0; plugins `source-record.plugin`, `distroav.plugin`; Loopback daemon, Elgato Camera Hub, Dropbox, Tailscale present |
| Hardware / OS | `Mac16,10` (M4 Mac mini), arm64, macOS 15.3.1, FileVault **off**, `pmset autorestart 1`, sleep 0, displaysleep 60 |
| Disk | 110 GiB free of 228 GiB (43 % used) |
| Network to Anna | SSH `megadesk-command@100.75.212.27` with `~/.ssh/id_ed25519_es_mini` works (Tailscale app, no `tailscale` CLI on Anna's Mac) |

### Cloud (read-only)

| Item | Value |
| --- | --- |
| `studios.fleet_buildings` | one row: `bench-1`, `agent_version 2026.10.20-1`, `agent_commit 05e659ca…`, `last_seen_at 2026-11-06 08:10:47Z` (fresh), `studio_id null`, `operator_owned false` |
| Columns | `building_id, obs_sources, note, created_at, updated_at, upload_webhook_url, cameras, looks, default_look, last_seen_at, agent_version, agent_commit, last_state, alerted_at, cam_alerted_at, operator_owned, studio_id` |
| Live Worker | `266905e7-ccda-4330-9337-63106428d263` (2026-11-05 12:11Z) = app `477be4e` code; HTML `2db46699…` (post-TF48 app #72 NOT live) |
| Honeybook | Trigger `20261105.1` = `df7d1aa` (hb #44 NOT live); `es-fleet-heartbeat` alerts "Mini stopped polling" from `last_seen_at` |
| Migration 0124 (`mic_check` op) | not applied |

### Repos

| Repo / item | State |
| --- | --- |
| `es-mini-agent` `origin/main` | `6ca8015` (Oct 6). Repo is **PUBLIC**, so raw URLs and release assets need no auth. Tags: only `pre-*` safety tags; no releases. |
| PR #25 | `claude/es-build46-integration-20261102` @ `9e2bbf4`, agent 2026.11.02-1, OPEN, REVIEW_REQUIRED |
| PR #26 | `claude/es-post-tf48-robbie-20261105` @ `20230f2`, agent 2026.11.05-1, OPEN, stacked on #25 |
| Build branch (this plan) | `claude/es-mini-one-command-install-20261106` @ `20230f2` in `/Users/annabui/build/es-mini-one-command-20261106-mini`, local only |
| Package | `/private/tmp/es-posttf48-mini-pkg/out/`: `es-mini-agent-2026.11.05-1-20230f2.tar` (`a62d02a7…c802`, 29 files, 23 modules), `SHA256SUMS-files-2026.11.05-1.txt` (`3151edba…`), plus the two S6 lists |
| Offline checks at `20230f2` | `node --test --test-concurrency=1 --test-timeout=120000 test/*.test.js` → 258 tests, 257 pass, 0 fail, 1 skip, 348 s (2026-11-06). Note: `timeout(1)` does not exist on macOS. |
| es-os-app | PR #72 @ `d5c8127` OPEN; es-honeybook PR #44 @ `a780d71` OPEN |
| Wiki | `/Users/annabui/build/es-mini-one-command-20261106-wiki` on `claude/es-mini-one-command-20261106-wiki` (off `a555cd40`, the post-TF48 coordinator tip) |

## How it works

| Step | Where | What |
| --- | --- | --- |
| Install (today) | `install.sh:46-67` reuses 22 named keys from the live plist; `:69-99` reads inputs; `:164-210` local vs standalone mode (standalone downloads `modules.txt` then each module from `REPO_RAW_BASE` = GitHub **main**); `:179` standalone folder is `~/Documents/es-mini-agent` | Rebuilds the plist from scratch (`:339-422`, heredoc, XML-escaped, mode 600), `launchctl unload/load` (`:429-440`), optional OBS launcher (`:447-509`), health readback (`:511-557`) |
| Self-update (today) | `self-update.js:25` `COMMITS_API` = main; `runSelfUpdate` stages, syntax-checks and boot-tests the new modules before swapping (`:916-1058`); `server.js:1413-1419` refuses while recording or uploading | Always pulls `main`. Never queue it (CLAUDE.md, S6) |
| Module list | `modules.txt` (23 `.js` files) is the single source for installer and updater; `test/install-scripts.test.js:294` follows every `require` | Any new runtime file must be listed or the agent crash-loops |
| Heartbeat | `server.js:2646` sends `&hb=1&v=<AGENT_VERSION>`; Worker `api/record.js:657-661` PATCHes `fleet_buildings.agent_version/agent_commit/last_state` | This is the post-install readback the cloud sees; `es-fleet-heartbeat` alerts after a gap |
| Auth | Worker `api/record.js:414-417`: ONE `RECORD_CONTROL_KEY` secret for all Minis | A new studio's Mini uses the same secret (known limit) |
| Building config | `fleet_buildings` row per `building_id` (`obs_sources`, `cameras`, `looks`, `upload_webhook_url`); S3 keys under `recordings/<building_id>/…` | A new property needs a row before its Mini can poll usefully |
| OBS launcher | `obs-launcher.sh` copied to `~/Library/Application Support/es-mini-agent/`; archives pre-boot crash markers, never kills a running OBS | Unchanged by this build |

**Known limit 1 (document, don't fix):** one shared `RECORD_CONTROL_KEY` across all Minis. Rotating it means re-running the installer on every Mini. Per-building keys are a later Worker project.

**Known limit 2:** a user LaunchAgent runs only while the user is logged in. After a power cut, `autorestart 1` boots the Mini, but recording resumes only after login (FileVault off + automatic login, or a person). This is a per-property policy choice (S6 HEADLESS §3). The SOP must ask it, the installer must only report it.

**Known limit 3:** macOS TCC blocks reading `~/Documents/es-mini-agent` over SSH and from launchd-run bash. The installer backs up the old runtime only when run in Terminal on the Mini; over SSH it backs up the plist (always readable) and records "old runtime folder not readable" instead of failing.

**Known limit 4:** the `update` op still pulls `main`. Until it is redesigned, Mini PRs are merged only after the install is verified, and nobody queues `update`.

## Tool notes checked

| Tool | Notes file (Last checked) | Applies to this build | How the plan handles it |
|---|---|---|---|
| macOS launchd / TCC / Homebrew | `~/code/ab-wiki/LEARNINGS/tools/macos-launchd.md` (2026-11-06, created this session) | TCC blocks `~/Documents` for launchd bash and over SSH; `/bin/bash` 3.2 on the Mini; 22-key plist rebuild drops hand-set keys; OBS 32 Safe Mode markers; `pmset` needs sudo | A2 installs outside `~/Documents`, carries over the full env dict, is bash-3.2-safe and tested under `/bin/bash`; OBS launcher logic untouched; `pmset` is read and advised only |
| Cloudflare | `LEARNINGS/tools/cloudflare.md` (2026-10-19) | `cf es` wrapper for the ES account (plain wrangler hits Anna's account); `cf <acct> secret …` is broken (vault path gone) | Read-only `cf es wrangler deployments list` only; no secret reads |
| Supabase | `LEARNINGS/tools/supabase.md` (2026-10-19) | `sb os` is the management API and can write | Plain SELECT only; the SOP's `fleet_buildings` insert is a template Anna runs |
| GitHub Actions / PR review | `LEARNINGS/tools/github-actions.md` (2026-10-22) | Every Mini PR gets the AI `review` check; a MUST_FIX blocks merge; print the VERDICT line itself | B2 (push + PR) is Anna's step after GO |

Client stack: `~/code/ab-wiki/Clients/ES/stack.md`. New gotchas found during the build go into `macos-launchd.md` before the session ends.

## Out of scope (document, don't build)

- **Redesigning the `update` op** to install a pinned release. The code must still guarantee: `update` refuses while recording/uploading (`server.js:1413`), and the docs say "never queue it". A3 adds no test for it; the audit checks the docs.
- **Per-building `RECORD_CONTROL_KEY`.** The SOP says "same secret as the Worker" and lists rotation as an all-Minis job.
- **Local preview relay (`relay/`), EPCR7 second power strip, headless/FileVault policy decision.** The SOP asks the policy question; the installer prints `fdesetup status` and `pmset -g` as advice.
- **Homebrew installation itself.** The installer detects Homebrew and, if missing, prints the one official command and stops (it needs an admin password). Same for OBS and its plugins: detect, report versions, never download apps.
- **Migration 0124, app #72, hb #44 releases.** The installer doc records that `mic_check` on Mini 2026.11.05-1 is inert until those are live; nothing else in the Mini depends on them (A6 verifies).
- **The Mini's own camera/OBS scene setup** stays in `SETUP-MAC-MINI.md` steps 4–5 (GUI steps a person does).

## Work package A: Claude builds, local only

Commit each item separately on `claude/es-mini-one-command-install-20261106`. Never push. After every code change, run the offline checks. Keep `/bin/bash` 3.2 compatibility: no associative arrays, no `mapfile`, no `${var,,}`.

### A1. Package script in the repo
- Copy `/Users/annabui/build/es-s6-install-readiness-20261102-ab-wiki/Clients/ES/SESSIONS/2026-11-02-s6-install-readiness/build-mini-package.sh` to `scripts/build-mini-package.sh`, parameterised: `build-mini-package.sh <repo> <out> <commit> <version>`. Output: `es-mini-agent-<V>-<c7>.tar`, `SHA256SUMS-files-<V>.txt`, `SHA256SUMS-archive.txt`, and `RELEASE.txt` (version, commit, tar sha, file count, built-at).
- Test (`test/build-package.test.js`): run it for `20230f2` / `2026.11.05-1` against `/Users/annabui/code/es-mini-agent` and assert the tar sha equals `a62d02a7d2d1a1c24f61383f5361a42f1a7a22c87da969af4f09addf8ab3c802`. Skip when the commit is absent.
- Why: the package is the thing the installer verifies; it must be reproducible from the repo, not from a wiki worktree.

### A2. `install.sh` v2: pinned, verified, carry-over, readback, rollback
Keep the file name `install.sh` so the documented one-liner shape survives. Behaviour:

1. **Inputs.** `ES_MINI_VERSION` (required), `ES_MINI_TAR_SHA256` (required), `ES_MINI_RELEASE_URL` (default `https://github.com/annabuies/es-mini-agent/releases/download/v<VERSION>/`), `ES_MINI_CONFIG` (optional file of `KEY=VALUE` lines for a fresh Mini, mode 600, sourced not printed), `--set KEY=VALUE` (repeatable), `--dry-run`, `--rollback [backup-dir]`, `--obs-launcher` (kept), `--yes`. A local tar path is accepted in place of the URL (`ES_MINI_TAR=/path`), which is how Robbie's AirDrop/Downloads path works without GitHub.
2. **Preflight (report, don't fix):** macOS version, arch, Homebrew, node ≥ 22 (search `/usr/local/bin/node`, `/opt/homebrew/bin/node`, `command -v node`), ffmpeg/ffprobe, OBS version from `/Applications/OBS.app/Contents/Info.plist`, plugins `source-record` and `distroav` present, `fdesetup status`, `pmset -g | grep autorestart`, free disk ≥ 20 GiB. Missing node/ffmpeg: install with Homebrew if present (today's behaviour); missing Homebrew/OBS/plugins: print the exact instruction and stop unless `--advise-only`.
3. **Busy guard.** `GET /health` must answer `ok:true` with `recording:false, paused:false`; then an authenticated `POST /record/status` (key read from the plist into a variable, never echoed) must show an empty upload queue and no active upload. Any failure stops with the reason. Fresh Mini (no plist, nothing on the port): skip.
4. **Fetch + verify.** Download (or copy) the tar, check `shasum -a 256` against `ES_MINI_TAR_SHA256`, extract to `~/es-mini-agent-runtimes/<VERSION>-<c7>/`, verify every file against the bundled `SHA256SUMS-files-<VERSION>.txt`, `node --check` every module in `modules.txt`, and `grep "AGENT_VERSION = '<VERSION>'" server.js`.
5. **Backup.** `~/es-backups/mini-<UTC ts>/`: plist copies (always), the old runtime folder and `~/Library/Application Support/obs-studio` (when readable; record "not readable" otherwise), `live.sha256`. Verify with `shasum -c`. Mode 700.
6. **Plist = old plist + path changes + explicit sets.** Read the whole `EnvironmentVariables` dict with PlistBuddy, keep every key, set `WorkingDirectory`, `StandardOutPath`, `StandardErrorPath`, `ProgramArguments:0` (node path), apply `--set`/config values, write via a temp file (mode 600), `plutil -lint`, then diff key names and values against the backup and print only names that changed (which must equal the explicit sets). Carry over `.cam-golden.json`; do not carry `.r2-uploads`, `update-state.json` or logs.
7. **Swap + readback.** `launchctl unload` then `load`; within 60 s: `/health` ok, `diag` `version.agent == VERSION`, `lsof`/`pgrep` cwd equals the new folder, exactly one agent process, `launchctl list` shows both ES jobs, `agent.error.log` has no crash loop, and the log shows a successful relay poll (`relay:` line without `GET 4xx/5xx`). Print a report block: key names, versions, paths, backup path. Never a value.
8. **Rollback.** `--rollback` restores the newest (or given) backup plist, reloads, and reads back the old version. The old runtime folder was never touched.
9. **Idempotent.** Same version already running: print the readback and exit 0 without swapping.
10. **Standalone mode never points at `main`**: remove the `REPO_RAW_BASE` download path; `--local` (inside a checkout) stays for Anna's bench tests only.
- Why: this is the ask. Today's installer rebuilds the plist from 22 keys, installs from `main`, and has no busy guard, backup, hash check or rollback.

### A3. Tests (fail-before where it is a fix)
- Extend `test/install-scripts.test.js` and add `test/install-v2.test.js`. Use a fake `HOME`, PATH shims for `launchctl`, `lsof`, `pgrep`, `curl`, `shasum`-free paths (use the real `shasum`), and a tiny fake agent (`node -e` HTTP server) answering `/health`, `/record/status`, `/record/diag` with configurable recording/queue/version. The existing tests already shim `open`/`pgrep` this way.
- Fail-before: (a) a plist with `RTSP_CAPTURE=0` and `WATCH_HW=1` loses both keys under the `20230f2` `install.sh` and keeps them under v2; (b) recording:true → exit non-zero, nothing written; (c) wrong `ES_MINI_TAR_SHA256` → exit non-zero, no runtime folder; (d) rollback restores the previous plist byte for byte; (e) idempotent re-run makes no changes; (f) dry run writes nothing.
- Run all installer tests with `/bin/bash` explicitly (`BASH=/bin/bash`), and keep the Linux skip for PlistBuddy-only tests.
- Why: the audit requires reproduction, and Anna's rule is fail-before for fixes.

### A4. Install and update docs
- `docs/INSTALL.md`: for Robbie, three steps in Terminal on the Mini (copy the command Anna sends; watch for `SUCCESS`; send Anna the report block) plus `--rollback`. For Anna: how to produce the command (A1 output + B3 release) and what the report block must show. State the TCC rule (run in Terminal, not over SSH, for the full backup).
- Update `README.md` "Install as a launchd LaunchAgent", `SETUP-MAC-MINI.md` step 6 (point to `docs/INSTALL.md`), and `CLAUDE.md` line 3 ("people run install.sh straight from main with curl" → "people run the pinned installer from a release; `main` is only what `update` would pull, and `update` is never queued").
- Why: the docs today tell people to do the thing the S6 rule forbids.

### A5. New-property onboarding SOP (Anna's mid-session ask)
- Write `Clients/ES/SOP-NEW-PROPERTY-ONBOARDING-2026-11-06.md` in the wiki worktree and a short `docs/NEW-PROPERTY.md` in the repo that links to it. Structure, each step with owner, input, command or form, and the check that proves it:
  1. **Decide** (Anna + Robbie + partner): property name → `building_id` (lowercase, dash, e.g. `fsu-1`), who owns the Mini, login policy (Known limit 2), remote-support path, install week.
  2. **Network** (partner IT): the FSU IT network document and worksheet (`PRIVATE-CONFIG-WORKSHEET-TEMPLATE.md`), preflight F1–F13. Both already exist under the S6 session folder; the SOP links them and says what to copy where.
  3. **Cloud row** (Anna): `fleet_buildings` insert template with `building_id, obs_sources, cameras, looks, default_look, upload_webhook_url, note, studio_id`; the S3 prefix is derived from `building_id`; the Worker secret is shared (Known limit 1); read back with one SELECT. Verify in A5 how `studio_id` links a building to a studio tenant (Track B multi-tenant) and record it; if it cannot be verified from code, write it as an open question, not a guess.
  4. **Hardware bench** (Robbie): Mini, cameras, EVO, Loopback, power strip, dummy plug, kiosk iPad. Links `SETUP-MAC-MINI.md` steps 2–5 for OBS, Source Record, obs-websocket, scenes, and the EPCR7 bench form for the strip.
  5. **Mini prep** (Robbie, Terminal): macOS user, FileVault per policy, Homebrew, OBS, plugins, `pmset` advice, Tailscale (if used), then the **one command** from `docs/INSTALL.md` with `ES_MINI_CONFIG` filled from the worksheet.
  6. **Acceptance**: the S6 runbook phases R and A (readback, short take, long take, delayed Stop, originals, exact-take, auto-stop, lights refusal) with the forms.
  7. **Hand to operations**: heartbeat alert channel, kiosk setup, who holds the secrets (1Password item names, not values), backup folder path.
- Update `SETUP-MAC-MINI.md`'s intro to say it is the bench/camera SOP and the property SOP wraps it.
- Why: Anna asked for an SOP that "sets this in motion" for the new partner's studios.

### A6. Compatibility note: Mini 2026.11.05-1 on the live Worker
- Read Worker `api/record.js` at `477be4e` (live) against `server.js` ops at `20230f2`. Confirm in writing (in `docs/INSTALL.md` "Compatibility"): every op the live Worker can enqueue is handled; `mic_check` is never enqueued until app #72 + migration 0124 are live; heartbeat `last_state` stays under 2048 bytes (ledger says 2024 worst case). Cite lines.
- Why: Robbie's update may land before app #72 is live; the install must not depend on it.

### A7. Robbie message drafts
- `docs/ROBBIE-MESSAGES-2026-11-06.md`, two drafts in Anna's voice (short lines, no em dashes, no client names):
  - **Draft 1, send now:** the Mini is healthy (agent 2026.10.20-1, up 10+ days, heartbeat fresh, 110 GB free, OBS 32.1.0, auto-restart on); nothing he needs to fix today; the update is being packaged as a single command with its own backup and rollback; Anna will send it with the exact text to paste; it must run when nothing is booked for about 30 minutes, in Terminal on the Mini.
  - **Draft 2, send with the release:** the exact command (with `ES_MINI_VERSION`, `ES_MINI_TAR_SHA256` placeholders filled by Anna from B3), what `SUCCESS` looks like, what to send back (the report block), and the rollback line.
- Why: Anna asked to let Robbie know; it is drafted, not sent.

### A8. Round-1 audit prompt (the session's deliverable)
Write `docs/mini-one-command-install-audit-round1-2026-11-06.md` in the format of `~/.claude/skills/build-jumpstart/templates/audit-prompt-template.md` (the 2026-11-05 ES prompt is the prior-art tone). Scope: `20230f2..HEAD`. Checks: full env carry-over including unknown keys and XML-special characters in values; busy guard against recording/paused/queued/active; hash and per-file verification; `node --check`; backup verified before any swap; plist diff prints names only; rollback byte-exactness; idempotent re-run; dry run; bash 3.2 (run under `/bin/bash`); no secret ever printed or logged; no path under `~/Documents` for the new runtime; `--local` mode never reaches GitHub `main`; package reproducibility; docs and SOP match the script's flags; the Robbie drafts contain no secrets and no client names. The auditor works read-only and gives one verdict: GO or NO-GO for "Anna publishes the release and sends Robbie draft 2". **Show the full prompt inline to Anna.**

## Work package B: needs Anna (ask early, don't let it block A)

1. **B1 decide Robbie's path for Nov 6 ET.** Option A (recommended if round-1 GO lands first): the new installer. Option B: the manual S6 runbook 6c from `RUNBOOK-ANNA-GATES.md`, which is ready now. Reply "A" or "B".
2. **B2 after GO: push the branch and open the PR** (stacked on #26):
   ```
   cd /Users/annabui/build/es-mini-one-command-20261106-mini && git push -u origin claude/es-mini-one-command-install-20261106 && gh pr create --base claude/es-post-tf48-robbie-20261105 --head claude/es-mini-one-command-install-20261106 --title "One-command Mini install/update: pinned release, full env carry-over, backup, readback, rollback + new-property SOP" --body "See docs/mini-one-command-install-build-plan-2026-11-06.md. Stacked on #26."
   ```
3. **B3 after GO: publish the release** (tag on `20230f2`, assets = tar, sums, the v2 installer from the build branch tip):
   ```
   cd /Users/annabui/build/es-mini-one-command-20261106-mini && gh release create v2026.11.05-1 --target 20230f2 --title "Mini agent 2026.11.05-1" --notes "Package 20230f2. Installer: install.sh from <build-branch-tip>." /private/tmp/es-posttf48-mini-pkg/out/es-mini-agent-2026.11.05-1-20230f2.tar /private/tmp/es-posttf48-mini-pkg/out/SHA256SUMS-files-2026.11.05-1.txt install.sh
   ```
   The session fills `<build-branch-tip>` in the return message.
4. **B4 send Robbie draft 1 now** (from A7) and **draft 2 after B3**.
5. **B5 decide:** shared `RECORD_CONTROL_KEY` for all Minis stays for the new partner's studios (yes/no). "No" is a separate Worker project.
6. **B6 ask the partner** (via Robbie): login policy after a power cut (FileVault off + auto-login, or a person logs in), and who on their side holds the Mini password. Goes into the SOP step 1.
7. **B7 confirm** Robbie runs the command in Terminal on the Mini (not over SSH), so the old-runtime backup works.

## Access

- **Works (read-only):**
  - Mini: `ssh -o BatchMode=yes -i ~/.ssh/id_ed25519_es_mini megadesk-command@100.75.212.27 'curl -s http://127.0.0.1:8787/health'`. The `diag` version: read the key into a variable on the Mini and never echo it (see the S6 runbook V2 command).
  - DB: `sb os "select building_id, agent_version, agent_commit, last_seen_at from studios.fleet_buildings order by 1"`.
  - Worker: `cd /Users/annabui/code/es-os-app && cf es wrangler deployments list --config worker/wrangler.jsonc | tail -6`.
  - GitHub: `gh pr view 26 -R annabuies/es-mini-agent`.
- **Blocked or forbidden:** writing anything on the Mini (install, plist, launchctl, files), queuing `update` or any op through the Worker, `sb os` writes, `cf … secret`, push/PR/merge/release, Slack sends, reading `~/Documents/es-mini-agent` over SSH (TCC refuses; do not work around it).

## Rules

- Verify every claim against code and live data before relying on it. The 2026-11-05 ledger is the latest truth for the candidate; the S6 runbook is the latest truth for install phases.
- Any bug fix needs a fail-before test.
- Offline checks:
  ```
  cd /Users/annabui/build/es-mini-one-command-20261106-mini
  node --test --test-concurrency=1 --test-timeout=120000 test/*.test.js   # expect >= 258 tests, 0 fail (rtsp/upload tests flake under load; rerun the file alone before calling a failure new)
  /bin/bash -n install.sh scripts/build-mini-package.sh obs-launcher.sh uninstall.sh
  git status --short                                                       # clean except docs you mean to add
  ```
- Never run the suite with `timeout(1)`; it does not exist on macOS. Kill only PIDs you started; no pattern `pkill`.
- No secrets in code, tests, docs, logs or the plan. The installer prints key names only.
- Keep Anna's style: short lines, one command per step, `read -rs` in her zsh swallows the next pasted line so never use it.
- Commit trailer: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Wiki edits go in `/Users/annabui/build/es-mini-one-command-20261106-wiki` (branch `claude/es-mini-one-command-20261106-wiki`), commit locally.

## Open questions for ES (go in the message pack, don't block the build)

1. The new partner: name, how many rooms, which city, target install week, and who is on site for the install.
2. Will the partner buy the Mac minis, or will Robbie pre-provision them on his bench and ship them? (Pre-provisioning changes SOP step 5 ordering.)
3. Login policy after a power cut at the partner's site (B6).
4. Does the partner's IT allow outbound HTTPS to GitHub (release download) and to `api.evrybdystudios.com`, Cloudflare and S3? If not, the AirDrop/local-tar path in `docs/INSTALL.md` applies.

## Session return format

1. **Goal status:** each A item marked done or not done, with evidence (test counts, hashes, file paths).
2. **Branch tip and commits** since `20230f2` (Mini) and since `a555cd40` (wiki).
3. **What Anna needs to do:** B items still open, as one command per step, with `<build-branch-tip>` filled in.
4. **The audit prompt, in full.**
5. **Anything that changes the plan.**

---

## Jump-start prompt (paste into the next session)

```
ES Mac mini one-command installer + new-property SOP. This session is for building.

Read /Users/annabui/build/es-mini-one-command-20261106-mini/docs/mini-one-command-install-build-plan-2026-11-06.md top to bottom. Then read ~/code/ab-wiki/LEARNINGS/tools/macos-launchd.md, the 2026-11-05 runbook /Users/annabui/build/es-post-tf48-20261105-wiki/Clients/ES/JUMPSTARTS/2026-11-05/RUNBOOK-ANNA-GATES.md §6, and the S6 runbook phases B/I/R in /Users/annabui/build/es-s6-install-readiness-20261102-ab-wiki/Clients/ES/SESSIONS/2026-11-02-s6-install-readiness/QUIET-ROOM-RUNBOOK.md.

Goal: finish work package A (A1–A8) in this session. When you're done, the branch claude/es-mini-one-command-install-20261106 holds a pinned, hash-verified install.sh v2 that carries over the whole plist environment, refuses while busy, backs up, reads back and rolls back, proven in a sandbox under /bin/bash 3.2 with fail-before tests; the package script and docs are in the repo; the new-property SOP is in the wiki worktree; Robbie's two message drafts exist; and the round-1 audit prompt is in the repo and shown to me in full.

Ground rules:
- Local commits only. No push, PR, release, deploy, Supabase write, Slack message, and nothing on the Mini until I return a round-1 GO and say yes to each runbook step.
- Read-only access allowed: the SSH, sb, cf and gh commands listed under Access in the plan. Never read ~/Documents on the Mini over SSH and never queue the update op.
- Send me the work package B asks in one short message early, one command per step, then keep building while I do them.
- Verify everything in the plan against code and live data before relying on it.

Finish with the return format at the end of the plan.
```
