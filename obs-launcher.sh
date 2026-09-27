#!/usr/bin/env bash

set -euo pipefail

# launchd may run this while OBS is already open (for example after reinstalling
# the LaunchAgent). In that case, leave the existing process alone.
if pgrep -x OBS >/dev/null 2>&1 || pgrep -x obs >/dev/null 2>&1; then
  exit 0
fi

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
