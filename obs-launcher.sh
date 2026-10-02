#!/usr/bin/env bash

set -euo pipefail

log() { printf '%s [es-obs-launcher] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

# launchd may run this while OBS is already open (for example after reinstalling
# the LaunchAgent). In that case, leave the existing process alone, but say so:
# an OBS that macOS reopened itself has no --disable-shutdown-check and can be
# sitting at the Safe Mode dialog.
obs_pid="$(pgrep -x OBS 2>/dev/null || pgrep -x obs 2>/dev/null || true)"
if [[ -n "$obs_pid" ]]; then
  obs_pid="${obs_pid%%$'\n'*}"
  log "OBS already running (pid $obs_pid), leaving it: $(ps -o args= -p "$obs_pid" 2>/dev/null || true)"
  exit 0
fi

log "starting OBS with --disable-shutdown-check"

for obs_app in "/Applications/OBS.app" "$HOME/Applications/OBS.app"; do
  if [[ -d "$obs_app" ]]; then
    exec open "$obs_app" --args --disable-shutdown-check
  fi
done

# Let Launch Services resolve non-standard installations registered as OBS.
if open -Ra OBS >/dev/null 2>&1; then
  exec open -a OBS --args --disable-shutdown-check
fi

printf '%s\n' '[es-obs-launcher] OBS.app was not found.' >&2
exit 1
