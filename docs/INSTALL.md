# Install or update a Mac mini (installer v2)

One command installs a fresh Mac mini or updates an existing one. It installs a **pinned, hash-verified release** into its own folder, keeps every setting, backs up first, checks the result, and can roll back.

- New property, from "signed" to "first take": [NEW-PROPERTY.md](NEW-PROPERTY.md).
- Cameras, OBS scenes and plugins (GUI steps a person does): [../SETUP-MAC-MINI.md](../SETUP-MAC-MINI.md) steps 2–5.

**Never** use the old `bash <(curl …/main/install.sh)` one-liner, `update`, or self-update to switch runtimes. `main` is only what the `update` op would pull, and `update` is never queued (see Known limits).

---

## For Robbie: update the Mini in 3 steps

Do this in **Terminal on the Mac mini itself** (not over SSH, not from another computer). Pick a time with **nothing booked for about 30 minutes**.

1. **Paste the one line Anna sends you** into Terminal and press Return. It looks like this (Anna fills in the values):

   ```bash
   cd ~/Downloads && curl -fsSLO https://github.com/annabuies/es-mini-agent/releases/download/v<VERSION>/install.sh && echo "<INSTALLER_SHA256>  install.sh" | shasum -a 256 -c && ES_MINI_VERSION=<VERSION> ES_MINI_COMMIT=<COMMIT> ES_MINI_TAR_SHA256=<TAR_SHA256> /bin/bash install.sh
   ```

   If macOS asks "Terminal would like to access files in your Documents folder", click **Allow**. That lets the installer back up the old version.

2. **Read the plan it prints, then type `yes`** and press Return. Then wait about a minute. The last lines must say:

   ```
   SUCCESS: agent <VERSION> is running from /Users/<you>/es-mini-agent-runtimes/<VERSION>-<commit>
   ===== ES MINI INSTALL REPORT =====
   ```

   If it says **STOPPED**, nothing was changed. Read the line above it (for example "the agent is RECORDING": wait for the room to be free) and run the same line again. If it says **FAILURE, ROLLED BACK**, the Mini is back on the old version: send Anna the whole window.

3. **Send Anna everything from `===== ES MINI INSTALL REPORT =====` to the closing `=====`.** It contains names, versions and folders only, never a password or key.

**To undo** (any time later, when nothing is recording), paste the `rollback:` line from the report. It looks like:

```bash
/bin/bash ~/es-backups/mini-<time>/install.sh --rollback ~/es-backups/mini-<time>
```

It must end with `ROLLED BACK` and the old version number.

---

## For Anna: produce the command

1. **Package** (repo, no network). For the 2026-11-05 candidate:

   ```bash
   cd /Users/annabui/build/es-mini-one-command-20261106-mini && rm -rf /private/tmp/es-mini-pkg && /bin/bash scripts/build-mini-package.sh /Users/annabui/code/es-mini-agent /private/tmp/es-mini-pkg 20230f2 2026.11.05-1 && cat /private/tmp/es-mini-pkg/RELEASE.txt
   ```

   Expect `files=29 modules=23` and `tar_sha256=a62d02a7d2d1a1c24f61383f5361a42f1a7a22c87da969af4f09addf8ab3c802`. The script refuses a version that is not the commit's `package.json` / `AGENT_VERSION`.

2. **Release** (after an audit GO): a GitHub release `v<VERSION>` on the package commit with three assets: the tar, `SHA256SUMS-files-<VERSION>.txt`, and `install.sh` from the reviewed installer commit. The repo is public, so the assets need no login.

3. **Fill the command** from step 1 above:
   - `<VERSION>` = `version=` from `RELEASE.txt`.
   - `<COMMIT>` = the full `commit=` value.
   - `<TAR_SHA256>` = the `tar_sha256=` value.
   - `<INSTALLER_SHA256>` = `shasum -a 256 install.sh` of the exact file uploaded as the release asset.

   The installer itself is pinned too: the `shasum -c` step refuses a changed `install.sh` before it runs.

4. **Check the report** Robbie sends back:

   | Line | Must show |
   |---|---|
   | `result:` | `SUCCESS` |
   | `agent:` | `<old> -> <VERSION>` |
   | `commit:` | the full commit you filled in |
   | `folder:` | `~/es-mini-agent-runtimes/<VERSION>-<c7>` (never under `~/Documents`) |
   | `env keys (N):` | the same names (and count) as before the install; for bench-1 on 2026-11-06 that is the 22 names in the S6 runbook V5 list |
   | `env keys changed:` | `none` (or exactly the keys you asked to change) |
   | `plist fields changed:` | `StandardErrorPath StandardOutPath WorkingDirectory` (plus `ProgramArguments` only if Node moved) |
   | `old runtime backup:` | `copied and verified (…)`. "not readable" means it ran over SSH or Robbie clicked Don't Allow: the plist is still backed up, rollback still works |
   | `warnings:` | read each one |

   Then confirm in the cloud: `sb os "select building_id, agent_version, agent_commit, last_seen_at from studios.fleet_buildings order by 1"` shows the new `agent_version` and the full `agent_commit` within 2 minutes. The installer writes `update-state.json` in the new folder, so the heartbeat reports the real commit instead of the stale `05e659ca…`.

### No GitHub at the property

Copy `install.sh`, the tar and `SHA256SUMS-files-<VERSION>.txt` to the Mini's `~/Downloads` (AirDrop or USB), then in Terminal:

```bash
cd ~/Downloads && echo "<INSTALLER_SHA256>  install.sh" | shasum -a 256 -c && ES_MINI_VERSION=<VERSION> ES_MINI_COMMIT=<COMMIT> ES_MINI_TAR_SHA256=<TAR_SHA256> ES_MINI_TAR=$HOME/Downloads/es-mini-agent-<VERSION>-<c7>.tar /bin/bash install.sh
```

The same hash checks apply. The sums file is found next to the tar.

### Fresh Mini

Put the property's values in a file (from the worksheet; see [NEW-PROPERTY.md](NEW-PROPERTY.md)), one `KEY=VALUE` per line, then `chmod 600` it. The installer reads it literally (it is never run as shell code, so `$` and backticks in a password are safe) and never prints a value.

```bash
chmod 600 ~/es-mini.env && ES_MINI_CONFIG=$HOME/es-mini.env ES_MINI_VERSION=<VERSION> ES_MINI_COMMIT=<COMMIT> ES_MINI_TAR_SHA256=<TAR_SHA256> /bin/bash ~/Downloads/install.sh --obs-launcher
```

Required: `BUILDING_ID`, `RECORD_CONTROL_KEY`. Defaults added when absent: `PORT=8787`, `RECORD_POLL_URL=https://api.evrybdystudios.com`, `OBS_WS_URL=ws://127.0.0.1:4455`, `FFMPEG_BIN` (where ffmpeg was found). Delete the file after a SUCCESS; the values now live only in the plist (mode 600).

---

## What the installer does

| Step | What | Stops when |
|---|---|---|
| Preflight | macOS, arch, Homebrew, Node ≥ 22 (plist node first, then `/opt/homebrew/bin`, `/usr/local/bin`, PATH), ffmpeg/ffprobe, OBS version, `source-record` + `distroav` plugins, FileVault, `pmset` autorestart, free disk ≥ 20 GiB | Node missing (and Homebrew can't install it); Homebrew, OBS, a plugin or disk space missing (unless `--advise-only`). Missing ffmpeg is installed with Homebrew, otherwise a warning. FileVault and auto-restart are only reported. |
| Busy guard | `GET /health` → `ok:true`, `recording:false`, `paused:false`; authenticated `POST /record/status` → `uploads.queued == 0`, `uploads.active == null`, `uploads.proxies_pending == 0`. Runs at the start **and again just before the swap** | any of those; a plist with no agent answering (`--agent-down-ok` overrides, Anna only); something on the port with no plist |
| Verify | tar SHA-256 = `ES_MINI_TAR_SHA256`; every entry under `es-mini-agent-<V>-<c7>/`, no `..`; file count = sums lines; every file `shasum -c` OK; `node --check` every module in `modules.txt`; `server.js` declares `AGENT_VERSION = '<V>'` | any mismatch. Nothing has been written yet. |
| Plan | plist → JSON (`plutil`), keep **every** key, set `WorkingDirectory`, `StandardOutPath`, `StandardErrorPath`, `ProgramArguments[0]`, apply `ES_MINI_CONFIG` then `--set`; back to XML, `plutil -lint`; diff old vs new | a key would be dropped, a key not asked for would change, any other plist field would change, `BUILDING_ID`/`RECORD_CONTROL_KEY` empty |
| Confirm | prints the plan; asks for `yes` (`--yes` skips) | anything but `yes` |
| Backup | `~/es-backups/mini-<UTC>/` (mode 700): both LaunchAgent plists + `plists.sha256`, the launcher script, the old runtime folder (`live.sha256`, logs copied not hashed), `~/Library/Application Support/obs-studio` (`obs-studio.sha256`, logs/crashes/sentinels not hashed), a copy of `install.sh`, `MANIFEST.txt` | a plist or runtime copy fails `shasum -c` |
| Place | `~/es-mini-agent-runtimes/<V>-<c7>/` (an older folder of that name is set aside, never deleted); `.cam-golden.json` carried over; `update-state.json` written with the commit. Not carried: `.r2-uploads`, the old `update-state.json`, logs | |
| Swap | `launchctl unload`, new plist (mode 600, temp file + `mv`), `launchctl load`; `--obs-launcher` refreshes the launcher from the new folder | `load` fails → automatic rollback |
| Readback | within 60 s `/health` ok; `diag` `version.agent == V` and `version.commit == ES_MINI_COMMIT`; exactly one `node server.js` with cwd = new folder and none left in the old; `launchctl list` shows `com.es.mini-agent` (and `com.es.obs-launcher` if its plist exists); same pid after 10 s; `agent.error.log` has no `Cannot find module`/`SyntaxError`/`ReferenceError`; `agent.log` has the `relay: polling` start line and no `poll GET 401/403` | any failure → automatic rollback to the backup just made, then exit 1. A relay 5xx/network error is a warning only. |
| Report | key **names**, versions, folders, backup path, warnings, the rollback line; saved as `REPORT.txt` in the backup | |

Same version already running from the same folder, no `--set`, no `--obs-launcher`: it reads back and prints `ALREADY INSTALLED`, with no backup and no restart. `--dry-run` runs preflight, busy guard, verify and plan in a temp folder and writes nothing.

`--rollback [dir]`: busy guard (an agent that is down is allowed), restore that backup's plist byte for byte (and the OBS launcher plist/script if they differ), reload, read back the version recorded in `MANIFEST.txt`. The old folder was never touched, so this is enough.

`--local` (Anna's bench only): packages this checkout's committed HEAD with `scripts/build-mini-package.sh` and installs that, pinned to its own hash. It never touches the network and never reads `main`.

**TCC (macOS privacy).** Bash started over SSH, or by launchd, cannot read `~/Documents`. Over SSH the installer still backs up the plist (always readable) and records `old runtime folder not readable`, and rollback still works. For the full backup, run it in Terminal on the Mini and click Allow.

---

## Compatibility: Mini 2026.11.05-1 on the live backend (checked 2026-11-06)

Live, read-only: Worker version `266905e7-ccda-4330-9337-63106428d263` (2026-11-05 12:11Z, `cf es wrangler deployments list`). The deployment has no commit message; the post-TF48 ledger maps it to es-os-app `477be4e`, which is what was read below. Honeybook Trigger `20261105.1` = `df7d1aa`.

| Check | Result | Evidence |
|---|---|---|
| Every op the live Worker can enqueue is handled by the Mini | **Yes.** The Worker inserts into `record_commands` in two places only: `api/record.js:1967` (after the allowlist at `:1551`: `start stop cancel status pause resume preview_start preview_stop preview_cam1-3 diag look`, with `start_check` answered at `:1596-1625` and never inserted) and `lib/auto-stop.js:124` (`op: 'stop'`, `:117`). All of these are in the Mini's `VALID_OPS` (`server.js:2305` at `20230f2`). | `git show 477be4e:api/record.js`, `git grep record_commands 477be4e` |
| Other live enqueuers | Honeybook `src/lib/room-power.ts:105` enqueues `op: "power"` for agents ≥ `MIN_POWER_AGENT_VERSION = "2026.09.28-2"` (`:24`); `2026.11.05-1` passes, and `power` is in `VALID_OPS`. | `git show df7d1aa:src/lib/room-power.ts` |
| `mic_check` | **Never enqueued** by the live Worker: it is not in the `:1551` allowlist and not in any other insert. On 2026.11.05-1 it stays inert until app #72 and migration 0124 are live. Nothing else in the Mini depends on them. | same |
| Heartbeat `last_state` stays under 2048 bytes | **Yes, by construction.** The Worker drops a `state` over 2048 bytes (`api/record.js:974`, stores `{}`). The Mini's `heartbeatStateJson` (`heartbeat-state.js:122-135`, cap `:8`) drops routes, then per-channel detail, then per-mic detail to fit. The 11-05 ledger measured 2024 bytes worst case. | code |
| Heartbeat version/commit | `server.js:2646-2647` sends `v=<AGENT_VERSION>` and `c=<update-state.json commit>`; the Worker PATCHes `agent_version`/`agent_commit` (`api/record.js:979-987`). The plan cited `:657-661`; at `477be4e` it is `:965-990`. | code |
| `update` op | Still pulls GitHub `main` (`self-update.js`). It refuses while recording or uploading (`server.js:1413-1418`). **Never queue it.** It is not in the Worker allowlist, so only a manual SQL insert could queue it. | code |

## Known limits

1. **One shared `RECORD_CONTROL_KEY`** for all Minis (`api/record.js` checks one secret). Rotating it means re-running the installer on every Mini with the new key in `ES_MINI_CONFIG` (mode 600; never on the command line). Per-building keys are a separate Worker project.
2. **Login policy.** A user LaunchAgent runs only while that user is logged in. After a power cut, `autorestart 1` boots the Mini, but recording resumes only after login (FileVault off + automatic login, or a person). The installer reports FileVault and auto-restart; it never changes them.
3. **TCC** as above.
4. **`update` still pulls `main`.** Until it is redesigned, merge Mini PRs only after the package install is verified, and never queue `update`.
5. The installer detects Homebrew, OBS and the plugins but never installs apps. Homebrew needs the Mac password; OBS and plugins follow `SETUP-MAC-MINI.md`.
