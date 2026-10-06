#!/usr/bin/env bash

set -euo pipefail
export LC_ALL=C
# sysctl lives in /usr/sbin, which a LaunchAgent's PATH may not include.
export PATH="${PATH:-/usr/bin:/bin}:/usr/sbin:/sbin"

log() { printf '%s [es-obs-launcher] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
# An alert also goes to stderr, so obs-launcher.error.log is no longer empty.
alert() { log "ALERT: $*"; printf '%s [es-obs-launcher] ALERT: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; }

# OBS 32 removed --disable-shutdown-check (obsproject/obs-studio#12650): the
# Safe Mode dialog now comes only from crash markers. Each OBS run creates
# obs-studio/.sentinel/run_<uuid> and a clean quit deletes them all; on start,
# any run_* that is not its own makes OBS log "Crash or unclean shutdown
# detected" and wait at the dialog before it loads obs-websocket
# (frontend/utility/CrashHandler.cpp, frontend/OBSApp.cpp in 32.1.0).
#
# Policy (Anna, 10-05): after a reboot, unattended recovery wins. On a cold
# login, markers written before this boot (power cut, restart with OBS open, or a
# crash before the restart) are moved to an archive, never deleted, and OBS is
# started once. Markers written since this boot mean OBS crashed or was
# force-quit during this boot: they are left, so OBS shows its dialog. The
# launcher only stops a running OBS when a cold-login macOS relaunch is proven
# stuck at the dialog. An OBS that finished startup is never stopped.
OBS_CONFIG_DIR="$HOME/Library/Application Support/obs-studio"
SENTINEL_DIR="$OBS_CONFIG_DIR/.sentinel"
OBS_LOG_DIR="$OBS_CONFIG_DIR/logs"
ARCHIVE_DIR="$HOME/Library/Application Support/es-mini-agent/obs-sentinel-archive"
# launchd runs this at login (RunAtLoad) and again whenever the installer reloads
# the LaunchAgent. Only a run this soon after login counts as a cold login.
LOGIN_WINDOW_S="${ES_OBS_LOGIN_WINDOW_S:-180}"
# How long to watch OBS's own log for the result of the one launch.
STARTUP_WAIT_S="${ES_OBS_STARTUP_WAIT_S:-90}"

first_pid() { local p; p="$("$@" 2>/dev/null || true)"; printf '%s' "${p%%$'\n'*}"; }

# Process start time in epoch seconds; empty if the process is gone.
start_epoch() {
  local started
  started="$(ps -o lstart= -p "$1" 2>/dev/null | awk '{print $1, $2, $3, $4, $5}')"
  [[ -n "$started" ]] || return 0
  date -j -f '%a %b %d %T %Y' "$started" +%s 2>/dev/null || true
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

# "{ sec = 1759650000, usec = 0 } Mon Oct  5 ..." -> 1759650000
boot_epoch() {
  local raw
  raw="$(sysctl -n kern.boottime 2>/dev/null || true)"
  sed -n 's/^{ sec = \([0-9][0-9]*\),.*/\1/p' <<<"$raw"
}

# Last-modified time in epoch seconds. OBS creates a marker and never writes to
# it again, so this is when that OBS run started.
mtime_epoch() { stat -f %m "$1" 2>/dev/null || true; }

markers() {
  local f
  for f in "$SENTINEL_DIR"/run_*; do
    [[ -f "$f" ]] && printf '%s\n' "$f"
  done
  return 0
}

# Move markers from before this boot to the archive (mv keeps their times).
archive_previous_boot_markers() {
  local boot dest="" f m moved=0
  boot="$(boot_epoch)"
  if [[ -z "$boot" ]]; then
    log "cannot read the boot time; leaving OBS crash markers as they are"
    return 0
  fi
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    m="$(mtime_epoch "$f")"
    [[ -n "$m" ]] && (( m < boot )) || continue
    if [[ -z "$dest" ]]; then
      dest="$ARCHIVE_DIR/$(date '+%Y%m%d-%H%M%S')"
      if ! mkdir -p "$dest"; then
        log "cannot create $dest; leaving OBS crash markers as they are"
        return 0
      fi
    fi
    if mv -n "$f" "$dest/"; then
      moved=$((moved + 1))
      log "archived OBS crash marker ${f##*/} (OBS run started $(date -r "$m" '+%Y-%m-%d %H:%M:%S'), before this boot): OBS was open at a power cut or restart, or crashed before it"
    else
      log "could not archive OBS crash marker ${f##*/}; leaving it"
    fi
  done < <(markers)
  (( moved == 0 )) || log "archived $moved OBS crash marker(s) to $dest"
}

# macOS may reopen OBS before this LaunchAgent. Recover only when an old marker
# caused that new process to wait at the dialog. Its own marker is archived only
# after the process exits; any other marker from this boot blocks recovery.
recover_reopened_dialog() {
  local pid="$1" started="$2" boot login now f m old=0 own=0 other=0 file contents i
  boot="$(boot_epoch)"
  login="$(login_epoch)"
  now="$(date +%s)"
  [[ -n "$boot" && -n "$login" && -n "$started" ]] || return 1
  (( now >= login && now - login <= LOGIN_WINDOW_S && started >= boot && started <= now )) || return 1

  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    m="$(mtime_epoch "$f")"
    [[ -n "$m" ]] || return 1
    if (( m < boot )); then
      old=$((old + 1))
    elif (( m >= started - 2 && m <= started + 15 )); then
      own=$((own + 1))
    else
      other=$((other + 1))
    fi
  done < <(markers)
  (( old > 0 && own == 1 && other == 0 )) || return 1

  # Check twice so a person choosing Normal Mode while we inspect the log wins.
  for i in 1 2; do
    [[ "$(find_obs)" == "$pid" && "$(start_epoch "$pid")" == "$started" ]] || return 1
    file="$(newest_log_since "$((started - 2))")"
    [[ -n "$file" ]] || return 1
    contents="$(cat "$file" 2>/dev/null || true)"
    [[ "$contents" == *"Crash or unclean shutdown detected"* ]] || return 1
    [[ "$contents" != *"Current Date/Time:"* && "$contents" != *"launch selected"* ]] || return 1
    (( i == 2 )) || sleep 2
  done

  log "OBS (pid $pid) is blocked at the Safe Mode dialog during cold login with a preboot marker; requesting a clean stop"
  kill -TERM "$pid" 2>/dev/null || { alert "could not stop dialog-blocked OBS (pid $pid)"; return 2; }
  for i in 1 2 3 4 5; do
    [[ "$(find_obs)" == "$pid" ]] || break
    sleep 2
  done
  if [[ "$(find_obs)" == "$pid" ]]; then
    alert "dialog-blocked OBS (pid $pid) did not exit after TERM; leaving its markers and not starting another copy"
    return 2
  fi
  # Recheck marker times after exit. A new marker or OBS process means another
  # launch raced us; leave it alone rather than clearing its crash evidence.
  [[ -z "$(find_obs)" ]] || { alert "another OBS process appeared during recovery; not starting a copy"; return 2; }
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    m="$(mtime_epoch "$f")"
    [[ -n "$m" ]] || { alert "cannot read OBS marker time during recovery; not starting another copy"; return 2; }
    (( m < boot || (m >= started - 2 && m <= started + 15) )) || {
      alert "new OBS crash marker appeared during recovery; leaving markers and not starting another copy"
      return 2
    }
  done < <(markers)
  # The process has exited, so both its marker and the preboot marker can be
  # archived. The same archive operation preserves timestamps and provenance.
  archive_previous_boot_markers
  local dest="$ARCHIVE_DIR/$(date '+%Y%m%d-%H%M%S')-reopened"
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    m="$(mtime_epoch "$f")"
    [[ -n "$m" ]] && (( m >= started - 2 && m <= started + 15 )) || continue
    mkdir -p "$dest" && mv -n "$f" "$dest/" || {
      alert "could not archive reopened OBS marker ${f##*/}; not starting another copy"
      return 2
    }
    log "archived reopened OBS marker ${f##*/} to $dest"
  done < <(markers)
  [[ -z "$(markers)" ]] || { alert "OBS markers remain after recovery; not starting another copy"; return 2; }
  log "dialog-blocked OBS exited and its markers were archived; starting a fresh OBS"
  return 0
}

# Newest OBS log written at or after $1 (epoch seconds). OBS names its logs
# "YYYY-MM-DD HH-MM-SS.txt", so the last one in C order is the newest.
newest_log_since() {
  local f newest="" m
  for f in "$OBS_LOG_DIR"/*.txt; do
    [[ -f "$f" ]] && newest="$f"
  done
  [[ -n "$newest" ]] || return 0
  m="$(mtime_epoch "$newest")"
  [[ -n "$m" ]] && (( m >= $1 )) && printf '%s' "$newest"
  return 0
}

# Watch OBS's own log for how startup went. Log text only drives this report;
# it is never a reason to stop OBS. Returns 1 after an alert.
#   "Crash or unclean shutdown detected"    the dialog is up (OBSApp.cpp:95)
#   "[Safe Mode] Normal launch selected"    someone chose Run in Normal Mode
#   "[Safe Mode] Safe mode launch selected" someone chose Safe Mode
#   "Current Date/Time:"                    OBSInit ran, past every startup check
watch_startup() {
  local since="$1" who="$2" waited=0 file="" text
  while :; do
    file="$(newest_log_since "$since")"
    if [[ -n "$file" ]]; then
      text="$(cat "$file" 2>/dev/null || true)"
      if [[ "$text" == *"Safe mode launch selected"* ]]; then
        alert "$who was started in Safe Mode by someone at the Mini: obs-websocket is off, so the agent cannot drive it. Quit OBS and reopen it normally. (log ${file##*/})"
        return 1
      fi
      if [[ "$text" == *"Current Date/Time:"* ]]; then
        if [[ "$text" == *"Normal launch selected"* ]]; then
          log "$who got past the Safe Mode dialog: someone chose Run in Normal Mode (log ${file##*/})"
        elif [[ "$text" == *"Crash or unclean shutdown detected"* ]]; then
          log "$who got past its crash dialog (log ${file##*/})"
        else
          log "$who started with no Safe Mode dialog (log ${file##*/})"
        fi
        return 0
      fi
    fi
    (( waited < STARTUP_WAIT_S )) || break
    sleep 2
    waited=$((waited + 2))
  done
  if [[ -z "$file" ]]; then
    alert "$who wrote no startup log within ${STARTUP_WAIT_S} s; check on the Mini that OBS opened"
  elif [[ "$text" == *"Crash or unclean shutdown detected"* ]]; then
    alert "$who is waiting at the Safe Mode dialog (log ${file##*/}). Someone at the Mini must choose Run in Normal Mode. The launcher does not stop or restart OBS."
  else
    alert "$who has not finished starting after ${STARTUP_WAIT_S} s and shows no Safe Mode dialog in its log (${file##*/}); another OBS prompt may be open"
  fi
  return 1
}

obs_pid="$(find_obs)"
if [[ -n "$obs_pid" ]]; then
  # A person may have opened it, or macOS may have reopened it; it may be
  # recording. Stop it only if recover_reopened_dialog proves the cold-login
  # dialog case; otherwise report how its startup went and leave it alone.
  log "OBS already running (pid $obs_pid), checking startup: $(ps -o args= -p "$obs_pid" 2>/dev/null || true)"
  obs_start="$(start_epoch "$obs_pid")"
  if recover_reopened_dialog "$obs_pid" "$obs_start"; then
    : # Continue to the single launch below.
  else
    recovery_status=$?
    (( recovery_status == 1 )) || exit 1
    watch_startup "$(( ${obs_start:-$(date +%s)} - 2 ))" "OBS (pid $obs_pid)" || exit 1
    exit 0
  fi
fi

now="$(date +%s)"
login_start="$(login_epoch)"
if [[ -n "$login_start" ]] && (( now - login_start <= LOGIN_WINDOW_S )); then
  archive_previous_boot_markers
  why="written since this boot: OBS crashed or was force-quit since the Mini started"
else
  log "not a cold login (${login_start:+$((now - login_start)) s after login; }launcher reloaded or login time unknown); leaving OBS crash markers as they are"
  why="not a cold login"
fi

remaining="$(markers | wc -l | tr -d ' ')"
if (( remaining > 0 )); then
  log "leaving $remaining OBS crash marker(s) in $SENTINEL_DIR ($why), so OBS will show its Safe Mode dialog"
fi

launch_at="$(date +%s)"
launched=""
for obs_app in "/Applications/OBS.app" "$HOME/Applications/OBS.app"; do
  if [[ -d "$obs_app" ]]; then
    log "starting OBS ($obs_app)"
    open "$obs_app" || { alert "could not open $obs_app"; exit 1; }
    launched=1
    break
  fi
done
# Let Launch Services resolve non-standard installations registered as OBS.
if [[ -z "$launched" ]] && open -Ra OBS >/dev/null 2>&1; then
  log "starting OBS (Launch Services)"
  open -a OBS || { alert "could not open OBS"; exit 1; }
  launched=1
fi
if [[ -z "$launched" ]]; then
  alert "OBS.app was not found"
  exit 1
fi

watch_startup "$((launch_at - 1))" "OBS" || exit 1
