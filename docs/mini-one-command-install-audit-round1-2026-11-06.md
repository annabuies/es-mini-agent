# ES Mac mini one-command installer: audit round 1

You are auditing the Mac mini installer v2 (`install.sh`), the release package script, their tests, and the install docs, new-property SOP and Robbie message drafts that go with them. This is the first audit round; there is no earlier verdict. **Give one verdict: GO or NO-GO for "Anna publishes the release `v2026.11.05-1` (tar + per-file sums + this `install.sh`) and sends Robbie draft 2"**, with the evidence for it. The gates that are not code are listed at the end. Do not re-decide them.

## Where

- Repo: `/Users/annabui/build/es-mini-one-command-20261106-mini`, branch `claude/es-mini-one-command-install-20261106`, local only (never pushed). Code last changed in `0867c7f`; the tip adds docs only.
- Changes to audit: `20230f2..HEAD`. `20230f2` is agent `2026.11.05-1` (PR #26), the package the installer will install.
- The release asset to be uploaded is this `install.sh`: SHA-256 `8caa2507aae966a40bd48bb38da104ca67421248daf2ffe85c8c815b1dd2242f`. Robbie's command pins it.
- Read first:
  - `docs/mini-one-command-install-build-plan-2026-11-06.md`: goal, decisions, A2 behaviour list, known limits;
  - `docs/INSTALL.md`;
  - `docs/ROBBIE-MESSAGES-2026-11-06.md`.
- Wiki side, branch `claude/es-mini-one-command-20261106-wiki`: `/Users/annabui/build/es-mini-one-command-20261106-wiki/Clients/ES/SOP-NEW-PROPERTY-ONBOARDING-2026-11-06.md` and `LEARNINGS/tools/macos-launchd.md`.
- Prior art the installer replaces: the S6 manual runbook phases B/I/R/X at `/Users/annabui/build/es-s6-install-readiness-20261102-ab-wiki/Clients/ES/SESSIONS/2026-11-02-s6-install-readiness/QUIET-ROOM-RUNBOOK.md`.
- Files changed:
  - `install.sh` (rewritten), with functions:
    - `preflight`, `find_node`, `find_tool`;
    - `guard_busy`, `agent_health`, `agent_post`;
    - `readback`, `do_rollback`, `newest_backup`, `install_obs_launcher`, `confirm`;
    - the node helpers `JS_MERGE`, `JS_DIFF`, `JS_GET`, `JS_ENVGET`;
    - the main flow (inputs → config → live read → idempotent → guard → fetch/verify → plan → dry-run exit → confirm → backup → place → guard → swap → readback → report).
  - `scripts/build-mini-package.sh` (new).
  - Tests:
    - `test/build-package.test.js` (new);
    - `test/install-v2.test.js` (new);
    - `test/install-scripts.test.js` (v1-structure tests moved to v2).
  - Text and docs: `uninstall.sh` (closing text only), `README.md`, `SETUP-MAC-MINI.md`, `CLAUDE.md` line 3, `docs/INSTALL.md`, `docs/NEW-PROPERTY.md`, `docs/ROBBIE-MESSAGES-2026-11-06.md`.

## What changed

1. **Pinned, hash-verified install.** Needs `ES_MINI_VERSION`, `ES_MINI_COMMIT`, `ES_MINI_TAR_SHA256`. Downloads `es-mini-agent-<V>-<c7>.tar` and `SHA256SUMS-files-<V>.txt` from the GitHub release, or takes `ES_MINI_TAR` / `ES_MINI_SUMS`. It then checks, before writing anything:
   - the tar SHA-256 and the entry paths (one top folder, no `..`);
   - file count against the sums file, and every file with `shasum -c`;
   - `node --check` on every module in `modules.txt`;
   - that `server.js` declares `AGENT_VERSION`.

   Branch/raw URLs are refused. The old `REPO_RAW_BASE` download from `main` is gone. Why: v1 installed whatever was on `main`, with no check.
2. **Whole-plist carry-over.**
   - The live plist goes through `plutil -convert json`, and every `EnvironmentVariables` key is kept.
   - Only `WorkingDirectory`, `StandardOutPath`, `StandardErrorPath` and `ProgramArguments[0]` change, plus explicit `ES_MINI_CONFIG` / `--set` values.
   - It goes back through `plutil -convert xml1`, then `plutil -lint`.
   - A diff of names aborts if a key would be dropped, if a key not asked for would change, or if any other top-level field would change.

   Why: v1 rebuilt the plist from 22 fixed keys and dropped anything else (e.g. `RTSP_CAPTURE`, `WATCH_HW`).
3. **Busy guard.** `/health` (`ok`, not recording, not paused) plus authenticated `POST /record/status`: upload queue 0, no active upload, no pending watch copies. The key is read into a variable and sent as a header on curl's stdin (`-H @-`), never in argv. It runs at the start and again just before the swap.
4. **Backup before swap.** `~/es-backups/mini-<UTC>/`, mode 700, holding:
   - the plists + `plists.sha256`;
   - the old runtime folder (`live.sha256`; logs copied, not hashed);
   - OBS settings (`obs-studio.sha256`);
   - the launcher script, a copy of `install.sh`, `MANIFEST.txt`.

   Everything is verified with `shasum -c`. An unreadable old folder (TCC over SSH) is recorded, not fatal.
5. **Versioned runtime outside `~/Documents`.** It installs to `~/es-mini-agent-runtimes/<V>-<c7>/`; the old folder is never touched. `.cam-golden.json` is carried; `.r2-uploads`, the old `update-state.json` and logs are not. A new `update-state.json` records the commit, so `diag` and the heartbeat `agent_commit` are correct.
6. **Readback + automatic rollback.** After the swap it checks:
   - `/health` within 60 s;
   - `diag` version and commit;
   - exactly one `node server.js` with the new cwd, and none in the old;
   - `launchctl list`, and the same pid after 10 s;
   - no startup errors in `agent.error.log`;
   - a `relay: polling` line and no `poll GET 401/403`.

   Any failure restores the backup plist and reads back the old version. A relay 5xx/network error is only a warning.
7. **`--rollback [dir]`, idempotent re-run, `--dry-run`, `--local`.** A same version from the same folder with no sets reads back and exits 0. `--dry-run` writes nothing. `--local` packages HEAD with the package script and never uses the network.
8. **Self-review fix (`0867c7f`).**
   - After a key rotation or a port change, the readback now uses the new plist's key/port (it was using the running agent's, so diag got 401 and the install rolled back).
   - A same-version `--set` on a hand-installed runtime (no `update-state.json`) failed the commit check; `update-state.json` is now written whenever the recorded commit differs.
9. **Package script.** `scripts/build-mini-package.sh <repo> <out> <commit> <version>` reproduces the 2026-11-05 package byte for byte (`a62d02a7…c802`, 29 files, 23 modules) and writes `RELEASE.txt`.
10. **Docs and drafts.**
    - `INSTALL.md`: Robbie's 3 steps, Anna's command recipe and report checks, the A6 compatibility table with line cites, known limits.
    - `NEW-PROPERTY.md` and the wiki SOP (7 steps).
    - Two Robbie drafts.

## What to check

1. **Full env carry-over.** Does any path drop, reorder into a different value, or re-encode a key?
   - Try unknown keys, empty strings, values with `& < > " ' $ \` backticks`, unicode, leading/trailing spaces, a value that is all digits, and a plist with an XML comment inside the dict.
   - Does the `JS_DIFF` guard really stop a dropped key before anything is written?
   - What happens with a non-string env value (`<integer>`), or a `<date>`/`<data>` anywhere in the plist?
2. **Busy guard.** Try recording, paused, `uploads.queued > 0`, `uploads.active` set, `proxies_pending > 0`, `/health` without `state`, `/record/status` returning 401 or non-JSON, and the agent going busy between the first guard and the swap (the second guard).
   - Is any path able to unload the agent while a take or an upload is live?
   - Is "agent down + `--agent-down-ok`" safe for an upload queue in the old folder?
3. **Hash and per-file verification.** Can a tampered or substituted tar, a sums file listing fewer files, a tar with an extra or absolute entry, a symlink entry, or a sums mismatch reach `mv "$STAGE" "$NEW"`?
   - The sums file is not pinned; confirm a forged one can only cause a false STOP, never a bad install.
4. **`node --check` and version.** Every module listed in `modules.txt` must be checked, and `AGENT_VERSION` must equal `ES_MINI_VERSION`. What if `modules.txt` has CRLF line endings or comments?
5. **Backup before swap.** Is every write to `$PL`, `$OBS_PL` or `$APP_SUPPORT` preceded by a verified backup? Does a backup failure stop before the swap?
   - The live agent appends to `agent.log` and may write `.r2-uploads` during the copy: could a correct backup fail verification (a false STOP), or a wrong one pass?
6. **Names only.** No secret value is ever printed, logged or written outside the plist and the mode-700 backup: stdout/stderr, `REPORT.txt`, `MANIFEST.txt`, error paths, `set -x`-like leaks, argv (`ps`), temp files (`$WORK` mode 700, removed by `trap`).
   - Check the config-file error messages and the `--set` path. `--set` values are in argv and shell history, and are documented as non-secret only; is that acceptable?
7. **Rollback.**
   - Is `--rollback` byte-exact for the agent plist?
   - Does it restore the OBS launcher plist and script only when they differ?
   - Does it refuse while recording, and does it work when the old folder is unreadable (TCC) or the agent is down?
   - Does the automatic rollback after a failed readback leave the Mini on the old version in every failure branch, including `launchctl load` failing?
   - Is a fresh install (no backup) handled honestly?
8. **Idempotent re-run, `--set` on the same version, `--dry-run`.**
   - No restart, no backup, no file change on an identical re-run.
   - `--dry-run` writes nothing under `$HOME` and calls no `launchctl load/unload` or `brew`.
9. **bash 3.2.** Run under `/bin/bash` (3.2.57 on the Mini). Look for `"${arr[@]}"` on empty arrays under `set -u`, `$'..'` inside `${…%…}`, `read -d`, `[[ -v ]]`, `local -n`, and `pipefail` + `grep -q` SIGPIPE false negatives (one was found and fixed in the package script).
10. **Never `~/Documents`, never `main`.** No new runtime path under `~/Documents`; `--local` never reaches the network; the default release URL is a release download, not a branch. The `update` op still pulls `main`: confirm the docs say never queue it, and that `server.js:1413` still refuses `update` while recording or uploading.
11. **Package reproducibility.** Rebuild `20230f2` / `2026.11.05-1` and compare with `/private/tmp/es-posttf48-mini-pkg/out/` (tar `a62d02a7…c802`, sums `3151edba…`).
12. **Docs and SOP match the script.** Every flag, env var, path, output string (`SUCCESS`, `STOPPED`, `FAILURE, ROLLED BACK`, `ALREADY INSTALLED`, `ROLLED BACK`, the report lines) and default in `INSTALL.md`, `NEW-PROPERTY.md`, the wiki SOP, `README.md`, `SETUP-MAC-MINI.md`, `CLAUDE.md` and the Robbie drafts matches `install.sh`.
    - Robbie's draft 2 command is one line, pins the installer hash, and works pasted into zsh.
    - The A6 compatibility table's line cites are correct at `477be4e` / `df7d1aa` / `20230f2`.
13. **Robbie drafts.** No secrets, no client or partner names, no em dashes, and nothing promised that the installer doesn't do.
14. **Readback realism.** The fake agent and shims model the real agent. Check `pgrep -f 'node server\.js$'` against the real argv (`/usr/local/bin/node server.js`), `lsof -Fn` cwd, the `launchctl list` tab format, and that successful polls are silent in `agent.log` (only the start line and errors are logged, `server.js:2846`, `:2771`).
    - Could a healthy install fail the readback on the real Mini (a false automatic rollback)? Consider OBS not running, `diag` taking longer than 30 s, a 1 s idle poll producing a transient 5xx, or `RECORD_POLL_URL` unreachable for a minute.
15. **No regressions.** Agent runtime code (`*.js` in `modules.txt`), `obs-launcher.sh` and `self-update.js` are unchanged in `20230f2..HEAD`. Confirm with `git diff --stat 20230f2..HEAD -- '*.js' obs-launcher.sh com.es.obs-launcher.plist modules.txt`: only test files should appear.
16. **Tests.** Do the new tests model the failures faithfully? Confirm the fail-before claims:
    - (a)–(d) run the `20230f2` `install.sh` (v1) on the same fixtures;
    - the two `0867c7f` tests fail with `ES_MINI_TEST_INSTALLER=<c0de4bd install.sh>`.

    Is anything important still untested (`--advise-only`, Homebrew install path, `--agent-down-ok`, a `--set PORT=` change, a backup verification race)?

## Rules

- Read-only. Make no commits and no repo edits; scratch files go outside the repo. No push, PR, release, deploy, Supabase write, Slack message or email.
- Never touch Robbie's Mini, the real `~/Library/LaunchAgents`, launchd or `defaults` on this Mac. The tests use a fake `HOME` and PATH shims; keep it that way for any reproduction.
- You may run the offline tests, `/bin/bash -n`, the package script into `/private/tmp`, and throwaway sandboxes modelled on `test/install-v2.test.js`.
- If you claim a bug, reproduce it against the real `install.sh` in a sandbox. Otherwise mark it **unproven**.
- Verify claims against the code, not the docs.

## Commands

```
cd /Users/annabui/build/es-mini-one-command-20261106-mini
git log --oneline 20230f2..HEAD                       # A1..A8 + one fix commit
git diff --stat 20230f2..HEAD -- '*.js' obs-launcher.sh com.es.obs-launcher.plist modules.txt   # tests only
shasum -a 256 install.sh                              # 8caa2507aae966a40bd48bb38da104ca67421248daf2ffe85c8c815b1dd2242f
/bin/bash -n install.sh scripts/build-mini-package.sh obs-launcher.sh uninstall.sh
node --test --test-concurrency=1 --test-timeout=120000 test/install-v2.test.js test/install-scripts.test.js test/build-package.test.js   # 50 pass at 0867c7f
node --test --test-concurrency=1 --test-timeout=120000 test/*.test.js   # expect >= 285 tests, 0 fail, 1 skip (rtsp/upload tests can flake under load: rerun the file alone first)
rm -rf /private/tmp/es-audit-pkg && /bin/bash scripts/build-mini-package.sh "$PWD" /private/tmp/es-audit-pkg 20230f2 2026.11.05-1 && shasum -a 256 /private/tmp/es-audit-pkg/* /private/tmp/es-posttf48-mini-pkg/out/es-mini-agent-2026.11.05-1-20230f2.tar
# fail-before for the 0867c7f fix:
git show c0de4bd:install.sh > /private/tmp/install-c0de4bd.sh && ES_MINI_TEST_INSTALLER=/private/tmp/install-c0de4bd.sh node --test --test-concurrency=1 --test-name-pattern='key rotation|hand-installed' test/install-v2.test.js   # both fail
git status --short                                    # must be clean
```

`timeout(1)` does not exist on macOS. Kill only PIDs you started.

## Gates that are not code (do not re-decide)

- B1: which path Robbie uses today (installer v2 after a GO, or the manual S6 runbook 6c). Anna decides.
- B2/B3: push + PR stacked on #26, and the GitHub release. Anna runs them after a GO.
- Robbie runs the command in Terminal on the Mini, in a window with nothing booked for 30 minutes; Anna approves the window.
- Mini PRs #25/#26 stay unmerged until the install is verified (the `update` op pulls `main`); `update` is never queued.
- Shared `RECORD_CONTROL_KEY` across Minis (Known limit 1), login policy after a power cut (Known limit 2): policy, not code.
- Migration 0124, app #72 and hb #44 are not live; `mic_check` stays inert (A6).

## Return format

1. **Verdict:** GO or NO-GO, in one line.
2. **Blocking findings**, if any. For each: file and line, the concrete sequence, your reproduction (or "unproven"), and the smallest fix.
3. **Prior-round items:** none (round 1). List instead the build plan's A2 items 1–10, each with status (met / partly / not met) and evidence.
4. **Non-blocking findings and accepted limits.**
5. **Checks you ran,** with results. Confirm that you changed nothing.
