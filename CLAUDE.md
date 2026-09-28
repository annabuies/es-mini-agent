# es-mini-agent: rules for any AI assistant working here

This agent runs unattended on the EVRYBDY Studios Mac Mini (bench-1). **`main` is live.** The Mini self-updates from `main` (only the `*.js` files listed in `modules.txt`), and people run `install.sh` straight from `main` with `curl`.

## How changes land
1. Never push to `main`, merge a PR, or force-push. `main` is protected.
2. Create a branch (`<name>/<short-topic>`), commit, push the branch, and open a pull request.
3. Every PR gets an automatic **AI PR Review** (the `review` check). A Must Fix from the review blocks the merge. Fix it on the same branch.
4. **Anna merges.** Your job ends at an open PR with a passing review.
5. If you're not sure about a fix, open an issue (`gh issue create`) instead: what happened, when (with the time zone), log lines with secrets removed.

## Never
- Commit, log or paste secrets: `RECORD_CONTROL_KEY`, AWS/R2 keys, power strip, camera or OBS passwords, or anything from `~/Library/LaunchAgents/com.es.mini-agent.plist`.
- Deploy anything, or run the installer on the Mini, unless Anna has sent a runbook for it.
- Run git in `~/Documents/es-mini-agent` on the Mini. That's the live install, not a checkout. Clone into `~/code/` instead.
- List a non-`.js` file in `modules.txt` (the live self-update rejects the whole update).
- Have launchd run a shell script from `~/Documents` (macOS blocks it; use `~/Library/Application Support/es-mini-agent/`).

## Before opening a PR
`npm test` must pass. For changes to the reviewer: `python3 -m pytest -q scripts/pr-review`.
