#!/bin/bash
# ES room preview relay installer (MediaMTX) for a room Mac mini.
#
# What it does: installs MediaMTX v1.21.3 as the per-user LaunchAgent
# com.es.preview-relay, using this repo's relay/mediamtx.yml and
# relay/com.es.preview-relay.plist, and the room's TLS certificate that Anna copied
# into ~/es-preview-certs-inbox/. It does NOT turn local preview on: that is the
# Worker flag LOCAL_PREVIEW_ROOMS, set by Anna. With the flag off nothing uses the
# relay, so installing it changes nothing for sessions.
#
# Run it in Terminal on the Mini, logged in as the room user, from a clone:
#   cd ~/code/es-mini-agent && /bin/bash scripts/install-preview-relay.sh
#
# Options:
#   --status      show what is installed and whether it answers (changes nothing)
#   --dry-run     check everything and stage the files in a temp folder, install nothing
#   --uninstall   stop the relay and move its files to ~/es-backups (nothing deleted)
#   --help        this text
#
# Inputs (environment, optional):
#   ES_RELAY_HOST   relay hostname   (default preview-bench1.evrybdystudios.com)
#   ES_RELAY_ROOM   room / building  (default bench-1)
#
# Steps: 1 preflight  2 certificate  3 download + SHA-256  4 stage  5 backup
#        6 install + start  7 readback (launchd, API, TLS, DNS)  8 report.
# A failed readback stops the new relay and puts the previous one back.
# Nothing here reads or prints a secret. bash 3.2 safe.
set -euo pipefail

INSTALLER_VERSION="2026.11.08-1"
RELAY_VERSION="v1.21.3"
TAR_NAME="mediamtx_${RELAY_VERSION}_darwin_arm64.tar.gz"
TAR_URL="https://github.com/bluenviron/mediamtx/releases/download/${RELAY_VERSION}/${TAR_NAME}"
TAR_SHA256="bc1a0762fd18ffb413bcd81dcb9a072ac159fbd1f27e79ac6f14598aaac5ed3f"
LABEL="com.es.preview-relay"

HOST="${ES_RELAY_HOST:-preview-bench1.evrybdystudios.com}"
ROOM="${ES_RELAY_ROOM:-bench-1}"
API_PORT=9997; WEBRTC_PORT=8889; ICE_PORT=8189
CACERT=""
# Test hooks: only honoured with ES_RELAY_TEST=1 (the test suite). Never set these on a Mini.
if [ "${ES_RELAY_TEST:-}" = "1" ]; then
  API_PORT="${ES_RELAY_API_PORT:-$API_PORT}"; WEBRTC_PORT="${ES_RELAY_WEBRTC_PORT:-$WEBRTC_PORT}"
  ICE_PORT="${ES_RELAY_ICE_PORT:-$ICE_PORT}"; CACERT="${ES_RELAY_CACERT:-}"
  [ -n "${ES_RELAY_TAR:-}" ] && TAR_URL="file://${ES_RELAY_TAR}"
  [ -n "${ES_RELAY_TAR_SHA:-}" ] && TAR_SHA256="$ES_RELAY_TAR_SHA"
fi
READBACK_TIMEOUT="${ES_RELAY_READBACK_TIMEOUT:-20}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
YML_SRC="$REPO_DIR/relay/mediamtx.yml"
PL_SRC="$REPO_DIR/relay/com.es.preview-relay.plist"
APP_DIR="$HOME/Library/Application Support/es-preview-relay"
PL="$HOME/Library/LaunchAgents/$LABEL.plist"
INBOX="$HOME/es-preview-certs-inbox"
LOG_FILE="$HOME/Library/Logs/es-preview-relay.log"
BK_ROOT="$HOME/es-backups"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
UIDN="$(id -u)"

if [ -t 1 ]; then RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; CYA=$'\033[36m'; BOLD=$'\033[1m'; RST=$'\033[0m'
else RED=""; GRN=""; YLW=""; CYA=""; BOLD=""; RST=""; fi
WARNINGS=""
info() { printf '%s[relay]%s %s\n' "$CYA" "$RST" "$*"; }
ok()   { printf '%s[ok]%s %s\n' "$GRN" "$RST" "$*"; }
warn() { printf '%s[warn]%s %s\n' "$YLW" "$RST" "$*"; WARNINGS="${WARNINGS}${WARNINGS:+; }$*"; }
err()  { printf '%s[error]%s %s\n' "$RED" "$RST" "$*" 1>&2; }
die()  { err "$*"; printf '\n%s%sSTOPPED: nothing was changed. Send Anna this whole window.%s\n' "$RED" "$BOLD" "$RST" 1>&2; exit 1; }
usage() { sed -n '2,29p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

MODE=install
for a in "$@"; do
  case "$a" in
    --status) MODE=status ;; --dry-run) MODE=dry ;; --uninstall) MODE=uninstall ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "unknown option: $a" ;;
  esac
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/es-relay.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# ---------- helpers ----------
listen_pid() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1 || true; }
udp_pid()    { lsof -nP -iUDP:"$1" -t 2>/dev/null | head -1 || true; }
job_pid() {
  launchctl print "gui/$UIDN/$LABEL" 2>/dev/null | awk -F'= ' '/^[[:space:]]*pid = /{print $2; exit}' | tr -d ' ' || true
}
job_loaded() { launchctl print "gui/$UIDN/$LABEL" >/dev/null 2>&1; }
api_get() { curl -fsS --max-time 3 "http://127.0.0.1:$API_PORT$1" 2>/dev/null; }
tls_probe() {   # prints the HTTP code (000 = TLS or connect failure)
  if [ -n "$CACERT" ]; then
    curl -s -o /dev/null -w '%{http_code}' --max-time 5 --cacert "$CACERT" --resolve "$HOST:$WEBRTC_PORT:127.0.0.1" "https://$HOST:$WEBRTC_PORT/" 2>/dev/null || true
  else
    curl -s -o /dev/null -w '%{http_code}' --max-time 5 --resolve "$HOST:$WEBRTC_PORT:127.0.0.1" "https://$HOST:$WEBRTC_PORT/" 2>/dev/null || true
  fi
}
cert_end()    { openssl x509 -in "$1" -noout -enddate 2>/dev/null | sed 's/^notAfter=//'; }
cert_issuer() { openssl x509 -in "$1" -noout -issuer 2>/dev/null | sed -E 's/^issuer= ?//'; }
resolve_host() { dscacheutil -q host -a name "$HOST" 2>/dev/null | awk '/^ip_address:/{print $2}' | head -1 || true; }
local_ips()    { ifconfig 2>/dev/null | awk '/inet /{print $2}' || true; }

# check_cert <crt> <key>: dies on a certificate the kiosk would refuse
check_cert() {
  local crt="$1" key="$2"
  [ -s "$crt" ] && [ -s "$key" ] || die "certificate: missing $crt or $key"
  openssl x509 -in "$crt" -noout >/dev/null 2>&1 || die "certificate: $crt is not a PEM certificate"
  openssl x509 -in "$crt" -noout -text 2>/dev/null | grep -F "DNS:$HOST" >/dev/null \
    || die "certificate: not issued for $HOST"
  openssl x509 -in "$crt" -noout -checkend 604800 >/dev/null 2>&1 \
    || die "certificate: expires within 7 days ($(cert_end "$crt")). Ask Anna for a renewed one."
  local a b
  a="$(openssl x509 -in "$crt" -noout -pubkey 2>/dev/null | shasum -a 256 | awk '{print $1}')"
  b="$(openssl pkey -in "$key" -pubout 2>/dev/null | shasum -a 256 | awk '{print $1}')"
  [ -n "$b" ] && [ "$a" = "$b" ] || die "certificate: the key does not belong to the certificate"
}

# ---------- status ----------
print_status() {
  local pid code ver ip crt="$APP_DIR/certs/certificates/$HOST.crt"
  echo "===== ES PREVIEW RELAY STATUS ====="
  if [ -f "$PL" ]; then echo "launchagent: $PL"; else echo "launchagent: not installed"; fi
  if job_loaded; then pid="$(job_pid)"; echo "launchd: loaded, pid ${pid:-none}"; else echo "launchd: not loaded"; fi
  ver="$(api_get /v3/info | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
  echo "api 127.0.0.1:$API_PORT: ${ver:-no answer}"
  if api_get "/v3/config/paths/get/$ROOM" >/dev/null; then echo "room path: $ROOM configured"; else echo "room path: $ROOM not answering"; fi
  code="$(tls_probe)"; if [ "$code" != "000" ] && [ -n "$code" ]; then echo "webrtc :$WEBRTC_PORT: TLS ok for $HOST (http $code)"; else echo "webrtc :$WEBRTC_PORT: no TLS answer for $HOST"; fi
  if [ -f "$crt" ]; then echo "certificate: expires $(cert_end "$crt")"; else echo "certificate: not installed"; fi
  ip="$(resolve_host)"; echo "dns: $HOST -> ${ip:-does not resolve}"
  echo "log: $LOG_FILE"
  echo "==================================="
}
if [ "$MODE" = status ]; then print_status; exit 0; fi

# ---------- uninstall ----------
if [ "$MODE" = uninstall ]; then
  BK="$BK_ROOT/preview-relay-$STAMP"
  mkdir -p "$BK"
  launchctl bootout "gui/$UIDN/$LABEL" >/dev/null 2>&1 || true
  [ -f "$PL" ] && mv "$PL" "$BK/"
  [ -d "$APP_DIR" ] && mv "$APP_DIR" "$BK/app"
  echo "===== ES PREVIEW RELAY UNINSTALL REPORT ====="
  echo "result: REMOVED (relay stopped; the kiosk uses the cloud preview)"
  echo "moved to: $BK"
  echo "time (UTC): $STAMP"
  echo "============================================="
  exit 0
fi

# ---------- 1. preflight ----------
info "ES preview relay installer $INSTALLER_VERSION, MediaMTX $RELAY_VERSION, room $ROOM, host $HOST"
[ "$(uname -s)" = Darwin ] || die "this is for macOS only"
[ "${ES_RELAY_TEST:-}" = "1" ] || [ "$(uname -m)" = arm64 ] || die "this Mini is not Apple silicon (arm64)"
[ "$UIDN" != 0 ] || die "do not run with sudo; run it as the room user"
[[ "$HOST" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || die "ES_RELAY_HOST is not a hostname"
[[ "$ROOM" =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "ES_RELAY_ROOM is not a room id"
for t in curl shasum tar openssl plutil lsof launchctl; do command -v "$t" >/dev/null 2>&1 || die "missing tool: $t"; done
[ -f "$YML_SRC" ] && [ -f "$PL_SRC" ] || die "run this from a clone of es-mini-agent (relay/ files not found)"
launchctl print "gui/$UIDN" >/dev/null 2>&1 || die "no logged-in desktop session for this user (log in on the Mini's screen, then run it in Terminal there)"
for p in "$API_PORT" "$WEBRTC_PORT"; do
  pid="$(listen_pid "$p")"
  if [ -n "$pid" ] && [ "$pid" != "$(job_pid)" ]; then die "port $p is already used by another program (pid $pid)"; fi
done
pid="$(udp_pid "$ICE_PORT")"
if [ -n "$pid" ] && [ "$pid" != "$(job_pid)" ]; then die "UDP port $ICE_PORT is already used by another program (pid $pid)"; fi
ok "preflight: macOS, room user $UIDN, desktop session, ports $API_PORT/$WEBRTC_PORT/$ICE_PORT free"

# ---------- 2. certificate ----------
CRT_SRC=""; KEY_SRC=""; CERT_FROM=""
if [ -f "$INBOX/$HOST.crt" ] || [ -f "$INBOX/$HOST.key" ]; then
  CRT_SRC="$INBOX/$HOST.crt"; KEY_SRC="$INBOX/$HOST.key"; CERT_FROM="inbox"
elif [ -f "$APP_DIR/certs/certificates/$HOST.crt" ]; then
  CRT_SRC="$APP_DIR/certs/certificates/$HOST.crt"; KEY_SRC="$APP_DIR/certs/certificates/$HOST.key"; CERT_FROM="installed"
else
  die "certificate: none found. Anna copies $HOST.crt and $HOST.key into $INBOX first."
fi
check_cert "$CRT_SRC" "$KEY_SRC"
ok "certificate ($CERT_FROM): $HOST, key matches, expires $(cert_end "$CRT_SRC")"

# ---------- 3. download + verify ----------
TAR="$WORK/$TAR_NAME"
info "downloading MediaMTX $RELAY_VERSION"
curl -fsSL --max-time 300 -o "$TAR" "$TAR_URL" || die "download failed: $TAR_URL"
GOT="$(shasum -a 256 "$TAR" | awk '{print $1}')"
[ "$GOT" = "$TAR_SHA256" ] || die "download SHA-256 mismatch (got $GOT, want $TAR_SHA256)"
LIST="$(tar -tzf "$TAR" 2>/dev/null)" || die "the download is not a readable tar.gz"
printf '%s\n' "$LIST" | grep -x 'mediamtx' >/dev/null || die "the tar has no top-level mediamtx binary"
mkdir -p "$WORK/x"
tar -xzf "$TAR" -C "$WORK/x" mediamtx || die "could not extract mediamtx"
[ -f "$WORK/x/mediamtx" ] && [ ! -L "$WORK/x/mediamtx" ] || die "extracted mediamtx is not a regular file"
ok "download: SHA-256 $GOT matches the pin"

# ---------- 4. stage ----------
NEW="$WORK/stage"
mkdir -p "$NEW/certs/certificates"
cp "$WORK/x/mediamtx" "$NEW/mediamtx"; chmod 755 "$NEW/mediamtx"
cp "$CRT_SRC" "$NEW/certs/certificates/$HOST.crt"; cp "$KEY_SRC" "$NEW/certs/certificates/$HOST.key"
chmod 700 "$NEW/certs" "$NEW/certs/certificates"; chmod 644 "$NEW/certs/certificates/$HOST.crt"; chmod 600 "$NEW/certs/certificates/$HOST.key"
# sed replacement: escape \ & and the # delimiter
sedq() { printf '%s' "$1" | sed -e 's/[\\&#]/\\&/g'; }
sed -e "s#__APP_DIR__#$(sedq "$APP_DIR")#g" -e "s#__ROOM_HOST__#$(sedq "$HOST")#g" -e "s#__ROOM_PATH__#$(sedq "$ROOM")#g" \
    -e "s#^apiAddress: 127.0.0.1:9997\$#apiAddress: 127.0.0.1:$API_PORT#" \
    -e "s#^webrtcAddress: :8889\$#webrtcAddress: :$WEBRTC_PORT#" \
    -e "s#^webrtcLocalUDPAddress: :8189\$#webrtcLocalUDPAddress: :$ICE_PORT#" \
    "$YML_SRC" > "$NEW/mediamtx.yml"
grep -n '__[A-Z_]*__' "$NEW/mediamtx.yml" >/dev/null && die "config still has a placeholder"
grep -x "apiAddress: 127.0.0.1:$API_PORT" "$NEW/mediamtx.yml" >/dev/null || die "config: control API is not local-only"
xmlq() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
sed -e "s#__APP_DIR__#$(sedq "$(xmlq "$APP_DIR")")#g" -e "s#__HOME__#$(sedq "$(xmlq "$HOME")")#g" "$PL_SRC" > "$WORK/$LABEL.plist"
plutil -lint "$WORK/$LABEL.plist" >/dev/null || die "rendered LaunchAgent plist does not lint"
ok "staged: binary, config (room $ROOM, API 127.0.0.1:$API_PORT, WebRTC :$WEBRTC_PORT), certificate, LaunchAgent"

if [ "$MODE" = dry ]; then
  echo "===== ES PREVIEW RELAY DRY RUN ====="
  echo "result: READY (nothing installed)"
  echo "would install: $APP_DIR"
  echo "would write: $PL"
  echo "certificate: $CERT_FROM, expires $(cert_end "$CRT_SRC")"
  echo "relay: MediaMTX $RELAY_VERSION sha256 $TAR_SHA256"
  echo "warnings: ${WARNINGS:-none}"
  echo "===================================="
  exit 0
fi

# ---------- 5. backup ----------
BK=""
if [ -d "$APP_DIR" ] || [ -f "$PL" ]; then
  BK="$BK_ROOT/preview-relay-$STAMP"; mkdir -p "$BK"
  [ -d "$APP_DIR" ] && cp -Rp "$APP_DIR" "$BK/app"
  [ -f "$PL" ] && cp -p "$PL" "$BK/$LABEL.plist"
  ok "backup: $BK"
fi

# ---------- 6. install + start ----------
launchctl bootout "gui/$UIDN/$LABEL" >/dev/null 2>&1 || true
for _ in 1 2 3 4 5 6 7 8 9 10; do job_loaded || break; sleep 0.5; done
mkdir -p "$(dirname "$APP_DIR")" "$(dirname "$PL")" "$(dirname "$LOG_FILE")"
rm -rf "$APP_DIR.new"; cp -Rp "$NEW" "$APP_DIR.new"
rm -rf "$APP_DIR"; mv "$APP_DIR.new" "$APP_DIR"
cp "$WORK/$LABEL.plist" "$PL"; chmod 644 "$PL"
START_ERR=""
launchctl bootstrap "gui/$UIDN" "$PL" >/dev/null 2>&1 || START_ERR="launchctl bootstrap failed"

# ---------- 7. readback ----------
RB=""; RB_PID=""; RB_TLS=""
readback() {
  local i=0 ver
  [ -z "$START_ERR" ] || { RB="$START_ERR"; return 1; }
  while [ "$i" -lt "$READBACK_TIMEOUT" ]; do
    ver="$(api_get /v3/info | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
    [ -n "$ver" ] && break
    sleep 1; i=$((i+1))
  done
  [ "$ver" = "$RELAY_VERSION" ] || { RB="control API did not report $RELAY_VERSION within ${READBACK_TIMEOUT}s (got '${ver:-nothing}')"; return 1; }
  RB_PID="$(job_pid)"
  [[ "$RB_PID" =~ ^[0-9]+$ ]] || { RB="launchd does not show $LABEL running"; return 1; }
  api_get "/v3/config/paths/get/$ROOM" >/dev/null || { RB="room path $ROOM is not configured"; return 1; }
  RB_TLS="$(tls_probe)"
  [ -n "$RB_TLS" ] && [ "$RB_TLS" != "000" ] || { RB="WebRTC port $WEBRTC_PORT did not answer with a trusted certificate for $HOST"; return 1; }
  return 0
}
if ! readback; then
  err "readback failed: $RB"
  launchctl bootout "gui/$UIDN/$LABEL" >/dev/null 2>&1 || true
  RESTORED="no previous relay (removed the new one)"
  rm -f "$PL"; rm -rf "$APP_DIR"
  if [ -n "$BK" ]; then
    [ -d "$BK/app" ] && cp -Rp "$BK/app" "$APP_DIR"
    if [ -f "$BK/$LABEL.plist" ]; then
      cp -p "$BK/$LABEL.plist" "$PL"
      launchctl bootstrap "gui/$UIDN" "$PL" >/dev/null 2>&1 && RESTORED="previous relay restored from $BK" || RESTORED="previous files restored from $BK, but it did not start"
    fi
  fi
  echo "===== ES PREVIEW RELAY INSTALL REPORT ====="
  echo "result: FAILED, rolled back"
  echo "reason: $RB"
  echo "rollback: $RESTORED"
  echo "log (last lines):"; tail -15 "$LOG_FILE" 2>/dev/null | sed 's/^/  /' || true
  echo "time (UTC): $STAMP"
  echo "==========================================="
  exit 1
fi
ok "readback: launchd pid $RB_PID, API $RELAY_VERSION, room path $ROOM, TLS ok on :$WEBRTC_PORT"

DNS_IP="$(resolve_host)"
if [ -z "$DNS_IP" ]; then warn "dns: $HOST does not resolve on this Mini yet"
elif ! local_ips | grep -x "$DNS_IP" >/dev/null; then warn "dns: $HOST points at $DNS_IP, which is not an address of this Mini"
fi
if [ "$CERT_FROM" = inbox ]; then rm -f "$INBOX/$HOST.key" "$INBOX/$HOST.crt"; rmdir "$INBOX" 2>/dev/null || true; fi

# ---------- 8. report ----------
echo
echo "===== ES PREVIEW RELAY INSTALL REPORT ====="
echo "result: SUCCESS"
echo "installer: $INSTALLER_VERSION"
echo "relay: MediaMTX $RELAY_VERSION (sha256 $TAR_SHA256)"
echo "room: $ROOM  host: $HOST"
echo "dns: $HOST -> ${DNS_IP:-does not resolve}"
echo "certificate: expires $(cert_end "$APP_DIR/certs/certificates/$HOST.crt") (issuer: $(cert_issuer "$APP_DIR/certs/certificates/$HOST.crt"))"
echo "pid: $RB_PID"
echo "listening: api 127.0.0.1:$API_PORT, webrtc :$WEBRTC_PORT (tls ok), ice udp :$ICE_PORT"
echo "folder: $APP_DIR"
echo "backup: ${BK:-none (first install)}"
echo "local preview switch: unchanged (Anna turns it on)"
echo "warnings: ${WARNINGS:-none}"
echo "undo: /bin/bash \"$REPO_DIR/scripts/install-preview-relay.sh\" --uninstall"
echo "time (UTC): $STAMP"
echo "==========================================="
