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
# Re-install on a Mini that already has the agent: pass only what changes.
# Every value left unset is reused from the live plist, e.g.
#   POWER_STRIP_URL=http://172.16.1.40 POWER_STRIP_USER=... POWER_STRIP_PASS=... ./install.sh --obs-launcher
#
# Optional:
#   PORT=8787           # port the agent listens on
#   RECORD_POLL_URL     # OS record poll host (default https://api.evrybdystudios.com)
#   AUTO_TUNNEL=1       # also start a cloudflared quick tunnel at the end
#   --obs-launcher      # start OBS safely at login via a separate LaunchAgent

set -euo pipefail

INSTALL_OBS_LAUNCHER=0
for arg in "$@"; do
  case "$arg" in
    --obs-launcher) INSTALL_OBS_LAUNCHER=1 ;;
    *) printf '[error] Unknown option: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

# ---------- pretty output helpers ----------
BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; CYA=$'\033[36m'; RST=$'\033[0m'
say()  { printf '%s\n' "$*"; }
info() { printf '%s[es-mini-agent]%s %s\n' "$CYA" "$RST" "$*"; }
ok()   { printf '%s[ok]%s %s\n'  "$GRN" "$RST" "$*"; }
warn() { printf '%s[warn]%s %s\n' "$YLW" "$RST" "$*"; }
err()  { printf '%s[error]%s %s\n' "$RED" "$RST" "$*" 1>&2; }

# ---------- reuse an existing install ----------
# A re-run used to wipe every value not passed on the command line (OBS_SOURCES
# empty => demo mode, no upload creds, no webhook). Now any value left unset is
# taken from the live plist, so a re-install only needs the NEW values. Pass a
# value explicitly to change it. R2_* are the pre-S3 names of the upload creds.
EXISTING_PLIST="$HOME/Library/LaunchAgents/com.es.mini-agent.plist"
REUSED_KEYS=()
if [[ -f "$EXISTING_PLIST" && -x /usr/libexec/PlistBuddy ]]; then
  for key in BUILDING_ID RECORD_CONTROL_KEY PORT RECORD_POLL_URL \
             OBS_SOURCES OBS_WS_URL OBS_WS_PASSWORD OBS_RECORD_DIR \
             S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY S3_BUCKET S3_ENDPOINT S3_REGION AWS_ROLE_ARN \
             R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET R2_ENDPOINT \
             UPLOAD_CONFIRMED_WEBHOOK_URL PTZ_HTTP_USER PTZ_HTTP_PASS \
             POWER_STRIP_URL POWER_STRIP_USER POWER_STRIP_PASS POWER_OUTLETS_SWITCHABLE; do
    [[ -n "${!key:-}" ]] && continue
    if value="$(/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:$key" "$EXISTING_PLIST" 2>/dev/null)" && [[ -n "$value" ]]; then
      printf -v "$key" '%s' "$value"
      export "$key"
      REUSED_KEYS+=("$key")
    fi
  done
fi

# ---------- read inputs ----------
: "${BUILDING_ID:=}"
: "${RECORD_CONTROL_KEY:=}"
PORT="${PORT:-8787}"
# Outbound OS record poll. Persist this in the plist so a reinstall cannot
# silently fall back to the retired Vercel host. Override only if Anna says so.
RECORD_POLL_URL="${RECORD_POLL_URL:-https://api.evrybdystudios.com}"
AUTO_TUNNEL="${AUTO_TUNNEL:-0}"
# Optional OBS control (empty OBS_SOURCES => demo mode, unchanged behavior).
OBS_SOURCES="${OBS_SOURCES:-}"
OBS_WS_URL="${OBS_WS_URL:-ws://127.0.0.1:4455}"
OBS_WS_PASSWORD="${OBS_WS_PASSWORD:-}"
OBS_RECORD_DIR="${OBS_RECORD_DIR:-}"
# Optional object-storage creds for recording uploads and preview frames.
S3_ACCESS_KEY_ID="${S3_ACCESS_KEY_ID:-${R2_ACCESS_KEY_ID:-}}"
S3_SECRET_ACCESS_KEY="${S3_SECRET_ACCESS_KEY:-${R2_SECRET_ACCESS_KEY:-}}"
S3_BUCKET="${S3_BUCKET:-${R2_BUCKET:-}}"
S3_ENDPOINT="${S3_ENDPOINT:-${R2_ENDPOINT:-}}"
S3_REGION="${S3_REGION:-}"
AWS_ROLE_ARN="${AWS_ROLE_ARN:-}"
UPLOAD_CONFIRMED_WEBHOOK_URL="${UPLOAD_CONFIRMED_WEBHOOK_URL:-}"
# Optional camera web-UI admin login; lives only on this Mini.
PTZ_HTTP_USER="${PTZ_HTTP_USER:-}"
PTZ_HTTP_PASS="${PTZ_HTTP_PASS:-}"
# Optional studio power strip (Digital Loggers Pro 10); login lives only on this Mini.
# Empty POWER_OUTLETS_SWITCHABLE => lights only. Router/PoE/Mini/NAS are refused in code.
POWER_STRIP_URL="${POWER_STRIP_URL:-}"
POWER_STRIP_USER="${POWER_STRIP_USER:-}"
POWER_STRIP_PASS="${POWER_STRIP_PASS:-}"
POWER_OUTLETS_SWITCHABLE="${POWER_OUTLETS_SWITCHABLE:-}"
REPO_RAW_BASE="${REPO_RAW_BASE:-https://raw.githubusercontent.com/annabuies/es-mini-agent/main}"

if (( ${#REUSED_KEYS[@]} )); then
  ok "Reusing ${#REUSED_KEYS[@]} value(s) from the existing install: ${REUSED_KEYS[*]}"
fi

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
  RECORD_POLL_URL     (defaults to https://api.evrybdystudios.com)
  AUTO_TUNNEL=1       (also start a cloudflared quick tunnel and print the public URL)
  --obs-launcher      (start OBS at login without the shutdown-check dialog)

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

# ---------- the module list ----------
# The list of runtime modules lives in modules.txt, NOT here, precisely so this
# installer and self-update.js cannot drift apart -- both read the same file. The
# agent has already shipped once missing aws-creds.js because two hardcoded lists
# disagreed, and it crash-looped on a machine nobody could SSH into.
#
# Only used if modules.txt is genuinely absent in local mode (a stale checkout).
FALLBACK_MODULES=(server.js log-timestamps.js obs-control.js storage-upload.js upload-queue.js aws-creds.js self-update.js cam-reach.js)
# The OBS launcher files are installer-only assets, NOT runtime modules: an already
# deployed self-update.js accepts only *.js names in modules.txt and would reject the
# whole update if they were listed there.
OBS_LAUNCHER_ASSETS=(obs-launcher.sh com.es.obs-launcher.plist)
MODULES=()

parse_manifest() {
  local file="$1"
  local line
  MODULES=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"                                 # strip comments
    line="${line#"${line%%[![:space:]]*}"}"             # ltrim
    line="${line%"${line##*[![:space:]]}"}"             # rtrim
    [[ -z "$line" ]] && continue
    MODULES+=("$line")
  done < "$file"
}

# ---------- pick run mode: local vs standalone ----------
PROJECT_DIR=""
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/server.js" ]]; then
  PROJECT_DIR="$SCRIPT_DIR"
  info "Local mode: using files in $PROJECT_DIR"
  # Nothing is downloaded in local mode, so modules.txt is already on disk.
  if [[ -f "$PROJECT_DIR/modules.txt" ]]; then
    parse_manifest "$PROJECT_DIR/modules.txt"
  fi
  if [[ "${#MODULES[@]}" -eq 0 ]]; then
    MODULES=("${FALLBACK_MODULES[@]}")
    warn "modules.txt not found (or empty) in $PROJECT_DIR — using the built-in module list."
    warn "This checkout is stale; 'git pull' to pick up modules.txt."
  fi
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

  # Manifest first: it decides what else gets downloaded.
  download "modules.txt"
  parse_manifest "$PROJECT_DIR/modules.txt"
  if [[ "${#MODULES[@]}" -eq 0 ]]; then
    err "modules.txt downloaded but parsed to an empty list — refusing to continue."
    exit 1
  fi
  for m in "${MODULES[@]}"; do
    download "$m"
  done
  if [[ "${INSTALL_OBS_LAUNCHER:-0}" == "1" ]]; then
    for a in "${OBS_LAUNCHER_ASSETS[@]}"; do
      download "$a"
    done
  fi
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

# ---------- find ffmpeg (used for the 1080p playback proxy; recording itself doesn't need it) ----------
FFMPEG_BIN=""
if command -v ffmpeg >/dev/null 2>&1; then
  FFMPEG_BIN="$(command -v ffmpeg)"
  ok "ffmpeg found at $FFMPEG_BIN"
else
  if command -v brew >/dev/null 2>&1; then
    info "ffmpeg not found — installing with Homebrew (this can take a couple of minutes)..."
    if brew install ffmpeg && command -v ffmpeg >/dev/null 2>&1; then
      FFMPEG_BIN="$(command -v ffmpeg)"
      ok "ffmpeg found at $FFMPEG_BIN"
    else
      warn "ffmpeg install via Homebrew did not complete. Recording will still work;"
      warn "playback proxies (1080p MP4 alongside the 4K master) will be skipped until ffmpeg is installed."
      warn "To add it later: brew install ffmpeg"
    fi
  else
    warn "ffmpeg is not installed and Homebrew is not available."
    warn "Recording will still work; playback proxies (1080p MP4 alongside the 4K master) will be skipped until ffmpeg is installed."
    warn "To add it later: install Homebrew (https://brew.sh) then run: brew install ffmpeg"
  fi
fi

# ---------- sanity: every manifest file exists ----------
for m in "${MODULES[@]}"; do
  if [[ ! -f "$PROJECT_DIR/$m" ]]; then
    err "$m not found in $PROJECT_DIR — cannot continue."
    exit 1
  fi
done

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
PTZ_HTTP_USER_X="$(xml_escape "$PTZ_HTTP_USER")"
PTZ_HTTP_PASS_X="$(xml_escape "$PTZ_HTTP_PASS")"
POWER_STRIP_URL_X="$(xml_escape "$POWER_STRIP_URL")"
POWER_STRIP_USER_X="$(xml_escape "$POWER_STRIP_USER")"
POWER_STRIP_PASS_X="$(xml_escape "$POWER_STRIP_PASS")"
POWER_OUTLETS_SWITCHABLE_X="$(xml_escape "$POWER_OUTLETS_SWITCHABLE")"
OBS_SOURCES_X="$(xml_escape "$OBS_SOURCES")"
OBS_WS_URL_X="$(xml_escape "$OBS_WS_URL")"
OBS_WS_PASSWORD_X="$(xml_escape "$OBS_WS_PASSWORD")"
OBS_RECORD_DIR_X="$(xml_escape "$OBS_RECORD_DIR")"
S3_ACCESS_KEY_ID_X="$(xml_escape "$S3_ACCESS_KEY_ID")"
S3_SECRET_ACCESS_KEY_X="$(xml_escape "$S3_SECRET_ACCESS_KEY")"
S3_BUCKET_X="$(xml_escape "$S3_BUCKET")"
S3_ENDPOINT_X="$(xml_escape "$S3_ENDPOINT")"
S3_REGION_X="$(xml_escape "$S3_REGION")"
AWS_ROLE_ARN_X="$(xml_escape "$AWS_ROLE_ARN")"
FFMPEG_BIN_X="$(xml_escape "$FFMPEG_BIN")"
UPLOAD_CONFIRMED_WEBHOOK_URL_X="$(xml_escape "$UPLOAD_CONFIRMED_WEBHOOK_URL")"
RECORD_POLL_URL_X="$(xml_escape "$RECORD_POLL_URL")"

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
        <!-- camera web-UI admin login; lives only on this Mini -->
        <key>PTZ_HTTP_USER</key>
        <string>${PTZ_HTTP_USER_X}</string>
        <key>PTZ_HTTP_PASS</key>
        <string>${PTZ_HTTP_PASS_X}</string>
        <!-- studio power strip login; lives only on this Mini -->
        <key>POWER_STRIP_URL</key>
        <string>${POWER_STRIP_URL_X}</string>
        <key>POWER_STRIP_USER</key>
        <string>${POWER_STRIP_USER_X}</string>
        <key>POWER_STRIP_PASS</key>
        <string>${POWER_STRIP_PASS_X}</string>
        <key>POWER_OUTLETS_SWITCHABLE</key>
        <string>${POWER_OUTLETS_SWITCHABLE_X}</string>
        <key>OBS_SOURCES</key>
        <string>${OBS_SOURCES_X}</string>
        <key>OBS_WS_URL</key>
        <string>${OBS_WS_URL_X}</string>
        <key>OBS_WS_PASSWORD</key>
        <string>${OBS_WS_PASSWORD_X}</string>
        <key>OBS_RECORD_DIR</key>
        <string>${OBS_RECORD_DIR_X}</string>
        <key>S3_ACCESS_KEY_ID</key>
        <string>${S3_ACCESS_KEY_ID_X}</string>
        <key>S3_SECRET_ACCESS_KEY</key>
        <string>${S3_SECRET_ACCESS_KEY_X}</string>
        <key>S3_BUCKET</key>
        <string>${S3_BUCKET_X}</string>
        <key>S3_ENDPOINT</key>
        <string>${S3_ENDPOINT_X}</string>
        <key>S3_REGION</key>
        <string>${S3_REGION_X}</string>
        <key>AWS_ROLE_ARN</key>
        <string>${AWS_ROLE_ARN_X}</string>
        <key>FFMPEG_BIN</key>
        <string>${FFMPEG_BIN_X}</string>
        <key>UPLOAD_CONFIRMED_WEBHOOK_URL</key>
        <string>${UPLOAD_CONFIRMED_WEBHOOK_URL_X}</string>
        <key>RECORD_POLL_URL</key>
        <string>${RECORD_POLL_URL_X}</string>
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

# Older installers left a misleading, env-free template beside server.js. The
# live plist is the one above in ~/Library/LaunchAgents; never leave the stale
# project-folder copy behind after a successful load.
rm -f "$PROJECT_DIR/com.es.mini-agent.plist"

# ---------- optional OBS login launcher ----------
if [[ "$INSTALL_OBS_LAUNCHER" == "1" ]]; then
  OBS_LAUNCHER_TEMPLATE="$PROJECT_DIR/com.es.obs-launcher.plist"
  OBS_LAUNCHER_SCRIPT="$PROJECT_DIR/obs-launcher.sh"
  OBS_LAUNCHER_PLIST="$LAUNCH_AGENTS_DIR/com.es.obs-launcher.plist"

  if [[ ! -f "$OBS_LAUNCHER_TEMPLATE" || ! -f "$OBS_LAUNCHER_SCRIPT" ]]; then
    err "OBS launcher files are missing from $PROJECT_DIR — cannot install --obs-launcher."
    exit 1
  fi

  # launchd starts the launcher with /bin/bash, and macOS folder privacy blocks
  # bash (unlike node) from reading anything under ~/Documents: the job exits 126
  # with "Operation not permitted". Run a copy from Application Support instead,
  # which is not a protected folder, and keep its logs there too.
  OBS_LAUNCHER_DIR="$HOME/Library/Application Support/es-mini-agent"
  mkdir -p "$OBS_LAUNCHER_DIR"
  install -m 755 "$OBS_LAUNCHER_SCRIPT" "$OBS_LAUNCHER_DIR/obs-launcher.sh"

  # Escape the XML-safe launcher path for a sed replacement as well.
  OBS_LAUNCHER_DIR_X="$(xml_escape "$OBS_LAUNCHER_DIR")"
  OBS_LAUNCHER_DIR_SED="${OBS_LAUNCHER_DIR_X//\\/\\\\}"
  OBS_LAUNCHER_DIR_SED="${OBS_LAUNCHER_DIR_SED//&/\\&}"
  OBS_LAUNCHER_DIR_SED="${OBS_LAUNCHER_DIR_SED//|/\\|}"
  TMP_OBS_PLIST="$(mktemp -t es-obs-launcher.plist.XXXXXX)"
  sed "s|__LAUNCHER_DIR__|${OBS_LAUNCHER_DIR_SED}|g" "$OBS_LAUNCHER_TEMPLATE" > "$TMP_OBS_PLIST"
  chmod 644 "$TMP_OBS_PLIST"
  mv "$TMP_OBS_PLIST" "$OBS_LAUNCHER_PLIST"
  chmod 644 "$OBS_LAUNCHER_PLIST"

  if launchctl list 2>/dev/null | grep -q 'com\.es\.obs-launcher'; then
    launchctl unload "$OBS_LAUNCHER_PLIST" >/dev/null 2>&1 || true
  fi
  if ! launchctl load "$OBS_LAUNCHER_PLIST"; then
    err "launchctl load failed for $OBS_LAUNCHER_PLIST"
    exit 1
  fi
  ok "launchd loaded com.es.obs-launcher (script in $OBS_LAUNCHER_DIR)"
  warn "Remove OBS from System Settings → General → Login Items to avoid duplicate launches."
fi

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

  Anna will set this as ${BOLD}RECORD_CONTROL_URL${RST} on the Cloudflare Worker ${BOLD}es-os-app${RST} (api.evrybdystudios.com).
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
    printf '  2. Public tunnel URL to put on the Cloudflare Worker es-os-app\n'
    printf '     (api.evrybdystudios.com) as RECORD_CONTROL_URL:\n       %s\n' "$TUNNEL_URL"
    printf '  3. She also sets RECORD_CONTROL_KEY on the Cloudflare Worker es-os-app\n'
    printf '     (api.evrybdystudios.com) to the same secret you used here.\n'
  else
    printf '  2. Anna needs a public URL that reaches this Mac. Once she has one\n'
    printf '     (e.g. a cloudflared tunnel URL), she sets it on the Cloudflare\n'
    printf '     Worker es-os-app (api.evrybdystudios.com) as RECORD_CONTROL_URL,\n'
    printf '     and sets RECORD_CONTROL_KEY there to the same secret you used\n'
    printf '     here. That flips the app live.\n'
  fi)

EOF
