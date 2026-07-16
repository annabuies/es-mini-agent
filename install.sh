#!/usr/bin/env bash
# es-mini-agent — one-command installer.
# Installs the EVRYBDY FLEET Mini agent as a launchd LaunchAgent that auto-starts
# at login and auto-restarts on crash. Designed for a non-technical building
# owner to run once and forget about.
#
# Usage (from a fresh Mac, no repo cloned):
#   BUILDING_ID=bench-1 RECORD_CONTROL_KEY='your-long-secret' \
#     bash <(curl -fsSL https://raw.githubusercontent.com/annabuies/es-mini-agent/main/install.sh)
#
# Usage (from inside a cloned repo):
#   BUILDING_ID=bench-1 RECORD_CONTROL_KEY='your-long-secret' ./install.sh
#
# Optional:
#   PORT=8787           # port the agent listens on
#   AUTO_TUNNEL=1       # also start a cloudflared quick tunnel at the end

set -euo pipefail

# ---------- pretty output helpers ----------
BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; CYA=$'\033[36m'; RST=$'\033[0m'
say()  { printf '%s\n' "$*"; }
info() { printf '%s[es-mini-agent]%s %s\n' "$CYA" "$RST" "$*"; }
ok()   { printf '%s[ok]%s %s\n'  "$GRN" "$RST" "$*"; }
warn() { printf '%s[warn]%s %s\n' "$YLW" "$RST" "$*"; }
err()  { printf '%s[error]%s %s\n' "$RED" "$RST" "$*" 1>&2; }

# ---------- read inputs ----------
: "${BUILDING_ID:=}"
: "${RECORD_CONTROL_KEY:=}"
PORT="${PORT:-8787}"
AUTO_TUNNEL="${AUTO_TUNNEL:-0}"
# Optional OBS control (empty OBS_SOURCES => demo mode, unchanged behavior).
OBS_SOURCES="${OBS_SOURCES:-}"
OBS_WS_URL="${OBS_WS_URL:-ws://127.0.0.1:4455}"
OBS_WS_PASSWORD="${OBS_WS_PASSWORD:-}"
OBS_RECORD_DIR="${OBS_RECORD_DIR:-}"
# Optional R2 dummy-upload test creds (used only by the /r2test/* endpoints).
R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-}"
R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-}"
R2_BUCKET="${R2_BUCKET:-}"
R2_ENDPOINT="${R2_ENDPOINT:-}"
UPLOAD_CONFIRMED_WEBHOOK_URL="${UPLOAD_CONFIRMED_WEBHOOK_URL:-}"
REPO_RAW_BASE="${REPO_RAW_BASE:-https://raw.githubusercontent.com/annabuies/es-mini-agent/main}"

if [[ -z "$BUILDING_ID" || -z "$RECORD_CONTROL_KEY" ]]; then
  err "BUILDING_ID and RECORD_CONTROL_KEY are required."
  cat <<EOF

${BOLD}How to run this installer:${RST}

  BUILDING_ID=bench-1 RECORD_CONTROL_KEY='paste-your-long-secret-here' \\
    bash <(curl -fsSL ${REPO_RAW_BASE}/install.sh)

If you already cloned the repo, run it directly from inside the repo folder:

  BUILDING_ID=bench-1 RECORD_CONTROL_KEY='paste-your-long-secret-here' ./install.sh

Optional:
  PORT=8787           (defaults to 8787)
  AUTO_TUNNEL=1       (also start a cloudflared quick tunnel and print the public URL)

EOF
  exit 1
fi

# ---------- figure out where the script is ----------
# BASH_SOURCE is "" when piped (bash <(curl ...) or curl | bash). Detect that.
SCRIPT_SRC="${BASH_SOURCE[0]:-}"
if [[ -n "$SCRIPT_SRC" && -f "$SCRIPT_SRC" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SRC")" && pwd)"
else
  SCRIPT_DIR=""
fi

# ---------- pick run mode: local vs standalone ----------
PROJECT_DIR=""
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/server.js" ]]; then
  PROJECT_DIR="$SCRIPT_DIR"
  info "Local mode: using files in $PROJECT_DIR"
else
  PROJECT_DIR="$HOME/Documents/es-mini-agent"
  info "Standalone mode: setting up in $PROJECT_DIR"
  mkdir -p "$PROJECT_DIR"

  download() {
    local name="$1"
    local url="${REPO_RAW_BASE}/${name}"
    info "Downloading $name from $url"
    if ! curl -fsSL "$url" -o "$PROJECT_DIR/$name"; then
      err "Failed to download $url"
      err "The repo may be private, unpushed, or the URL may be wrong."
      err "If the repo is private, clone it manually and run ./install.sh from inside."
      exit 1
    fi
  }
  download "server.js"
  download "com.es.mini-agent.plist"
  download "obs-control.js"
  download "r2-upload.js"
fi

cd "$PROJECT_DIR"

# ---------- find node ----------
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
else
  if command -v brew >/dev/null 2>&1; then
    info "Node not found — installing with Homebrew (this can take a couple of minutes)..."
    brew install node
    if ! command -v node >/dev/null 2>&1; then
      err "brew install node completed but 'node' is still not on PATH."
      err "Open a new Terminal window and re-run this installer."
      exit 1
    fi
    NODE_BIN="$(command -v node)"
  else
    err "Node.js is not installed and Homebrew is not available."
    cat <<'EOF'

Please install Node.js (version 18 or newer) first:

  1. Open https://nodejs.org in a browser.
  2. Download and run the "LTS" macOS installer.
  3. Open a NEW Terminal window and re-run this installer.

EOF
    exit 1
  fi
fi

# Resolve to absolute path (in case command -v returned something relative).
NODE_BIN="$(cd "$(dirname "$NODE_BIN")" && pwd)/$(basename "$NODE_BIN")"

# ---------- verify node major >= 18 ----------
NODE_VERSION_RAW="$("$NODE_BIN" -v 2>/dev/null || true)"   # e.g. v20.11.0
NODE_MAJOR="$(printf '%s' "$NODE_VERSION_RAW" | sed -E 's/^v?([0-9]+).*/\1/')"
if [[ -z "$NODE_MAJOR" || ! "$NODE_MAJOR" =~ ^[0-9]+$ || "$NODE_MAJOR" -lt 18 ]]; then
  err "Found Node at $NODE_BIN (version '$NODE_VERSION_RAW') but this agent needs Node 18 or newer."
  err "Please upgrade Node (https://nodejs.org, LTS installer) and re-run."
  exit 1
fi
ok "Node $NODE_VERSION_RAW at $NODE_BIN"

# ---------- sanity: server.js and template exist ----------
if [[ ! -f "$PROJECT_DIR/server.js" ]]; then
  err "server.js not found in $PROJECT_DIR — cannot continue."
  exit 1
fi
if [[ ! -f "$PROJECT_DIR/com.es.mini-agent.plist" ]]; then
  err "com.es.mini-agent.plist not found in $PROJECT_DIR — cannot continue."
  exit 1
fi
if [[ ! -f "$PROJECT_DIR/obs-control.js" ]]; then
  err "obs-control.js not found in $PROJECT_DIR — cannot continue."
  exit 1
fi
if [[ ! -f "$PROJECT_DIR/r2-upload.js" ]]; then
  err "r2-upload.js not found in $PROJECT_DIR — cannot continue."
  exit 1
fi

# ---------- build the launchd plist FROM scratch (heredoc, not sed) ----------
# We build it ourselves so a RECORD_CONTROL_KEY containing / & or other sed
# metacharacters can never corrupt the file. We only XML-escape the values.
xml_escape() {
  # escape & < > " ' for XML text content
  local s="$1"
  s="${s//&/&amp;}"
  s="${s//</&lt;}"
  s="${s//>/&gt;}"
  s="${s//\"/&quot;}"
  s="${s//\'/&apos;}"
  printf '%s' "$s"
}

LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$LAUNCH_AGENTS_DIR/com.es.mini-agent.plist"
LOG_OUT="$PROJECT_DIR/agent.log"
LOG_ERR="$PROJECT_DIR/agent.error.log"

mkdir -p "$LAUNCH_AGENTS_DIR"

NODE_BIN_X="$(xml_escape "$NODE_BIN")"
PROJECT_DIR_X="$(xml_escape "$PROJECT_DIR")"
LOG_OUT_X="$(xml_escape "$LOG_OUT")"
LOG_ERR_X="$(xml_escape "$LOG_ERR")"
PORT_X="$(xml_escape "$PORT")"
KEY_X="$(xml_escape "$RECORD_CONTROL_KEY")"
BID_X="$(xml_escape "$BUILDING_ID")"
OBS_SOURCES_X="$(xml_escape "$OBS_SOURCES")"
OBS_WS_URL_X="$(xml_escape "$OBS_WS_URL")"
OBS_WS_PASSWORD_X="$(xml_escape "$OBS_WS_PASSWORD")"
OBS_RECORD_DIR_X="$(xml_escape "$OBS_RECORD_DIR")"
R2_ACCESS_KEY_ID_X="$(xml_escape "$R2_ACCESS_KEY_ID")"
R2_SECRET_ACCESS_KEY_X="$(xml_escape "$R2_SECRET_ACCESS_KEY")"
R2_BUCKET_X="$(xml_escape "$R2_BUCKET")"
R2_ENDPOINT_X="$(xml_escape "$R2_ENDPOINT")"
UPLOAD_CONFIRMED_WEBHOOK_URL_X="$(xml_escape "$UPLOAD_CONFIRMED_WEBHOOK_URL")"

# Write to a temp file first, then move + chmod, so we never leave a
# world-readable plist containing the secret on disk mid-write.
TMP_PLIST="$(mktemp -t es-mini-agent.plist.XXXXXX)"
umask 077
cat > "$TMP_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.es.mini-agent</string>

    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN_X}</string>
        <string>server.js</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${PROJECT_DIR_X}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PORT</key>
        <string>${PORT_X}</string>
        <key>RECORD_CONTROL_KEY</key>
        <string>${KEY_X}</string>
        <key>BUILDING_ID</key>
        <string>${BID_X}</string>
        <key>OBS_SOURCES</key>
        <string>${OBS_SOURCES_X}</string>
        <key>OBS_WS_URL</key>
        <string>${OBS_WS_URL_X}</string>
        <key>OBS_WS_PASSWORD</key>
        <string>${OBS_WS_PASSWORD_X}</string>
        <key>OBS_RECORD_DIR</key>
        <string>${OBS_RECORD_DIR_X}</string>
        <key>R2_ACCESS_KEY_ID</key>
        <string>${R2_ACCESS_KEY_ID_X}</string>
        <key>R2_SECRET_ACCESS_KEY</key>
        <string>${R2_SECRET_ACCESS_KEY_X}</string>
        <key>R2_BUCKET</key>
        <string>${R2_BUCKET_X}</string>
        <key>R2_ENDPOINT</key>
        <string>${R2_ENDPOINT_X}</string>
        <key>UPLOAD_CONFIRMED_WEBHOOK_URL</key>
        <string>${UPLOAD_CONFIRMED_WEBHOOK_URL_X}</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${LOG_OUT_X}</string>

    <key>StandardErrorPath</key>
    <string>${LOG_ERR_X}</string>

    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
PLIST

chmod 600 "$TMP_PLIST"
mv "$TMP_PLIST" "$PLIST_PATH"
chmod 600 "$PLIST_PATH"
ok "Wrote $PLIST_PATH (mode 600)"

# ---------- load / reload idempotently ----------
if launchctl list 2>/dev/null | grep -q 'com\.es\.mini-agent'; then
  info "com.es.mini-agent already loaded — unloading first."
  launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
fi

if ! launchctl load "$PLIST_PATH"; then
  err "launchctl load failed for $PLIST_PATH"
  err "Check Console.app or run: launchctl load $PLIST_PATH   to see the error."
  exit 1
fi
ok "launchd loaded com.es.mini-agent"

# ---------- verify ----------
info "Waiting for the agent to come up..."
sleep 2

HEALTH_URL="http://localhost:${PORT}/health"
HEALTH_JSON=""
if HEALTH_JSON="$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null)" && \
   printf '%s' "$HEALTH_JSON" | grep -q '"ok":true'; then
  cat <<EOF

${GRN}${BOLD}=====================================================================${RST}
${GRN}${BOLD}  SUCCESS — es-mini-agent is running.${RST}
${GRN}${BOLD}=====================================================================${RST}

  building_id : ${BOLD}${BUILDING_ID}${RST}
  local URL   : ${BOLD}${HEALTH_URL}${RST}
  health JSON : ${HEALTH_JSON}

  Logs:
    ${LOG_OUT}
    ${LOG_ERR}

  Tail them live:
    tail -f "${LOG_OUT}" "${LOG_ERR}"

  It auto-starts every time you log in, and auto-restarts if it crashes.
  To remove: run ./uninstall.sh

EOF
else
  cat <<EOF

${RED}${BOLD}=====================================================================${RST}
${RED}${BOLD}  FAILURE — the agent did not answer on ${HEALTH_URL}${RST}
${RED}${BOLD}=====================================================================${RST}

  The launchd job was loaded but the health check failed. Most common cause:
  the process died on startup because of a bad env var.

  Look at the error log:
    tail -n 50 "${LOG_ERR}"

  Then fix the issue and re-run this installer.

EOF
  exit 1
fi

# ---------- optional cloudflared quick tunnel ----------
TUNNEL_URL=""
if [[ "$AUTO_TUNNEL" == "1" ]]; then
  if command -v cloudflared >/dev/null 2>&1; then
    TUNNEL_LOG="$PROJECT_DIR/tunnel.log"
    info "Starting cloudflared quick tunnel in the background..."
    : > "$TUNNEL_LOG"
    # nohup + disown so it survives this shell exiting.
    nohup cloudflared tunnel --url "http://localhost:${PORT}" \
      >> "$TUNNEL_LOG" 2>&1 &
    TUNNEL_PID=$!
    disown "$TUNNEL_PID" 2>/dev/null || true

    # cloudflared prints the URL within a couple seconds. Give it up to ~15s.
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
      sleep 1
      TUNNEL_URL="$(grep -Eo 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -n1 || true)"
      if [[ -n "$TUNNEL_URL" ]]; then break; fi
    done

    if [[ -n "$TUNNEL_URL" ]]; then
      cat <<EOF

${CYA}${BOLD}=====================================================================${RST}
${CYA}${BOLD}  PUBLIC TUNNEL URL — GIVE THIS URL TO ANNA${RST}
${CYA}${BOLD}=====================================================================${RST}

     ${BOLD}${TUNNEL_URL}${RST}

  Tunnel PID    : ${TUNNEL_PID}
  Tunnel log    : ${TUNNEL_LOG}

  Anna will set this as ${BOLD}RECORD_CONTROL_URL${RST} on Vercel.
  This is a QUICK tunnel — if this Mac reboots, the URL changes.
  For production, install a named cloudflared tunnel instead.

EOF
    else
      warn "cloudflared started (PID $TUNNEL_PID) but no https://*.trycloudflare.com URL appeared in $TUNNEL_LOG within 15s."
      warn "Check the log: tail -f $TUNNEL_LOG"
    fi
  else
    warn "AUTO_TUNNEL=1 requested but 'cloudflared' is not installed."
    warn "Install it with:  brew install cloudflared"
    warn "Then re-run this installer with AUTO_TUNNEL=1, or start the tunnel manually:"
    warn "  cloudflared tunnel --url http://localhost:${PORT}"
    warn "(The agent itself is installed and running — only the tunnel step was skipped.)"
  fi
fi

# ---------- final reminder ----------
cat <<EOF

${BOLD}What to tell Anna:${RST}
  1. Local agent health URL (on this Mac only):
       ${HEALTH_URL}
$(if [[ -n "$TUNNEL_URL" ]]; then
    printf '  2. Public tunnel URL to put in Vercel as RECORD_CONTROL_URL:\n       %s\n' "$TUNNEL_URL"
    printf '  3. She also sets RECORD_CONTROL_KEY on Vercel to the same secret you used here.\n'
  else
    printf '  2. Anna needs a public URL that reaches this Mac. Once she has one\n'
    printf '     (e.g. a cloudflared tunnel URL), she sets it on Vercel as\n'
    printf '     RECORD_CONTROL_URL, and sets RECORD_CONTROL_KEY on Vercel to the\n'
    printf '     same secret you used here. That flips the app live.\n'
  fi)

EOF
