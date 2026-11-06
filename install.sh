#!/bin/bash
# es-mini-agent installer v2: one command installs or updates a Mac mini.
#
# What it does, in order (nothing is changed until step 5):
#   1. preflight   report macOS, Homebrew, Node >= 22, ffmpeg/ffprobe, OBS + plugins,
#                  FileVault, auto-restart, free disk. Installs only node/ffmpeg (Homebrew).
#   2. busy guard  refuses while the agent is recording, paused or uploading.
#   3. verify      the release tar must match ES_MINI_TAR_SHA256; every file must match
#                  SHA256SUMS-files-<V>.txt; every module passes node --check.
#   4. plan        new plist = the live plist with EVERY key kept, only the paths changed
#                  plus any explicit --set / ES_MINI_CONFIG values. Prints key NAMES only.
#   5. backup      ~/es-backups/mini-<UTC>/ (plists always; old runtime + OBS settings when
#                  readable), verified with shasum before anything is swapped.
#   6. swap        new runtime in ~/es-mini-agent-runtimes/<V>-<c7>/ (never ~/Documents);
#                  the old folder is never touched, so rollback is a plist swap.
#   7. readback    /health, diag version + commit, one process in the new folder, launchd
#                  jobs, no crash loop, relay polling. Fails => automatic rollback.
#
# Robbie's command (Anna fills the values from the release; see docs/INSTALL.md):
#   cd ~/Downloads && curl -fsSLO <release>/install.sh \
#     && echo "<installer sha256>  install.sh" | shasum -a 256 -c \
#     && ES_MINI_VERSION=<V> ES_MINI_COMMIT=<commit> ES_MINI_TAR_SHA256=<tar sha256> /bin/bash install.sh
#
# Inputs (environment):
#   ES_MINI_VERSION      required  e.g. 2026.11.05-1
#   ES_MINI_COMMIT       required  7-40 hex; the tar is es-mini-agent-<V>-<first 7>.tar
#   ES_MINI_TAR_SHA256   required  64 hex
#   ES_MINI_RELEASE_URL  optional  default https://github.com/annabuies/es-mini-agent/releases/download/v<V>/
#   ES_MINI_TAR          optional  local tar path instead of downloading (AirDrop / Downloads)
#   ES_MINI_SUMS         optional  local SHA256SUMS-files-<V>.txt (default: next to ES_MINI_TAR)
#   ES_MINI_CONFIG       optional  KEY=VALUE file (mode 600), read literally, never printed.
#                                  Needed on a fresh Mini: BUILDING_ID, RECORD_CONTROL_KEY, ...
# Flags:
#   --set KEY=VALUE   set one plist env value (repeatable; for non-secret values,
#                     since command lines are visible in shell history)
#   --dry-run         do steps 1-4 and print the plan; write nothing
#   --rollback [dir]  restore the newest (or given) ~/es-backups/mini-* plist and read back
#   --obs-launcher    also install/refresh the OBS login launcher
#   --yes             do not ask before the swap
#   --advise-only     continue even if Homebrew, OBS, its plugins or disk space are missing
#   --agent-down-ok   continue when a plist exists but the agent does not answer (Anna only)
#   --local           bench only: package this checkout's HEAD and install it (no network)
#
# There is no download from GitHub main, ever. The `update` op (which pulls main) is a
# separate path and must never be queued.
#
# bash 3.2 safe (macOS /bin/bash): no associative arrays, no mapfile, no ${var,,},
# and no "${empty[@]}" under set -u.

set -euo pipefail
umask 077

INSTALLER_VERSION="2026.11.06-v2"

# ---------- output ----------
if [ -t 1 ]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; CYA=$'\033[36m'; RST=$'\033[0m'
else
  BOLD=''; RED=''; GRN=''; YLW=''; CYA=''; RST=''
fi
info() { printf '%s[es-mini]%s %s\n' "$CYA" "$RST" "$*"; }
ok()   { printf '%s[ok]%s %s\n' "$GRN" "$RST" "$*"; }
warn() { printf '%s[warn]%s %s\n' "$YLW" "$RST" "$*"; WARNINGS="${WARNINGS}${WARNINGS:+; }$*"; }
err()  { printf '%s[error]%s %s\n' "$RED" "$RST" "$*" 1>&2; }
die()  { err "$*"; printf '\n%s%sSTOPPED: nothing was changed by this step.%s\n' "$RED" "$BOLD" "$RST" 1>&2; exit 1; }
WARNINGS=""
CR="$(printf '\r')"; NL='
'

usage() { sed -n '2,45p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

# ---------- arguments ----------
DRY_RUN=0; ROLLBACK=0; ROLLBACK_DIR=""; INSTALL_OBS_LAUNCHER=0; YES=0; LOCAL=0
ADVISE_ONLY=0; AGENT_DOWN_OK=0
SET_LINES=""          # newline-separated KEY=VALUE (no arrays: bash 3.2 + set -u)
add_set() {
  case "$1" in
    *"$NL"*) die "--set value must be one line" ;;
    [A-Z_]*=*) ;;
    *) die "--set needs KEY=VALUE with an upper-case KEY (got a malformed entry)" ;;
  esac
  local k="${1%%=*}"
  [[ "$k" =~ ^[A-Z_][A-Z0-9_]*$ ]] || die "--set: bad key name '$k'"
  SET_LINES="${SET_LINES}$1"$'\n'
  SET_NAMES="${SET_NAMES} $k"
}
SET_NAMES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --rollback)
      ROLLBACK=1
      if [ $# -gt 1 ] && [ "${2#--}" = "$2" ]; then ROLLBACK_DIR="$2"; shift; fi ;;
    --obs-launcher) INSTALL_OBS_LAUNCHER=1 ;;
    --yes) YES=1 ;;
    --local) LOCAL=1 ;;
    --advise-only) ADVISE_ONLY=1 ;;
    --agent-down-ok) AGENT_DOWN_OK=1 ;;
    --set) [ $# -gt 1 ] || die "--set needs KEY=VALUE"; add_set "$2"; shift ;;
    --set=*) add_set "${1#--set=}" ;;
    -h|--help) usage; exit 0 ;;
    *) err "Unknown option: $1"; exit 2 ;;
  esac
  shift
done

[ "$(uname -s)" = "Darwin" ] || die "This installer is for macOS only."
[ "$(id -u)" -ne 0 ] || die "Do not run with sudo. Run it as the Mini's own user in Terminal."

# ---------- fixed paths ----------
PB=/usr/libexec/PlistBuddy
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PL="$LAUNCH_AGENTS_DIR/com.es.mini-agent.plist"
OBS_PL="$LAUNCH_AGENTS_DIR/com.es.obs-launcher.plist"
RUNTIMES="$HOME/es-mini-agent-runtimes"
BACKUPS="$HOME/es-backups"
APP_SUPPORT="$HOME/Library/Application Support/es-mini-agent"
OBS_SETTINGS="$HOME/Library/Application Support/obs-studio"
OBS_APP="${ES_MINI_OBS_APP:-/Applications/OBS.app}"
READBACK_TIMEOUT="${ES_MINI_READBACK_TIMEOUT:-60}"
SETTLE_S="${ES_MINI_SETTLE_S:-10}"
MIN_FREE_GIB="${ES_MINI_MIN_FREE_GIB:-20}"
# Where Homebrew-style tools are looked for besides PATH (tests point this at shims).
TOOL_DIRS="${ES_MINI_TOOL_DIRS:-/opt/homebrew/bin /usr/local/bin}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
SELF="${BASH_SOURCE[0]:-}"
SCRIPT_DIR=""
if [ -n "$SELF" ] && [ -f "$SELF" ]; then SCRIPT_DIR="$(cd "$(dirname "$SELF")" && pwd)"; fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/es-mini-install.XXXXXX")"
chmod 700 "$WORK"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# ---------- small node helpers (values never printed) ----------
# json_get <dotted.path>  (stdin JSON) -> value, "null", "object", __missing__ or __badjson__
JS_GET='let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v;try{v=JSON.parse(s)}catch(e){process.stdout.write("__badjson__");return}for(const k of process.argv[1].split(".")){if(v==null||typeof v!=="object"){v=undefined;break}v=v[k]}process.stdout.write(v===undefined?"__missing__":v===null?"null":typeof v==="object"?"object":String(v))})'
# plist_merge <old.json|-> <sets.txt> <out.json>   env NEW_WD NEW_NODE; old "-" = fresh skeleton
JS_MERGE='const fs=require("fs");const[oldF,setsF,outF]=process.argv.slice(1);const wd=process.env.NEW_WD,node=process.env.NEW_NODE;
let p=oldF==="-"?{Label:"com.es.mini-agent",ProgramArguments:[node,"server.js"],EnvironmentVariables:{},RunAtLoad:true,KeepAlive:true,ProcessType:"Background"}:JSON.parse(fs.readFileSync(oldF,"utf8"));
if(p.Label!=="com.es.mini-agent"){console.error("plist Label is not com.es.mini-agent");process.exit(3)}
const env=(p.EnvironmentVariables&&typeof p.EnvironmentVariables==="object"&&!Array.isArray(p.EnvironmentVariables))?p.EnvironmentVariables:{};
for(const k of Object.keys(env)){if(typeof env[k]!=="string"){console.error("env key "+k+" is not a string");process.exit(3)}}
for(const line of fs.readFileSync(setsF,"utf8").split("\n")){if(!line)continue;const i=line.indexOf("=");env[line.slice(0,i)]=line.slice(i+1)}
p.EnvironmentVariables=env;p.WorkingDirectory=wd;p.StandardOutPath=wd+"/agent.log";p.StandardErrorPath=wd+"/agent.error.log";
if(Array.isArray(p.ProgramArguments)&&p.ProgramArguments.length===2&&p.ProgramArguments[1]==="server.js")p.ProgramArguments[0]=node;else p.ProgramArguments=[node,"server.js"];
fs.writeFileSync(outF,JSON.stringify(p),{mode:0o600});'
# plist_diff <old.json> <new.json> -> "env-changed K", "env-added K", "env-removed K", "top-changed K"
JS_DIFF='const fs=require("fs");const a=JSON.parse(fs.readFileSync(process.argv[1],"utf8")),b=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
const ea=a.EnvironmentVariables||{},eb=b.EnvironmentVariables||{};const out=[];
for(const k of Object.keys(ea).sort()){if(!(k in eb))out.push("env-removed "+k);else if(ea[k]!==eb[k])out.push("env-changed "+k)}
for(const k of Object.keys(eb).sort()){if(!(k in ea))out.push("env-added "+k)}
const ks=new Set([...Object.keys(a),...Object.keys(b)]);ks.delete("EnvironmentVariables");
for(const k of [...ks].sort()){if(JSON.stringify(a[k])!==JSON.stringify(b[k]))out.push("top-changed "+k)}
process.stdout.write(out.join("\n"));'
# env_names <file.json> -> sorted key names, space separated
JS_NAMES='const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(Object.keys(p.EnvironmentVariables||{}).sort().join(" "))'
# env_get <file.json> <KEY> -> value (for PORT / RECORD_CONTROL_KEY into shell variables only)
JS_ENVGET='const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=(p.EnvironmentVariables||{})[process.argv[2]];process.stdout.write(typeof v==="string"?v:"")'
JS_TOPGET='const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=p[process.argv[2]];process.stdout.write(typeof v==="string"?v:"")'

NODE_BIN=""
json_get()  { "$NODE_BIN" -e "$JS_GET" "$1"; }

# ---------- preflight ----------
node_major() { "$1" -v 2>/dev/null | sed -E 's/^v?([0-9]+).*/\1/'; }
find_node() {
  local c m
  local d cands="$*"
  for d in $TOOL_DIRS; do cands="$cands $d/node"; done
  for c in $cands "$(command -v node 2>/dev/null || true)"; do
    [ -n "$c" ] && [ -x "$c" ] || continue
    m="$(node_major "$c")"
    if [[ "$m" =~ ^[0-9]+$ ]] && [ "$m" -ge 22 ]; then printf '%s' "$c"; return 0; fi
  done
  return 1
}
find_tool() {
  local name="$1" c d cands=""
  for d in $TOOL_DIRS; do cands="$cands $d/$name"; done
  for c in "$(command -v "$name" 2>/dev/null || true)" $cands; do
    [ -n "$c" ] && [ -x "$c" ] && { printf '%s' "$c"; return 0; }
  done
  return 1
}
BREW=""
STOPS=""
stop_later() { STOPS="${STOPS}  - $*"$'\n'; }

preflight() {
  local plist_node="${1:-}" mac arch obs_v p found free fv ar
  mac="$(sw_vers -productVersion 2>/dev/null || echo unknown)"; arch="$(uname -m)"
  info "preflight: macOS $mac ($arch), installer $INSTALLER_VERSION"

  BREW="$(find_tool brew || true)"
  if [ -n "$BREW" ]; then ok "Homebrew: $BREW"; else
    stop_later 'Homebrew is missing. In Terminal run: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" (asks for the Mac password), then re-run this command.'
  fi

  NODE_BIN="$(find_node "$plist_node" || true)"
  if [ -z "$NODE_BIN" ]; then
    if [ -n "$BREW" ] && [ "$DRY_RUN" = 0 ]; then
      info "Node >= 22 not found: installing with Homebrew (a few minutes)"
      "$BREW" install node || true
      NODE_BIN="$(find_node || true)"
    fi
  fi
  [ -n "$NODE_BIN" ] || die "Node 22 or newer is required and was not found${BREW:+ (brew install node did not provide it)}. Install the LTS from https://nodejs.org, then re-run."
  ok "Node $("$NODE_BIN" -v) at $NODE_BIN"

  FFMPEG_FOUND="$(find_tool ffmpeg || true)"
  if [ -z "$FFMPEG_FOUND" ] && [ -n "$BREW" ] && [ "$DRY_RUN" = 0 ]; then
    info "ffmpeg not found: installing with Homebrew"
    "$BREW" install ffmpeg || true
    FFMPEG_FOUND="$(find_tool ffmpeg || true)"
  fi
  if [ -n "$FFMPEG_FOUND" ]; then ok "ffmpeg: $FFMPEG_FOUND"; else warn "ffmpeg missing: watch copies and RTSP capture will not work (brew install ffmpeg)"; fi
  p="$(find_tool ffprobe || true)"
  if [ -n "$p" ]; then ok "ffprobe: $p"; else warn "ffprobe missing (comes with brew install ffmpeg)"; fi

  if [ -f "$OBS_APP/Contents/Info.plist" ]; then
    obs_v="$("$PB" -c 'Print :CFBundleShortVersionString' "$OBS_APP/Contents/Info.plist" 2>/dev/null || echo unknown)"
    ok "OBS $obs_v"
  else
    stop_later "OBS is not installed at $OBS_APP. Install OBS Studio from https://obsproject.com, then follow SETUP-MAC-MINI.md steps 4-5."
  fi
  for p in source-record distroav; do
    found=""
    for d in "$OBS_SETTINGS/plugins" "/Library/Application Support/obs-studio/plugins"; do
      [ -e "$d/$p.plugin" ] && found="$d/$p.plugin"
    done
    if [ -n "$found" ]; then ok "OBS plugin $p"; else stop_later "OBS plugin $p.plugin is missing (SETUP-MAC-MINI.md step 4)."; fi
  done

  fv="$(fdesetup status 2>/dev/null | head -1 || true)"
  ar="$(pmset -g 2>/dev/null | awk '/^ *autorestart/{print $2}' || true)"
  fv="${fv%.}"; fv="${fv#FileVault is }"
  info "FileVault: ${fv:-unknown}. Auto-restart after power loss: ${ar:-unknown}"
  if [ "${ar:-}" != "1" ]; then warn "auto-restart is off. Advice (needs the Mac password): sudo pmset -a autorestart 1"; fi
  info "Reminder: the agent runs only while this user is logged in. After a power cut someone (or auto-login) must log in. This is the property's login policy, not changed here."

  free="$(df -Pk "$HOME" | awk 'NR==2{print int($4/1048576)}')"
  if [ "$free" -ge "$MIN_FREE_GIB" ]; then ok "free disk: ${free} GiB"; else stop_later "only ${free} GiB free on the home volume; need ${MIN_FREE_GIB} GiB."; fi

  if [ -n "$STOPS" ]; then
    printf '\n%sPreflight found missing pieces:%s\n%s' "$YLW" "$RST" "$STOPS"
    if [ "$ADVISE_ONLY" = 1 ]; then warn "--advise-only: continuing anyway"; else die "fix the items above (or ask Anna), then run the same command again."; fi
  fi
}

# ---------- agent access (key read into a variable, never printed or put in argv) ----------
PORT=""; RCK=""
agent_health() { curl -fsS --max-time 5 "http://127.0.0.1:$PORT/health" 2>/dev/null; }
agent_post() {
  printf 'Authorization: Bearer %s\n' "$RCK" \
    | curl -fsS --max-time "${2:-15}" -X POST -H @- -H 'Content-Type: application/json' --data '{}' "http://127.0.0.1:$PORT/record/$1" 2>/dev/null
}

# guard_busy <when>: returns only if it is safe to change runtimes.
guard_busy() {
  local when="$1" h st v q a pp
  if ! h="$(agent_health)"; then
    if [ ! -f "$PL" ]; then info "busy guard ($when): no agent installed and nothing on :$PORT (fresh Mini)"; return 0; fi
    if [ "$AGENT_DOWN_OK" = 1 ]; then warn "busy guard ($when): agent not answering on :$PORT; continuing (--agent-down-ok)"; return 0; fi
    die "busy guard ($when): the agent does not answer on :$PORT. It may be restarting: wait a minute and run the same command again. If it stays down, send Anna this message."
  fi
  [ -f "$PL" ] || die "busy guard ($when): something answers on :$PORT but there is no LaunchAgent plist. Ask Anna."
  [ "$(printf '%s' "$h" | json_get ok)" = "true" ] || die "busy guard ($when): /health did not say ok:true"
  v="$(printf '%s' "$h" | json_get state.recording)"; [ "$v" = "false" ] || die "busy guard ($when): the agent is RECORDING. Run this again when the room is free."
  v="$(printf '%s' "$h" | json_get state.paused)";    [ "$v" = "false" ] || die "busy guard ($when): a take is PAUSED. Run this again when the room is free."
  [ -n "$RCK" ] || die "busy guard ($when): the plist has no RECORD_CONTROL_KEY, so the upload queue cannot be checked."
  st="$(agent_post status)" || die "busy guard ($when): the authenticated status check failed."
  [ "$(printf '%s' "$st" | json_get recording)" = "false" ] || die "busy guard ($when): status says recording. Run this again when the room is free."
  q="$(printf '%s' "$st" | json_get uploads.queued)"
  a="$(printf '%s' "$st" | json_get uploads.active)"
  pp="$(printf '%s' "$st" | json_get uploads.proxies_pending)"
  if [ "$q" != "__missing__" ]; then
    [ "$q" = "0" ] || die "busy guard ($when): $q upload(s) still queued. Wait until they finish, then run this again."
    [ "$a" = "null" ] || [ "$a" = "__missing__" ] || die "busy guard ($when): an upload is in progress. Wait until it finishes, then run this again."
    [ "$pp" = "0" ] || [ "$pp" = "__missing__" ] || die "busy guard ($when): $pp watch copies still being made. Wait, then run this again."
  fi
  ok "busy guard ($when): not recording, not paused, upload queue empty"
}

# ---------- readback ----------
size_of() { if [ -f "$1" ]; then wc -c < "$1" | tr -d ' '; else echo 0; fi; }
agent_pids() { pgrep -f 'node server\.js$' 2>/dev/null || true; }
cwd_of() { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1; }
launchd_pid() { launchctl list 2>/dev/null | awk -F'\t' -v l="$1" '$3==l{print $1}' | head -1; }

RB_RESULT=""; RB_VERSION=""; RB_COMMIT=""; RB_PID=""
# readback <expect_version|""> <expect_dir> <expect_commit|""> <out_off> <err_off> <check_logs 1|0> <other_dir|"">
# other_dir = the folder that must have NO agent process left (old runtime on install, new on rollback).
readback() {
  local ev="$1" ed="$2" ec="$3" ooff="$4" eoff="$5" logs="$6" od="$7" i h d cwd n_new n_old p pid2 outlog errlog tail_out tail_err
  RB_RESULT=""
  i=0; h=""
  while [ "$i" -lt "$READBACK_TIMEOUT" ]; do
    if h="$(agent_health)" && [ "$(printf '%s' "$h" | json_get ok)" = "true" ]; then break; fi
    h=""; sleep 1; i=$((i + 1))
  done
  [ -n "$h" ] || { RB_RESULT="agent did not answer /health within ${READBACK_TIMEOUT}s"; return 1; }
  ok "readback: /health ok"
  d="$(agent_post diag 30)" || { RB_RESULT="diag op failed"; return 1; }
  RB_VERSION="$(printf '%s' "$d" | json_get version.agent)"
  RB_COMMIT="$(printf '%s' "$d" | json_get version.commit)"
  if [ -n "$ev" ] && [ "$RB_VERSION" != "$ev" ]; then RB_RESULT="diag says agent $RB_VERSION, expected $ev"; return 1; fi
  if [ -n "$ec" ] && [ "$RB_COMMIT" != "$ec" ]; then RB_RESULT="diag says commit $RB_COMMIT, expected $ec"; return 1; fi
  ok "readback: diag agent $RB_VERSION${ec:+, commit $RB_COMMIT}"
  n_new=0; n_old=0
  for p in $(agent_pids); do
    cwd="$(cwd_of "$p")"
    if [ "$cwd" = "$ed" ]; then n_new=$((n_new + 1)); elif [ -n "$od" ] && [ "$cwd" = "$od" ]; then n_old=$((n_old + 1)); fi
  done
  [ "$n_new" = 1 ] || { RB_RESULT="$n_new agent process(es) running in $ed (expected exactly 1)"; return 1; }
  [ "$n_old" = 0 ] || { RB_RESULT="$n_old agent process(es) still running in $od"; return 1; }
  ok "readback: exactly one agent process, cwd $ed"
  RB_PID="$(launchd_pid com.es.mini-agent)"
  [[ "$RB_PID" =~ ^[0-9]+$ ]] || { RB_RESULT="launchctl list does not show com.es.mini-agent running"; return 1; }
  if [ -f "$OBS_PL" ]; then
    if launchctl list 2>/dev/null | awk -F'\t' '$3=="com.es.obs-launcher"{f=1} END{exit f?0:1}'; then ok "readback: launchd jobs com.es.mini-agent (pid $RB_PID) and com.es.obs-launcher"; else warn "com.es.obs-launcher plist exists but the job is not loaded"; fi
  else
    ok "readback: launchd job com.es.mini-agent (pid $RB_PID); OBS launcher not installed"
  fi
  info "readback: watching for ${SETTLE_S}s (crash loop check)"
  sleep "$SETTLE_S"
  h="$(agent_health)" && [ "$(printf '%s' "$h" | json_get ok)" = "true" ] || { RB_RESULT="agent stopped answering after start (crash loop?)"; return 1; }
  pid2="$(launchd_pid com.es.mini-agent)"
  [ "$pid2" = "$RB_PID" ] || { RB_RESULT="agent pid changed $RB_PID -> $pid2 (crash loop)"; return 1; }
  if [ "$logs" = 0 ]; then ok "readback: alive and stable (log checks skipped)"; return 0; fi
  outlog="$ed/agent.log"; errlog="$ed/agent.error.log"
  tail_out="$( [ -f "$outlog" ] && tail -c +"$((ooff + 1))" "$outlog" || true)"
  tail_err="$( [ -f "$errlog" ] && tail -c +"$((eoff + 1))" "$errlog" || true)"
  case "$tail_err" in
    *"Cannot find module"*|*SyntaxError*|*ReferenceError*) RB_RESULT="agent.error.log shows a startup error"; return 1 ;;
  esac
  case "$tail_out" in *"relay: polling"*) ;; *) RB_RESULT="agent.log has no 'relay: polling' start line"; return 1 ;; esac
  case "$tail_out$tail_err" in
    *"relay: poll GET 401"*|*"relay: poll GET 403"*) RB_RESULT="relay poll refused (401/403): RECORD_CONTROL_KEY or BUILDING_ID wrong"; return 1 ;;
    *"relay: poll GET "*|*"relay: poll error"*) warn "relay poll had a network/server error since start; check the app shows the Mini online" ;;
  esac
  ok "readback: relay polling, no crash, no startup errors"
  return 0
}

# ---------- swap helpers ----------
install_plist() {   # $1 = candidate plist
  mkdir -p "$LAUNCH_AGENTS_DIR"
  cp "$1" "$PL.es-new.$$"; chmod 600 "$PL.es-new.$$"; mv -f "$PL.es-new.$$" "$PL"; chmod 600 "$PL"
}
reload_agent() {
  if [ -f "$PL" ]; then launchctl unload "$PL" >/dev/null 2>&1 || true; fi
}

# ---------- rollback ----------
newest_backup() {
  local d best=""
  [ -d "$BACKUPS" ] || return 1
  for d in "$BACKUPS"/mini-*; do
    [ -f "$d/com.es.mini-agent.plist" ] && best="$d"
  done
  [ -n "$best" ] && printf '%s' "$best"
}
manifest_get() { [ -f "$1/MANIFEST.txt" ] && sed -n "s/^$2=//p" "$1/MANIFEST.txt" | head -1 || true; }

do_rollback() {   # $1 backup dir, $2 = "auto" when called after a failed install
  local bk="$1" mode="${2:-manual}" ev ed ooff eoff other
  [ -f "$bk/com.es.mini-agent.plist" ] || die "rollback: $bk has no com.es.mini-agent.plist"
  (cd "$bk" && shasum -a 256 -c plists.sha256 >/dev/null 2>&1) || die "rollback: backup plists in $bk fail their checksum; not using them."
  ed="$("$PB" -c 'Print :WorkingDirectory' "$bk/com.es.mini-agent.plist" 2>/dev/null || true)"
  ev="$(manifest_get "$bk" from_version)"
  other="$("$PB" -c 'Print :WorkingDirectory' "$PL" 2>/dev/null || true)"; [ "$other" != "$ed" ] || other=""
  PORT="$("$PB" -c 'Print :EnvironmentVariables:PORT' "$bk/com.es.mini-agent.plist" 2>/dev/null || echo 8787)"
  RCK="$("$PB" -c 'Print :EnvironmentVariables:RECORD_CONTROL_KEY' "$bk/com.es.mini-agent.plist" 2>/dev/null || true)"
  if [ "$mode" = manual ]; then
    AGENT_DOWN_OK=1
    if [ -f "$PL" ]; then
      PORT="$("$PB" -c 'Print :EnvironmentVariables:PORT' "$PL" 2>/dev/null || echo 8787)"
      RCK="$("$PB" -c 'Print :EnvironmentVariables:RECORD_CONTROL_KEY' "$PL" 2>/dev/null || true)"
    fi
    guard_busy "rollback"
    if [ "$YES" = 0 ]; then confirm "Restore the plist from $bk and restart the agent from $ed?"; fi
    PORT="$("$PB" -c 'Print :EnvironmentVariables:PORT' "$bk/com.es.mini-agent.plist" 2>/dev/null || echo 8787)"
    RCK="$("$PB" -c 'Print :EnvironmentVariables:RECORD_CONTROL_KEY' "$bk/com.es.mini-agent.plist" 2>/dev/null || true)"
  fi
  info "rollback: restoring $bk/com.es.mini-agent.plist"
  ooff=0; eoff=0   # old folder may be unreadable (TCC); offsets only matter when readable
  [ -r "$ed/agent.log" ] && ooff="$(size_of "$ed/agent.log")"
  [ -r "$ed/agent.error.log" ] && eoff="$(size_of "$ed/agent.error.log")"
  reload_agent
  cp -p "$bk/com.es.mini-agent.plist" "$PL"; chmod 600 "$PL"
  if [ -f "$bk/com.es.obs-launcher.plist" ] && ! cmp -s "$bk/com.es.obs-launcher.plist" "$OBS_PL"; then
    launchctl unload "$OBS_PL" >/dev/null 2>&1 || true
    cp -p "$bk/com.es.obs-launcher.plist" "$OBS_PL"
    [ -f "$bk/obs-launcher.sh" ] && cp -p "$bk/obs-launcher.sh" "$APP_SUPPORT/obs-launcher.sh"
    launchctl load "$OBS_PL" || warn "could not reload com.es.obs-launcher"
  fi
  launchctl load "$PL" || { err "rollback: launchctl load failed"; return 1; }
  if [ ! -r "$ed" ] || ! ls "$ed" >/dev/null 2>&1; then
    # Old folder under ~/Documents over SSH: logs unreadable, so check health/version/cwd only.
    # Old folder under ~/Documents over SSH: its logs are unreadable, so skip the log checks.
    if readback "$ev" "$ed" "" 0 0 0 "$other"; then ok "rollback: agent back on ${RB_VERSION} in $ed"; return 0; fi
    err "rollback readback: $RB_RESULT"; return 1
  fi
  if readback "$ev" "$ed" "" "$ooff" "$eoff" 1 "$other"; then ok "rollback: agent back on ${RB_VERSION} in $ed"; return 0; fi
  err "rollback readback: $RB_RESULT"; return 1
}
confirm() {
  local ans=""
  [ -r /dev/tty ] || die "No terminal to confirm in. Run it in Terminal, or add --yes."
  printf '\n%s%s%s Type yes and press Return: ' "$BOLD" "$1" "$RST" > /dev/tty
  IFS= read -r ans < /dev/tty || true
  [ "$ans" = "yes" ] || die "not confirmed (you typed something other than yes)."
}

if [ "$ROLLBACK" = 1 ]; then
  if [ -n "$ROLLBACK_DIR" ]; then BK_RB="$ROLLBACK_DIR"; else BK_RB="$(newest_backup || true)"; fi
  [ -n "$BK_RB" ] && [ -d "$BK_RB" ] || die "rollback: no backup found under $BACKUPS"
  NODE_BIN="$(find_node "$("$PB" -c 'Print :ProgramArguments:0' "$BK_RB/com.es.mini-agent.plist" 2>/dev/null || true)" || true)"
  [ -n "$NODE_BIN" ] || die "rollback: Node 22+ not found (needed only to read the agent's answers)"
  if do_rollback "$BK_RB" manual; then
    cat <<EOF

${GRN}${BOLD}ROLLED BACK${RST}
===== ES MINI ROLLBACK REPORT =====
result: ROLLED BACK
agent: ${RB_VERSION}
folder: $("$PB" -c 'Print :WorkingDirectory' "$PL")
pid: ${RB_PID}
restored from: ${BK_RB}
time (UTC): ${TS}
===================================
EOF
    exit 0
  fi
  die "rollback did not read back cleanly. Do not retry; send Anna this whole window."
fi

# ---------- inputs ----------
V="${ES_MINI_VERSION:-}"; C="${ES_MINI_COMMIT:-}"; TAR_SHA="${ES_MINI_TAR_SHA256:-}"
LOCAL_TAR="${ES_MINI_TAR:-}"; LOCAL_SUMS="${ES_MINI_SUMS:-}"

if [ "$LOCAL" = 1 ]; then
  [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/scripts/build-mini-package.sh" ] && git -C "$SCRIPT_DIR" rev-parse --git-dir >/dev/null 2>&1 \
    || die "--local runs only from inside an es-mini-agent git checkout"
  warn "--local is for Anna's bench only: it installs this checkout's committed HEAD, pinned to itself"
  [ -z "$(git -C "$SCRIPT_DIR" status --porcelain --untracked-files=no)" ] || warn "the checkout has uncommitted changes; they are NOT installed (HEAD only)"
  LC="$(git -C "$SCRIPT_DIR" rev-parse HEAD)"
  LV="$(git -C "$SCRIPT_DIR" show HEAD:package.json | sed -n 's/.*"version": "\(.*\)".*/\1/p')"
  [ -z "$V" ] || [ "$V" = "$LV" ] || die "--local: ES_MINI_VERSION=$V but HEAD is $LV"
  V="$LV"; C="$LC"
  /bin/bash "$SCRIPT_DIR/scripts/build-mini-package.sh" "$SCRIPT_DIR" "$WORK/pkg" "$C" "$V" >/dev/null \
    || die "--local: package build failed"
  LOCAL_TAR="$WORK/pkg/es-mini-agent-$V-$(printf '%s' "$C" | cut -c1-7).tar"
  LOCAL_SUMS="$WORK/pkg/SHA256SUMS-files-$V.txt"
  LSHA="$(shasum -a 256 "$LOCAL_TAR" | cut -d' ' -f1)"
  [ -z "$TAR_SHA" ] || [ "$TAR_SHA" = "$LSHA" ] || die "--local: ES_MINI_TAR_SHA256 does not match the HEAD package"
  TAR_SHA="$LSHA"
fi

[ -n "$V" ] || die "ES_MINI_VERSION is required (Anna sends the exact command)."
[ -n "$C" ] || die "ES_MINI_COMMIT is required (Anna sends the exact command)."
[ -n "$TAR_SHA" ] || die "ES_MINI_TAR_SHA256 is required (Anna sends the exact command)."
[[ "$V" =~ ^[0-9A-Za-z][0-9A-Za-z.-]*$ ]] || die "ES_MINI_VERSION looks wrong: $V"
[[ "$C" =~ ^[0-9a-f]{7,40}$ ]] || die "ES_MINI_COMMIT must be 7-40 lower-case hex"
[[ "$TAR_SHA" =~ ^[0-9a-f]{64}$ ]] || die "ES_MINI_TAR_SHA256 must be 64 lower-case hex"
C7="$(printf '%s' "$C" | cut -c1-7)"
TOP="es-mini-agent-$V-$C7"
TAR_NAME="$TOP.tar"
SUMS_NAME="SHA256SUMS-files-$V.txt"
NEW="$RUNTIMES/$V-$C7"
RELEASE_URL="${ES_MINI_RELEASE_URL:-https://github.com/annabuies/es-mini-agent/releases/download/v$V/}"
case "$RELEASE_URL" in */) ;; *) RELEASE_URL="$RELEASE_URL/" ;; esac
case "$RELEASE_URL" in
  *raw.githubusercontent.com*|*/main/*|*/heads/*) die "ES_MINI_RELEASE_URL must be a release, never a branch: $RELEASE_URL" ;;
esac

# ---------- config file (read literally; never sourced, never printed) ----------
if [ -n "${ES_MINI_CONFIG:-}" ]; then
  [ -f "$ES_MINI_CONFIG" ] || die "ES_MINI_CONFIG file not found: $ES_MINI_CONFIG"
  mode="$(stat -f %Lp "$ES_MINI_CONFIG")"
  case "$mode" in 600|400) ;; *) die "ES_MINI_CONFIG must be mode 600 (it holds secrets). Run: chmod 600 \"$ES_MINI_CONFIG\"" ;; esac
  CFG_LINES=""; CFG_NAMES=""
  LN=0
  while IFS= read -r line || [ -n "$line" ]; do
    LN=$((LN + 1))
    line="${line%"$CR"}"
    case "$line" in ''|'#'*) continue ;; esac
    line="${line#export }"
    k="${line%%=*}"; val="${line#*=}"
    [ "$k" != "$line" ] || die "ES_MINI_CONFIG line $LN has no '=' (contents not shown)"
    [[ "$k" =~ ^[A-Z_][A-Z0-9_]*$ ]] || die "ES_MINI_CONFIG line $LN: the key name is not UPPER_CASE (contents not shown)"
    case "$val" in \"*\") val="${val#\"}"; val="${val%\"}" ;; \'*\') val="${val#\'}"; val="${val%\'}" ;; esac
    CFG_LINES="${CFG_LINES}$k=$val"$'\n'; CFG_NAMES="$CFG_NAMES $k"
  done < "$ES_MINI_CONFIG"
  # --set wins over the file: file first, flags after.
  SET_LINES="${CFG_LINES}${SET_LINES}"; SET_NAMES="${CFG_NAMES}${SET_NAMES}"
fi
printf '%s' "$SET_LINES" > "$WORK/sets.txt"; chmod 600 "$WORK/sets.txt"

# ---------- read the live install ----------
FRESH=1; LIVE=""; PLIST_NODE=""
if [ -f "$PL" ]; then
  FRESH=0
  plutil -convert json -o "$WORK/old.json" "$PL" 2>/dev/null || die "the live plist cannot be read as a property list: $PL"
  chmod 600 "$WORK/old.json"
fi
# node is needed for JSON, so preflight (which finds node) comes first.
[ "$FRESH" = 1 ] || PLIST_NODE="$("$PB" -c 'Print :ProgramArguments:0' "$PL" 2>/dev/null || true)"
preflight "$PLIST_NODE"
if [ "$FRESH" = 0 ]; then
  LIVE="$("$NODE_BIN" -e "$JS_TOPGET" "$WORK/old.json" WorkingDirectory)"
  PORT="$("$NODE_BIN" -e "$JS_ENVGET" "$WORK/old.json" PORT)"
  RCK="$("$NODE_BIN" -e "$JS_ENVGET" "$WORK/old.json" RECORD_CONTROL_KEY)"
  OLD_NAMES="$("$NODE_BIN" -e "$JS_NAMES" "$WORK/old.json")"
  info "live install: $LIVE"
  info "live plist env keys ($(printf '%s' "$OLD_NAMES" | wc -w | tr -d ' ')): $OLD_NAMES"
else
  info "no LaunchAgent plist: fresh install"
  OLD_NAMES=""
fi
# PORT for a fresh install comes from the config / --set lines.
if [ -z "$PORT" ]; then PORT="$(printf '%s' "$SET_LINES" | sed -n 's/^PORT=//p' | tail -1)"; fi
[ -n "$PORT" ] || PORT=8787
[[ "$PORT" =~ ^[0-9]+$ ]] || die "PORT is not a number"
if [ "$FRESH" = 1 ] && [ -z "$RCK" ]; then RCK="$(printf '%s' "$SET_LINES" | sed -n 's/^RECORD_CONTROL_KEY=//p' | tail -1)"; fi

# ---------- idempotent: same version already running ----------
FROM_VERSION=""; FROM_COMMIT=""
if [ "$FRESH" = 0 ] && H0="$(agent_health)"; then
  if D0="$(agent_post diag 30)"; then
    FROM_VERSION="$(printf '%s' "$D0" | json_get version.agent)"
    FROM_COMMIT="$(printf '%s' "$D0" | json_get version.commit)"
    info "running now: agent $FROM_VERSION"
  fi
fi
if [ "$LIVE" = "$NEW" ] && [ "$FROM_VERSION" = "$V" ] && [ -z "$SET_LINES" ] && [ "$INSTALL_OBS_LAUNCHER" = 0 ]; then
  info "agent $V from $NEW is already running: reading back, changing nothing"
  if readback "$V" "$NEW" "" 0 0 0 ""; then
    cat <<EOF

${GRN}${BOLD}ALREADY INSTALLED: nothing changed${RST}
===== ES MINI INSTALL REPORT =====
result: ALREADY INSTALLED (no change)
agent: $RB_VERSION  commit: $RB_COMMIT
folder: $NEW
pid: $RB_PID
env keys ($(printf '%s' "$OLD_NAMES" | wc -w | tr -d ' ')): $OLD_NAMES
time (UTC): $TS
==================================
EOF
    exit 0
  fi
  die "agent $V is configured but did not read back: $RB_RESULT"
fi

# ---------- busy guard ----------
guard_busy "start"

# ---------- fetch + verify ----------
info "package: $TAR_NAME (sha256 $TAR_SHA)"
if [ -n "$LOCAL_TAR" ]; then
  [ -f "$LOCAL_TAR" ] || die "ES_MINI_TAR not found: $LOCAL_TAR"
  cp "$LOCAL_TAR" "$WORK/$TAR_NAME"
  [ -n "$LOCAL_SUMS" ] || LOCAL_SUMS="$(dirname "$LOCAL_TAR")/$SUMS_NAME"
  [ -f "$LOCAL_SUMS" ] || die "per-file sums not found: $LOCAL_SUMS"
  cp "$LOCAL_SUMS" "$WORK/$SUMS_NAME"
else
  info "downloading from $RELEASE_URL"
  curl -fsSL --retry 2 -o "$WORK/$TAR_NAME" "$RELEASE_URL$TAR_NAME" || die "download failed: $RELEASE_URL$TAR_NAME"
  curl -fsSL --retry 2 -o "$WORK/$SUMS_NAME" "$RELEASE_URL$SUMS_NAME" || die "download failed: $RELEASE_URL$SUMS_NAME"
fi
GOT_SHA="$(shasum -a 256 "$WORK/$TAR_NAME" | cut -d' ' -f1)"
[ "$GOT_SHA" = "$TAR_SHA" ] || die "package SHA-256 MISMATCH: expected $TAR_SHA, got $GOT_SHA. Do not continue; tell Anna."
ok "package SHA-256 matches"

ENTRIES="$(tar -tf "$WORK/$TAR_NAME")" || die "the package is not a readable tar"
while IFS= read -r e; do
  case "$e" in
    "$TOP"/*) ;;
    *) die "package entry outside $TOP/: $e" ;;
  esac
  case "/$e/" in */../*) die "package entry with '..': $e" ;; esac
done <<EOF
$ENTRIES
EOF
mkdir "$WORK/x"
tar -xf "$WORK/$TAR_NAME" -C "$WORK/x"
STAGE="$WORK/x/$TOP"
[ -f "$STAGE/server.js" ] || die "package has no $TOP/server.js"
N_SUMS="$(grep -c . "$WORK/$SUMS_NAME" || true)"
N_FILES="$(cd "$STAGE" && find . -type f | wc -l | tr -d ' ')"
[ "$N_SUMS" = "$N_FILES" ] || die "package has $N_FILES files but $SUMS_NAME lists $N_SUMS"
(cd "$STAGE" && shasum -a 256 -c "$WORK/$SUMS_NAME" > "$WORK/sums.out" 2>&1) || { grep -v ': OK$' "$WORK/sums.out" >&2 || true; die "a file in the package does not match $SUMS_NAME"; }
ok "all $N_FILES files match $SUMS_NAME"

MODULES=""
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%%#*}"; line="$(printf '%s' "$line" | tr -d ' \t\r')"
  [ -n "$line" ] && MODULES="$MODULES $line"
done < "$STAGE/modules.txt"
[ -n "$MODULES" ] || die "modules.txt in the package is empty"
for m in $MODULES; do
  [ -f "$STAGE/$m" ] || die "module $m listed in modules.txt is missing"
  "$NODE_BIN" --check "$STAGE/$m" 2>"$WORK/check.err" || { cat "$WORK/check.err" >&2; die "node --check failed for $m"; }
done
ok "node --check passed for $(printf '%s' "$MODULES" | wc -w | tr -d ' ') modules"
grep -F "const AGENT_VERSION = '$V';" "$STAGE/server.js" >/dev/null || die "server.js in the package is not version $V"
ok "server.js declares AGENT_VERSION '$V'"

# ---------- plan the new plist ----------
OLD_JSON="-"; [ "$FRESH" = 1 ] || OLD_JSON="$WORK/old.json"
if [ "$FRESH" = 1 ]; then
  # A fresh Mini gets the same defaults install.sh v1 wrote; the config file overrides them.
  {
    echo "PORT=8787"
    echo "RECORD_POLL_URL=https://api.evrybdystudios.com"
    echo "OBS_WS_URL=ws://127.0.0.1:4455"
    [ -z "${FFMPEG_FOUND:-}" ] || echo "FFMPEG_BIN=$FFMPEG_FOUND"
    cat "$WORK/sets.txt"
  } > "$WORK/sets-fresh.txt"
  SETS_FILE="$WORK/sets-fresh.txt"
else
  SETS_FILE="$WORK/sets.txt"
fi
NEW_WD="$NEW" NEW_NODE="$NODE_BIN" "$NODE_BIN" -e "$JS_MERGE" "$OLD_JSON" "$SETS_FILE" "$WORK/new.json" || die "could not build the new plist"
plutil -convert xml1 -o "$WORK/new.plist" "$WORK/new.json" || die "plutil could not write the new plist"
chmod 600 "$WORK/new.plist"
plutil -lint "$WORK/new.plist" >/dev/null || die "the new plist does not pass plutil -lint"
NEW_NAMES="$("$NODE_BIN" -e "$JS_NAMES" "$WORK/new.json")"
for k in BUILDING_ID RECORD_CONTROL_KEY; do
  [ -n "$("$NODE_BIN" -e "$JS_ENVGET" "$WORK/new.json" "$k")" ] || die "$k is empty in the new plist (a fresh Mini needs it in ES_MINI_CONFIG)"
done

ENV_CHANGED=""; TOP_CHANGED=""
if [ "$FRESH" = 0 ]; then
  DIFF="$("$NODE_BIN" -e "$JS_DIFF" "$WORK/old.json" "$WORK/new.json")"
  while IFS= read -r dl; do
    [ -n "$dl" ] || continue
    kind="${dl%% *}"; name="${dl#* }"
    case "$kind" in
      env-removed) die "internal check: the new plist would DROP key $name. Not continuing." ;;
      env-changed|env-added)
        case " $SET_NAMES " in *" $name "*) ENV_CHANGED="$ENV_CHANGED $name" ;; *) die "internal check: key $name would change without being set. Not continuing." ;; esac ;;
      top-changed)
        case "$name" in WorkingDirectory|StandardOutPath|StandardErrorPath|ProgramArguments) TOP_CHANGED="$TOP_CHANGED $name" ;; *) die "internal check: plist field $name would change. Not continuing." ;; esac ;;
    esac
  done <<EOF
$DIFF
EOF
  ok "new plist keeps all $(printf '%s' "$OLD_NAMES" | wc -w | tr -d ' ') env keys"
  info "plist fields changed:${TOP_CHANGED:- none}"
  info "env keys changed (names only):${ENV_CHANGED:- none}"
else
  info "new plist env keys ($(printf '%s' "$NEW_NAMES" | wc -w | tr -d ' ')): $NEW_NAMES"
fi

cat <<EOF

${BOLD}Plan${RST}
  install : agent $V (commit $C7) into $NEW
  from    : ${FROM_VERSION:-nothing running} ${LIVE:+at $LIVE}
  backup  : $BACKUPS/mini-$TS
  old folder is left untouched; rollback = /bin/bash install.sh --rollback
EOF

if [ "$DRY_RUN" = 1 ]; then
  printf '\n%sDRY RUN: nothing was written or restarted.%s\n' "$BOLD" "$RST"
  exit 0
fi
[ "$YES" = 1 ] || confirm "Install agent $V now?"

# ---------- backup ----------
BK="$BACKUPS/mini-$TS"
mkdir -p "$BACKUPS"; chmod 700 "$BACKUPS"
mkdir "$BK" || die "backup folder already exists: $BK"
chmod 700 "$BK"
RUNTIME_BACKUP="none (fresh install)"; OBS_BACKUP="none"
if [ "$FRESH" = 0 ]; then
  cp -p "$PL" "$BK/com.es.mini-agent.plist"
  ( cd "$LAUNCH_AGENTS_DIR" && shasum -a 256 com.es.mini-agent.plist ) > "$BK/plists.sha256"
  if [ -f "$OBS_PL" ]; then
    cp -p "$OBS_PL" "$BK/com.es.obs-launcher.plist"
    ( cd "$LAUNCH_AGENTS_DIR" && shasum -a 256 com.es.obs-launcher.plist ) >> "$BK/plists.sha256"
  fi
  [ -f "$APP_SUPPORT/obs-launcher.sh" ] && cp -p "$APP_SUPPORT/obs-launcher.sh" "$BK/obs-launcher.sh"
  (cd "$BK" && shasum -a 256 -c plists.sha256 >/dev/null) || die "backup plist copy does not match the original"
  if [ -n "$LIVE" ] && [ -d "$LIVE" ] && ls "$LIVE" >/dev/null 2>&1; then
    (cd "$LIVE" && find . -type f ! -name '*.log' ! -path './.r2-test-tmp/*' -exec shasum -a 256 {} + | sort -k2) > "$BK/live.sha256" \
      || die "could not hash the old runtime folder"
    cp -Rp "$LIVE" "$BK/runtime" || die "could not copy the old runtime folder"
    (cd "$BK/runtime" && shasum -a 256 -c "$BK/live.sha256" >/dev/null) || die "backup of the old runtime folder does not verify"
    RUNTIME_BACKUP="copied and verified ($(grep -c . "$BK/live.sha256" || true) files; logs copied, not hashed)"
  else
    RUNTIME_BACKUP="old runtime folder not readable (macOS privacy; run in Terminal on the Mini for a full backup)"
    warn "$RUNTIME_BACKUP"
  fi
  if [ -d "$OBS_SETTINGS" ] && ls "$OBS_SETTINGS" >/dev/null 2>&1; then
    (cd "$OBS_SETTINGS" && find . -type f ! -path './logs/*' ! -path './crashes/*' ! -path './.sentinel/*' ! -path './profiler_data/*' -exec shasum -a 256 {} + | sort -k2) > "$BK/obs-studio.sha256" \
      && cp -Rp "$OBS_SETTINGS" "$BK/obs-studio" \
      && (cd "$BK/obs-studio" && shasum -a 256 -c "$BK/obs-studio.sha256" >/dev/null) \
      && OBS_BACKUP="copied and verified" || { OBS_BACKUP="copy failed"; warn "OBS settings backup did not verify (OBS may be saving); the install continues, OBS settings are not changed by it"; }
  else
    OBS_BACKUP="not present or not readable"
  fi
fi
if [ -n "$SELF" ] && [ -f "$SELF" ]; then cp -p "$SELF" "$BK/install.sh"; fi
{
  echo "created_utc=$TS"
  echo "installer=$INSTALLER_VERSION"
  echo "from_version=$FROM_VERSION"
  echo "from_dir=$LIVE"
  echo "to_version=$V"
  echo "to_commit=$C"
  echo "to_dir=$NEW"
  echo "tar_sha256=$TAR_SHA"
  echo "runtime_backup=$RUNTIME_BACKUP"
  echo "obs_backup=$OBS_BACKUP"
} > "$BK/MANIFEST.txt"
ok "BACKUP-VERIFIED: $BK"

# ---------- place the new runtime ----------
mkdir -p "$RUNTIMES"; chmod 700 "$RUNTIMES"
if [ "$LIVE" = "$NEW" ]; then
  # Same version, settings change: the folder is live; check it in place, do not replace it.
  (cd "$NEW" && shasum -a 256 -c "$WORK/$SUMS_NAME" >/dev/null) || die "the running folder $NEW no longer matches the package"
  ok "running folder $NEW still matches the package"
else
  if [ -e "$NEW" ]; then
    mv "$NEW" "$NEW.set-aside-$TS"
    warn "an earlier $NEW was set aside as $NEW.set-aside-$TS (not deleted)"
  fi
  mv "$STAGE" "$NEW"
  if [ -n "$LIVE" ] && [ -f "$LIVE/.cam-golden.json" ]; then
    cp -p "$LIVE/.cam-golden.json" "$NEW/" && ok "carried over .cam-golden.json"
  elif [ -n "$LIVE" ] && ! ls "$LIVE" >/dev/null 2>&1; then
    warn ".cam-golden.json not carried over (old folder not readable); take a new camera baseline in the app"
  fi
  NEW_COMMIT="$C" PREV_COMMIT="$FROM_COMMIT" NEW_VERSION="$V" OUT="$NEW/update-state.json" "$NODE_BIN" -e '
    const e=process.env;const prev=(e.PREV_COMMIT&&e.PREV_COMMIT!=="null"&&!e.PREV_COMMIT.startsWith("__"))?e.PREV_COMMIT:null;
    require("fs").writeFileSync(e.OUT,JSON.stringify({commit:e.NEW_COMMIT,previousCommit:prev,updatedAt:new Date().toISOString(),version:e.NEW_VERSION,installedBy:"install.sh"},null,2)+"\n");'
fi
OUT_OFF="$(size_of "$NEW/agent.log")"; ERR_OFF="$(size_of "$NEW/agent.error.log")"
cp -p "$WORK/new.plist" "$BK/com.es.mini-agent.new.plist"

# ---------- optional OBS login launcher ----------
install_obs_launcher() {
  local PROJECT_DIR="$1"
  local OBS_LAUNCHER_TEMPLATE="$PROJECT_DIR/com.es.obs-launcher.plist"
  local OBS_LAUNCHER_SCRIPT="$PROJECT_DIR/obs-launcher.sh"
  local OBS_LAUNCHER_PLIST="$LAUNCH_AGENTS_DIR/com.es.obs-launcher.plist"
  if [ ! -f "$OBS_LAUNCHER_TEMPLATE" ] || [ ! -f "$OBS_LAUNCHER_SCRIPT" ]; then
    err "OBS launcher files are missing from $PROJECT_DIR"; return 1
  fi
  # launchd starts the launcher with /bin/bash, and macOS folder privacy blocks
  # bash (unlike node) from reading anything under ~/Documents: the job exits 126
  # with "Operation not permitted". Run a copy from Application Support instead.
  local OBS_LAUNCHER_DIR="$APP_SUPPORT"
  mkdir -p "$OBS_LAUNCHER_DIR"
  install -m 755 "$OBS_LAUNCHER_SCRIPT" "$OBS_LAUNCHER_DIR/obs-launcher.sh"
  local OBS_LAUNCHER_DIR_X OBS_LAUNCHER_DIR_SED TMP_OBS_PLIST
  OBS_LAUNCHER_DIR_X="$(xml_escape "$OBS_LAUNCHER_DIR")"
  OBS_LAUNCHER_DIR_SED="${OBS_LAUNCHER_DIR_X//\\/\\\\}"
  OBS_LAUNCHER_DIR_SED="${OBS_LAUNCHER_DIR_SED//&/\\&}"
  OBS_LAUNCHER_DIR_SED="${OBS_LAUNCHER_DIR_SED//|/\\|}"
  TMP_OBS_PLIST="$(mktemp "$WORK/es-obs-launcher.plist.XXXXXX")"
  sed "s|__LAUNCHER_DIR__|${OBS_LAUNCHER_DIR_SED}|g" "$OBS_LAUNCHER_TEMPLATE" > "$TMP_OBS_PLIST"
  chmod 644 "$TMP_OBS_PLIST"
  mv "$TMP_OBS_PLIST" "$OBS_LAUNCHER_PLIST"
  chmod 644 "$OBS_LAUNCHER_PLIST"
  launchctl unload "$OBS_LAUNCHER_PLIST" >/dev/null 2>&1 || true
  launchctl load "$OBS_LAUNCHER_PLIST" || { err "launchctl load failed for $OBS_LAUNCHER_PLIST"; return 1; }
  ok "launchd loaded com.es.obs-launcher (script in $OBS_LAUNCHER_DIR)"
  # A power cut never shows "Reopen windows when logging back in", so macOS
  # relaunched OBS itself before this launcher ran (Robbie, 10-02). Turn session
  # restore off for this user so the launcher is the only thing that starts OBS.
  if defaults write com.apple.loginwindow TALLogoutSavesState -bool false \
    && defaults write com.apple.loginwindow LoginwindowLaunchesRelaunchApps -bool false; then
    ok "macOS session restore off: apps are not reopened at login, the launcher starts OBS"
  else
    warn "Could not turn off macOS session restore; after a power cut OBS may reopen into Safe Mode."
  fi
  # macOS rebuilt the per-host list after it was cleared (10-05 power test); clearing
  # it may help at the next login, but obs-launcher.sh must still recover a reopened OBS.
  if defaults -currentHost read com.apple.loginwindow TALAppsToRelaunchAtLogin >/dev/null 2>&1; then
    defaults -currentHost delete com.apple.loginwindow TALAppsToRelaunchAtLogin >/dev/null 2>&1 \
      && ok "Cleared the macOS list of apps to reopen at login" \
      || warn "Could not clear the macOS list of apps to reopen at login."
  fi
  warn "Remove OBS from System Settings > General > Login Items to avoid duplicate launches."
}
xml_escape() {
  local s="$1"
  s="${s//&/&amp;}"; s="${s//</&lt;}"; s="${s//>/&gt;}"; s="${s//\"/&quot;}"; s="${s//\'/&apos;}"
  printf '%s' "$s"
}
# ---------- end OBS login launcher ----------

# ---------- swap ----------
guard_busy "before swap"
info "swapping: launchctl unload, new plist, launchctl load"
reload_agent
install_plist "$WORK/new.plist"
SWAP_OK=1
launchctl load "$PL" || SWAP_OK=0
if [ "$SWAP_OK" = 1 ] && [ "$INSTALL_OBS_LAUNCHER" = 1 ]; then install_obs_launcher "$NEW" || warn "OBS launcher was not installed"; fi

fail_and_rollback() {
  err "readback FAILED: $1"
  if [ "$FRESH" = 1 ]; then
    cat <<EOF >&2

${RED}${BOLD}FAILURE${RST}: fresh install did not read back ($1).
Nothing to roll back to. Logs: $NEW/agent.error.log. Send Anna this whole window.
EOF
    exit 1
  fi
  info "rolling back automatically to $BK"
  if do_rollback "$BK" auto; then
    cat <<EOF >&2

${RED}${BOLD}FAILURE, ROLLED BACK${RST}: $1
The agent is back on ${RB_VERSION} in $(manifest_get "$BK" from_dir).
The new folder $NEW was kept for diagnosis. Send Anna this whole window.
EOF
  else
    err "automatic rollback did not read back: $RB_RESULT"
    err "Send Anna this whole window now. Backup: $BK"
  fi
  exit 1
}
[ "$SWAP_OK" = 1 ] || fail_and_rollback "launchctl load failed"
OTHER_DIR=""; [ "$LIVE" = "$NEW" ] || OTHER_DIR="$LIVE"
readback "$V" "$NEW" "$C" "$OUT_OFF" "$ERR_OFF" 1 "$OTHER_DIR" || fail_and_rollback "$RB_RESULT"

REPORT="$(cat <<EOF
===== ES MINI INSTALL REPORT =====
result: SUCCESS
installer: $INSTALLER_VERSION
agent: ${FROM_VERSION:-none} -> $RB_VERSION
commit: $RB_COMMIT
package sha256: $TAR_SHA
folder: $NEW
old folder (untouched): ${LIVE:-none}
pid: $RB_PID
node: $NODE_BIN $("$NODE_BIN" -v)
env keys ($(printf '%s' "$NEW_NAMES" | wc -w | tr -d ' ')): $NEW_NAMES
env keys changed:${ENV_CHANGED:- none}
plist fields changed:${TOP_CHANGED:- (fresh plist)}
backup: $BK
old runtime backup: $RUNTIME_BACKUP
OBS settings backup: $OBS_BACKUP
warnings: ${WARNINGS:-none}
rollback: /bin/bash "$BK/install.sh" --rollback "$BK"
time (UTC): $TS
==================================
EOF
)"
printf '%s\n' "$REPORT" > "$BK/REPORT.txt"
printf '\n%s%sSUCCESS: agent %s is running from %s%s\n%s\n\nSend Anna everything from ===== to =====.\n' "$GRN" "$BOLD" "$V" "$NEW" "$RST" "$REPORT"
