#!/usr/bin/env bash
# es-mini-agent — uninstaller.
# Stops the launchd job, removes the LaunchAgent plist, and kills any
# cloudflared quick tunnel that was pointed at the agent. Does NOT delete
# the project folder or the log files.

set -euo pipefail

BOLD=$'\033[1m'; GRN=$'\033[32m'; YLW=$'\033[33m'; RST=$'\033[0m'
info() { printf '[es-mini-agent] %s\n' "$*"; }
ok()   { printf '%s[ok]%s %s\n' "$GRN" "$RST" "$*"; }
warn() { printf '%s[warn]%s %s\n' "$YLW" "$RST" "$*"; }

PLIST_PATH="$HOME/Library/LaunchAgents/com.es.mini-agent.plist"

# 1. Unload the launchd job (ignore errors — it may not be loaded).
if [[ -f "$PLIST_PATH" ]]; then
  info "Unloading launchd job..."
  launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
  ok "launchd job unloaded (or was not loaded)."
else
  warn "No plist at $PLIST_PATH — nothing to unload."
fi

# 2. Remove the plist file.
if [[ -f "$PLIST_PATH" ]]; then
  rm -f "$PLIST_PATH"
  ok "Removed $PLIST_PATH"
else
  info "Plist already gone."
fi

# 3. Kill any cloudflared quick tunnel pointed at a local agent.
# We match any 'cloudflared tunnel --url http://localhost' process — this
# covers both default port 8787 and any custom PORT.
if command -v pgrep >/dev/null 2>&1; then
  # -f matches full command line.
  TUNNEL_PIDS="$(pgrep -f 'cloudflared[^\n]*tunnel[^\n]*--url[[:space:]]+http://localhost' || true)"
  if [[ -n "$TUNNEL_PIDS" ]]; then
    info "Stopping cloudflared quick tunnel(s): $TUNNEL_PIDS"
    # shellcheck disable=SC2086
    kill $TUNNEL_PIDS 2>/dev/null || true
    sleep 1
    # Force-kill anything still hanging around.
    STILL="$(pgrep -f 'cloudflared[^\n]*tunnel[^\n]*--url[[:space:]]+http://localhost' || true)"
    if [[ -n "$STILL" ]]; then
      # shellcheck disable=SC2086
      kill -9 $STILL 2>/dev/null || true
    fi
    ok "cloudflared tunnel stopped."
  else
    info "No cloudflared quick tunnel was running."
  fi
else
  warn "pgrep not available — skipping cloudflared cleanup."
fi

cat <<EOF

${BOLD}es-mini-agent has been uninstalled.${RST}

  - The launchd LaunchAgent is gone; it will NOT auto-start at next login.
  - Your project folder and logs were kept (nothing under
    ~/Documents/es-mini-agent was deleted).

To reinstall later, re-run ./install.sh with BUILDING_ID and RECORD_CONTROL_KEY.

EOF
