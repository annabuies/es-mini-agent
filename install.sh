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
#   RECORD_POLL_URL=https://es-os-app.crmes.workers.dev  # documented fallback

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
RECORD_POLL_URL="${RECORD_POLL_URL:-https://api.evrybdystudios.com}"
# Production OBS control configuration.
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
  RECORD_POLL_URL=https://es-os-app.crmes.workers.dev
                      (fallback if the permanent hostname is unavailable)

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
FALLBACK_MODULES=(server.js obs-control.js r2-upload.js upload-queue.js aws-creds.js self-update.js)
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
  # Deliberately NOT in the manifest: it is a launchd template, not a runtime
  # module, and self-update must never touch it.
  download "com.es.mini-agent.plist"
fi

cd "$PROJECT_DIR"

# Persist the outbound relay target separately from secrets so the installed
# target is inspectable and survives restarts even before launchd is loaded.
ENV_FILE="$PROJECT_DIR/.env"
TMP_ENV="$(mktemp -t es-mini-agent.env.XXXXXX)"
umask 077
if [[ -f "$ENV_FILE" ]]; then
  awk '!/^RECORD_POLL_URL=/' "$ENV_FILE" > "$TMP_ENV"
fi
printf 'RECORD_POLL_URL=%s\n' "$RECORD_POLL_URL" >> "$TMP_ENV"
chmod 600 "$TMP_ENV"
mv "$TMP_ENV" "$ENV_FILE"
chmod 600 "$ENV_FILE"
ok "Persisted RECORD_POLL_URL in $ENV_FILE (mode 600)"

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

# ---------- sanity: every manifest module and the launchd template exist ----------
for m in "${MODULES[@]}"; do
  if [[ ! -f "$PROJECT_DIR/$m" ]]; then
    err "$m not found in $PROJECT_DIR — cannot continue."
    exit 1
  fi
done
if [[ ! -f "$PROJECT_DIR/com.es.mini-agent.plist" ]]; then
  err "com.es.mini-agent.plist not found in $PROJECT_DIR — cannot continue."
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
RECORD_POLL_URL_X="$(xml_escape "$RECORD_POLL_URL")"
KEY_X="$(xml_escape "$RECORD_CONTROL_KEY")"
BID_X="$(xml_escape "$BUILDING_ID")"
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
        <key>RECORD_POLL_URL</key>
        <string>${RECORD_POLL_URL_X}</string>
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
  relay target: ${BOLD}${RECORD_POLL_URL}${RST}
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

# ---------- final reminder ----------
cat <<EOF

${BOLD}What to tell Anna:${RST}
  1. Local agent health URL (on this Mac only):
       ${HEALTH_URL}
  2. Outbound Cloudflare relay target:
       ${RECORD_POLL_URL}
  3. Confirm agent.log shows successful polling of that exact target.

EOF
