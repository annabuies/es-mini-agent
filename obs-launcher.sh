#!/usr/bin/env bash

set -euo pipefail
export LC_ALL=C
# lsof lives in /usr/sbin, which a LaunchAgent's PATH may not include.
export PATH="${PATH:-/usr/bin:/bin}:/usr/sbin:/sbin"

log() { printf '%s [es-obs-launcher] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

# An OBS without --disable-shutdown-check that started this soon after login is
# one macOS reopened from its saved session (Robbie's power pull, 10-02: 11 s
# after login, Safe Mode dialog up). Anything older was opened by hand.
RESTORED_WINDOW_S="${ES_OBS_RESTORED_WINDOW_S:-180}"

first_pid() { local p; p="$("$@" 2>/dev/null || true)"; printf '%s' "${p%%$'\n'*}"; }

# Process start time in epoch seconds; empty if the process is gone.
start_epoch() {
  local started
  started="$(ps -o lstart= -p "$1" 2>/dev/null | awk '{print $1, $2, $3, $4, $5}')"
  [[ -n "$started" ]] || return 0
  date -j -f '%a %b %d %T %Y' "$started" +%s 2>/dev/null || true
}

# Why this OBS may be in use, or nothing if it is not. A restored OBS stuck at
# the Safe Mode dialog has no recording file open and no listening port (its
# plugins, obs-websocket included, load after the dialog). A recording file
# open means someone is recording; a listening port means OBS got past the
# dialog and the agent or a person can be driving it. If its open files cannot
# be read at all, that is reason enough to leave it (audit 10-05 F3).
obs_in_use() {
  local files listening
  files="$(lsof -n -P -p "$1" -Fn 2>/dev/null || true)"
  if [[ -z "$files" ]]; then
    printf 'its open files cannot be read'
    return 0
  fi
  if grep -Eiq '^n.*\.(mkv|mp4|mov|flv|ts|m3u8|m4v)$' <<<"$files"; then
    printf 'it has a recording file open'
    return 0
  fi
  listening="$(lsof -n -P -a -p "$1" -iTCP -sTCP:LISTEN -Fn 2>/dev/null || true)"
  if grep -q '^n' <<<"$listening"; then
    printf 'it is listening on a port, so it is past the Safe Mode dialog'
  fi
  return 0
}

find_obs() {
  local p
  p="$(first_pid pgrep -x OBS)"
  [[ -n "$p" ]] || p="$(first_pid pgrep -x obs)"
  printf '%s' "$p"
}

# The Dock starts with the GUI login, so its start time marks the login. At
# login launchd can run this before the Dock is up; give it a moment.
login_epoch() {
  local dock_pid="" i
  for i in 1 2 3 4 5 6; do
    dock_pid="$(first_pid pgrep -x -u "$(id -u)" Dock)"
    [[ -n "$dock_pid" ]] && break
    sleep 5
  done
  [[ -n "$dock_pid" ]] && start_epoch "$dock_pid"
  return 0
}

obs_pid="$(find_obs)"
if [[ -n "$obs_pid" ]]; then
  obs_args="$(ps -o args= -p "$obs_pid" 2>/dev/null || true)"
  if [[ "$obs_args" == *--disable-shutdown-check* ]]; then
    log "OBS already running with --disable-shutdown-check (pid $obs_pid), leaving it"
    exit 0
  fi

  # launchd also runs this mid-day when the installer reloads the LaunchAgent.
  # Never touch an OBS someone opened by hand then: it may be recording.
  obs_start="$(start_epoch "$obs_pid")"
  login_start="$(login_epoch)"
  if [[ -z "$obs_start" || -z "$login_start" ]] \
    || (( obs_start - login_start < -30 || obs_start - login_start > RESTORED_WINDOW_S )); then
    log "OBS already running (pid $obs_pid), not started with this login, leaving it: $obs_args"
    exit 0
  fi

  # A person can open OBS by hand in the same window (the launcher waits up to
  # 30 s for the Dock) and start recording: only an OBS that shows no sign of use
  # is restarted.
  in_use="$(obs_in_use "$obs_pid")"
  if [[ -n "$in_use" ]]; then
    log "OBS (pid $obs_pid) started $((obs_start - login_start)) s after login without --disable-shutdown-check, but $in_use; leaving it: $obs_args"
    exit 0
  fi

  # Without the flag a restored OBS sits at the Safe Mode dialog, which also
  # ignores a polite quit. It is not recording, so end it and relaunch.
  log "OBS (pid $obs_pid) was reopened by macOS $((obs_start - login_start)) s after login without --disable-shutdown-check; restarting it: $obs_args"
  kill -TERM "$obs_pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$obs_pid" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$obs_pid" 2>/dev/null; then
    log "OBS (pid $obs_pid) ignored SIGTERM for 10 s; sending SIGKILL"
    kill -KILL "$obs_pid" 2>/dev/null || true
    sleep 2
  fi
  if kill -0 "$obs_pid" 2>/dev/null; then
    log "OBS (pid $obs_pid) is still running; giving up, it may be at the Safe Mode dialog"
    exit 1
  fi
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
