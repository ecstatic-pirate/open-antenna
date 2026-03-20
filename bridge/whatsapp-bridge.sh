#!/bin/bash
# Open Antenna — WhatsApp Bridge
#
# Two-way WhatsApp daemon:
#   - Polls for new messages from the configured sender every POLL_INTERVAL seconds
#   - Pipes messages to Claude Code CLI with bundled antenna skills
#   - Sends Claude's response back via wacli
#   - At the configured briefing time, runs `antenna run` instead of message processing
#
# Resilience features:
#   - Lock file (kernel-level, no PID reuse risk)
#   - Configurable timeout per message (default 600s)
#   - Long-task ack: sends "On it..." immediately for slow requests (URLs, skill commands)
#   - Poison message skip: after 3 consecutive Claude failures, advances timestamp
#   - Session recovery: detects corrupted Claude sessions, auto-resets
#   - Log rotation at 1MB
#   - Antenna trigger: at briefing time, runs digest pipeline instead of chat
#
# Usage: Run by the daemon manager (launchd / systemd).
#        Reads config from ANTENNA_CONFIG (env var, default: ./config.yaml)
#        Reads wacli path from WACLI_BIN (env var, auto-detected if not set)
#        State files stored in ANTENNA_DATA_DIR (env var, default: ~/.antenna)

set -euo pipefail

# ── Config resolution ─────────────────────────────────────────────────────────

# ANTENNA_CONFIG must be set by the daemon manager (filled from config at install time)
CONFIG_FILE="${ANTENNA_CONFIG:-./config.yaml}"
DATA_DIR="${ANTENNA_DATA_DIR:-$HOME/.antenna}"

if [ ! -f "$CONFIG_FILE" ]; then
    echo "ERROR: config file not found: $CONFIG_FILE" >&2
    exit 1
fi

# ── Parse config.yaml with python3 ───────────────────────────────────────────
# We use python3 to parse YAML rather than bundling a YAML parser in bash.
# This avoids a jq/yq dependency for a lightweight field lookup.

# Parse all needed config values in a single python3 call (one value per line)
_CONFIG_VALS=$(python3 - "$CONFIG_FILE" <<'PYEOF'
import sys, re

def parse_simple_yaml(path):
    """Minimal YAML parser: handles flat, one-level, and two-level nested keys."""
    data = {}
    current_section = None
    current_subsection = None
    with open(path) as f:
        for line in f:
            line = re.sub(r'\s*#.*$', '', line).rstrip()
            if not line:
                continue
            # Top-level section (no value)
            m = re.match(r'^(\w[\w\-]*)\s*:\s*$', line)
            if m:
                current_section = m.group(1)
                data[current_section] = {}
                current_subsection = None
                continue
            # Two-space indent subsection (no value)
            m = re.match(r'^  (\w[\w\-_]*)\s*:\s*$', line)
            if m and current_section:
                current_subsection = m.group(1)
                data[current_section][current_subsection] = {}
                continue
            # Four-space indent value (under subsection)
            m = re.match(r'^    (\w[\w\-_]*)\s*:\s*(.+)$', line)
            if m and current_section and current_subsection:
                val = m.group(2).strip().strip('"').strip("'")
                if isinstance(data[current_section].get(current_subsection), dict):
                    data[current_section][current_subsection][m.group(1)] = val
                continue
            # Two-space indent value (under section)
            m = re.match(r'^\s{2,}(\w[\w\-_]*)\s*:\s*(.*)$', line)
            if m and current_section:
                val = m.group(2).strip().strip('"').strip("'")
                if current_subsection and isinstance(data[current_section].get(current_subsection), dict):
                    data[current_section][current_subsection][m.group(1)] = val
                else:
                    current_subsection = None
                    data[current_section][m.group(1)] = val
                continue
            # Top-level value
            m = re.match(r'^(\w[\w\-_]*)\s*:\s*(.+)$', line)
            if m:
                val = m.group(2).strip().strip('"').strip("'")
                data[m.group(1)] = val
    return data

def get(data, key, default=''):
    parts = key.split('.')
    val = data
    try:
        for p in parts:
            val = val[p]
        return str(val) if val is not None else default
    except (KeyError, TypeError):
        return default

path = sys.argv[1]
data = parse_simple_yaml(path)
print(get(data, 'bridge.whatsapp.sender_id', get(data, 'bridge.sender_id', '')))
print(get(data, 'bridge.whatsapp.poll_interval', get(data, 'bridge.poll_interval', '30')))
print(get(data, 'bridge.whatsapp.message_timeout', get(data, 'bridge.message_timeout', '600')))
print(get(data, 'bridge.whatsapp.antenna_timeout', get(data, 'bridge.antenna_timeout', '900')))
print(get(data, 'schedule.time', '07:00'))
print(get(data, 'schedule.timezone', 'UTC'))
PYEOF
)
SENDER_ID=$(echo "$_CONFIG_VALS"      | sed -n '1p')
POLL_INTERVAL=$(echo "$_CONFIG_VALS"  | sed -n '2p')
MESSAGE_TIMEOUT=$(echo "$_CONFIG_VALS" | sed -n '3p')
ANTENNA_TIMEOUT=$(echo "$_CONFIG_VALS" | sed -n '4p')
BRIEFING_TIME=$(echo "$_CONFIG_VALS"  | sed -n '5p')
BRIEFING_TZ=$(echo "$_CONFIG_VALS"    | sed -n '6p')

if [ -z "$SENDER_ID" ]; then
    echo "ERROR: bridge.sender_id is not set in $CONFIG_FILE" >&2
    exit 1
fi

# Derive sender prefix (everything before @)
SENDER_PREFIX="${SENDER_ID%%@*}"

# ── Paths ─────────────────────────────────────────────────────────────────────

mkdir -p "$DATA_DIR"

STATE_FILE="$DATA_DIR/bridge-state"
SESSION_FILE="$DATA_DIR/bridge-session"
LOCK_FILE="$DATA_DIR/bridge.lock"
FAIL_COUNT_FILE="$DATA_DIR/bridge-fails"
ANTENNA_MARKER="$DATA_DIR/antenna-ran-today"
LOG_FILE="$DATA_DIR/bridge.log"
CLAUDE_ERR="$DATA_DIR/bridge-claude-err"

# ── Binary resolution ─────────────────────────────────────────────────────────

OS=$(uname -s)

# wacli: env var → common paths → PATH
if [ -z "${WACLI_BIN:-}" ]; then
    if [ "$OS" = "Darwin" ]; then
        WACLI_BIN="/opt/homebrew/bin/wacli"
        [ ! -f "$WACLI_BIN" ] && WACLI_BIN="/usr/local/bin/wacli"
    else
        WACLI_BIN="/usr/local/bin/wacli"
    fi
    [ ! -f "$WACLI_BIN" ] && WACLI_BIN=$(which wacli 2>/dev/null || echo "")
fi

if [ -z "$WACLI_BIN" ] || [ ! -f "$WACLI_BIN" ]; then
    echo "ERROR: wacli not found. Run 'antenna init' or set WACLI_BIN." >&2
    exit 1
fi

# Claude Code CLI
CLAUDE_BIN=$(which claude 2>/dev/null || echo "$HOME/.local/bin/claude")
if [ ! -f "$CLAUDE_BIN" ] && ! which claude >/dev/null 2>&1; then
    echo "ERROR: Claude Code CLI not found. Install from https://claude.ai/code" >&2
    exit 1
fi

# antenna CLI (for digest trigger)
ANTENNA_BIN=$(which antenna 2>/dev/null || echo "")

# Skills dir — bundled with the package
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(dirname "$SCRIPT_DIR")"
SKILLS_DIR="$PKG_DIR/skills"

# ── Helpers ───────────────────────────────────────────────────────────────────

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG_FILE"
}

send_to_user() {
    "$WACLI_BIN" send text --to "$SENDER_ID" --message "$1" 2>/dev/null
}

generate_uuid() {
    uuidgen 2>/dev/null | tr '[:upper:]' '[:lower:]' || python3 -c "import uuid; print(uuid.uuid4())"
}

# load_or_create_session <label>
# Sets SESSION_FLAG. <label> is used only for log messages (e.g. "Briefing" or "Message").
load_or_create_session() {
    local label="${1:-Session}"
    if [ -f "$SESSION_FILE" ]; then
        local session_id
        session_id=$(cat "$SESSION_FILE")
        SESSION_FLAG="--resume $session_id"
        log "$label: resuming session $session_id"
    else
        local session_id
        session_id=$(generate_uuid)
        if [ -z "$session_id" ]; then
            log "$label: failed to generate session UUID"
            SESSION_FLAG=""
        else
            echo "$session_id" > "$SESSION_FILE"
            SESSION_FLAG="--session-id $session_id"
            log "$label: created session $session_id"
        fi
    fi
}

# ── Setup ─────────────────────────────────────────────────────────────────────

# Unset CLAUDECODE so claude can run outside nested sessions
unset CLAUDECODE

# Rotate log at 1MB
if [ -f "$LOG_FILE" ]; then
    if [ "$OS" = "Darwin" ]; then
        _LOG_SIZE=$(stat -f%z "$LOG_FILE" 2>/dev/null || echo 0)
    else
        _LOG_SIZE=$(stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)
    fi
    [ "$_LOG_SIZE" -gt 1048576 ] && mv "$LOG_FILE" "${LOG_FILE}.bak"
fi

# Clean stale error file from previous run
rm -f "$CLAUDE_ERR"

# ── Lock (kernel-level, non-blocking) ────────────────────────────────────────

if [ -z "${ANTENNA_BRIDGE_LOCKED:-}" ]; then
    export ANTENNA_BRIDGE_LOCKED=1
    if [ "$OS" = "Darwin" ]; then
        exec /usr/bin/lockf -t 0 "$LOCK_FILE" "$0" "$@"
    else
        exec flock -n "$LOCK_FILE" "$0" "$@"
    fi
fi

# ── Antenna briefing trigger ─────────────────────────────────────────────────
# At the scheduled briefing time, run `antenna run` instead of message processing.
# We convert the local briefing time to UTC hour for comparison.

CURRENT_DATE=$(date +%Y-%m-%d)
MARKER_DATE=""
[ -f "$ANTENNA_MARKER" ] && MARKER_DATE=$(cat "$ANTENNA_MARKER")

# Convert briefing time to local hour for comparison
BRIEFING_HOUR=$(echo "$BRIEFING_TIME" | cut -d: -f1 | sed 's/^0//')
CURRENT_LOCAL_HOUR=$(date +%-H 2>/dev/null || date +%H | sed 's/^0//')

if [ "$CURRENT_LOCAL_HOUR" -eq "$BRIEFING_HOUR" ] && [ "$MARKER_DATE" != "$CURRENT_DATE" ]; then
    log "Briefing: triggering antenna run"

    # Build session flag
    load_or_create_session "Briefing"

    # Run antenna digest pipeline
    if [ -n "$ANTENNA_BIN" ]; then
        ANTENNA_OUTPUT=$(timeout "$ANTENNA_TIMEOUT" "$ANTENNA_BIN" run --config "$CONFIG_FILE" 2>&1)
        ANTENNA_EXIT=$?
        if [ $ANTENNA_EXIT -eq 0 ]; then
            send_to_user "Daily briefing delivered — check your digest."
            log "Briefing: pipeline completed"
        else
            log "Briefing: antenna run failed (exit $ANTENNA_EXIT): ${ANTENNA_OUTPUT:0:200}"
            send_to_user "[Briefing failed — check logs at $LOG_FILE]"
        fi
    else
        # Fall back to Claude CLI if antenna binary not in PATH
        BRIEFING_RESPONSE=$(echo "/antenna" | timeout "$ANTENNA_TIMEOUT" "$CLAUDE_BIN" \
            --print \
            --dangerously-skip-permissions \
            --allowedTools "Read,Write,Bash,WebFetch" \
            --add-dir "$SKILLS_DIR" \
            ${SESSION_FLAG:-} 2>"$CLAUDE_ERR")
        BRIEFING_EXIT=$?

        if [ $BRIEFING_EXIT -eq 0 ] && [ -n "$BRIEFING_RESPONSE" ]; then
            send_to_user "$BRIEFING_RESPONSE"
            log "Briefing: sent via Claude direct (${#BRIEFING_RESPONSE} chars)"
        else
            log "Briefing: Claude failed (exit $BRIEFING_EXIT): $(tail -5 "$CLAUDE_ERR" 2>/dev/null)"
            send_to_user "[Briefing failed — check logs at $LOG_FILE]"
        fi
    fi

    echo "$CURRENT_DATE" > "$ANTENNA_MARKER"
    rm -f "$CLAUDE_ERR"
    exit 0
fi

# ── Message processing ───────────────────────────────────────────────────────

# Load last-processed timestamp (default: 10 minutes ago)
if [ -f "$STATE_FILE" ]; then
    LAST_TS=$(cat "$STATE_FILE")
else
    if [ "$OS" = "Darwin" ]; then
        LAST_TS=$(date -u -v-10M '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u '+%Y-%m-%dT%H:%M:%SZ')
    else
        LAST_TS=$(date -u -d '10 minutes ago' '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u '+%Y-%m-%dT%H:%M:%SZ')
    fi
fi

# Fallback timestamp (used if no messages found or on failures)
FALLBACK_TS=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

# Sync new messages
"$WACLI_BIN" sync --once --idle-exit 10s >> "$LOG_FILE" 2>&1

# Fetch messages from the authorized sender
MESSAGES=$("$WACLI_BIN" messages list --chat "$SENDER_ID" --after "$LAST_TS" --limit 20 --json 2>/dev/null)

if [ $? -ne 0 ] || [ -z "$MESSAGES" ]; then
    exit 0
fi

# Parse: filter to sender's messages, extract text + latest timestamp
PARSED=$(echo "$MESSAGES" | python3 - "$SENDER_PREFIX" <<'EOF'
import sys, json

prefix = sys.argv[1]
data = json.load(sys.stdin)
msgs = data.get('data', {}).get('messages', [])
filtered = [m for m in msgs if m.get('SenderJID', '').startswith(prefix) and m.get('Text')]
texts = '\n'.join(m['Text'] for m in reversed(filtered))
timestamps = [m['Timestamp'] for m in filtered if m.get('Timestamp')]
latest_ts = sorted(timestamps)[-1] if timestamps else ''
print(json.dumps({'texts': texts, 'latest_ts': latest_ts}))
EOF
)

# Decode both fields from PARSED in one python3 call; fields separated by a unique delimiter line
_PARSED_OUT=$(echo "$PARSED" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d.get('texts', ''))
print('---ANTENNA-TS---')
print(d.get('latest_ts', ''))
")
USER_MSGS=$(echo "$_PARSED_OUT" | sed -n '1,/^---ANTENNA-TS---$/{ /^---ANTENNA-TS---$/!p }')
LATEST_MSG_TS=$(echo "$_PARSED_OUT" | sed -n '/^---ANTENNA-TS---$/,$ { /^---ANTENNA-TS---$/!p }')

if [ -z "$USER_MSGS" ]; then
    echo "$FALLBACK_TS" > "$STATE_FILE"
    exit 0
fi

log "Polling after $LAST_TS — found messages"
log "Latest msg timestamp: $LATEST_MSG_TS"

# Compute next state timestamp (+1s to avoid reprocessing the latest message)
NEXT_STATE_TS=""
if [ -n "$LATEST_MSG_TS" ] && [ "$LATEST_MSG_TS" != "null" ]; then
    if [ "$OS" = "Darwin" ]; then
        EPOCH=$(date -u -jf '%Y-%m-%dT%H:%M:%SZ' "$LATEST_MSG_TS" '+%s' 2>/dev/null)
        [ -n "$EPOCH" ] && NEXT_STATE_TS=$(date -u -r "$((EPOCH + 1))" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)
    else
        NEXT_STATE_TS=$(date -u -d "$LATEST_MSG_TS + 1 second" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)
    fi
fi
[ -z "$NEXT_STATE_TS" ] && NEXT_STATE_TS="$FALLBACK_TS"

log "Next state timestamp: $NEXT_STATE_TS"

# ── Session management ───────────────────────────────────────────────────────

load_or_create_session "Message"
if [ -z "$SESSION_FLAG" ]; then
    log "Failed to generate session UUID"
    exit 1
fi

log "Processing: ${USER_MSGS:0:80}..."

# ── Long-task ack ────────────────────────────────────────────────────────────
# Send an immediate acknowledgement for requests that will take a while.

IS_LONG_TASK=false
# Skill commands or bare URLs (not quick-action keywords) get an immediate ack
if [[ "$USER_MSGS" =~ /(read-article|read-book|read-podcast|skill-creator|antenna|create-skill) ]] || \
   ( [[ "$USER_MSGS" =~ https?:// ]] && ! [[ "$USER_MSGS" =~ (to\ done|mark|delete|move) ]] ); then
    IS_LONG_TASK=true
fi

if [ "$IS_LONG_TASK" = true ]; then
    send_to_user "On it — this may take a few minutes."
    log "Sent long-task ack"
fi

# ── WhatsApp formatting system prompt ────────────────────────────────────────

WHATSAPP_FORMAT="You are responding via WhatsApp. Format ALL output for WhatsApp:
- NEVER use markdown tables (pipe characters), Unicode box tables, or any tabular format. WhatsApp screens are narrow — tables always break.
- NO markdown headers (# ## ###). Use *bold text* for section labels.
- Bold: *text* (WhatsApp native). Italic: _text_. Monospace: \`\`\`block\`\`\`.
- For structured data: use card-style lists. One block per item, bold name as header, details on same or next line.
- For simple key-value data: *Label:* value (one per line)
- Keep responses concise — this is mobile chat, not a document.
- Short paragraphs. Blank lines between sections. No walls of text."

# ── Claude invocation ────────────────────────────────────────────────────────

RESPONSE=$(echo "$USER_MSGS" | timeout "$MESSAGE_TIMEOUT" "$CLAUDE_BIN" \
    --print \
    --dangerously-skip-permissions \
    --allowedTools "Read,Write,Bash,WebFetch" \
    --add-dir "$SKILLS_DIR" \
    $SESSION_FLAG \
    --append-system-prompt "$WHATSAPP_FORMAT" \
    2>"$CLAUDE_ERR")
EXIT_CODE=$?

# ── Response handling ────────────────────────────────────────────────────────

# Timeout (exit code 124 from the timeout command)
if [ $EXIT_CODE -eq 124 ]; then
    log "Claude timed out after ${MESSAGE_TIMEOUT}s"
    send_to_user "[Request timed out after ${MESSAGE_TIMEOUT}s — please try again]"
    echo "$NEXT_STATE_TS" > "$STATE_FILE"
    echo 0 > "$FAIL_COUNT_FILE"
    rm -f "$CLAUDE_ERR"
    log "Done (timeout)"
    exit 0
fi

if [ $EXIT_CODE -eq 0 ] && [ -n "$RESPONSE" ]; then
    send_to_user "$RESPONSE"
    log "Sent response (${#RESPONSE} chars)"
    echo "$NEXT_STATE_TS" > "$STATE_FILE"
    echo 0 > "$FAIL_COUNT_FILE"
else
    log "Claude failed (exit $EXIT_CODE): $(tail -5 "$CLAUDE_ERR" 2>/dev/null)"

    # Session corruption check — reset so next run starts fresh
    if grep -qi "session\|resume\|invalid" "$CLAUDE_ERR" 2>/dev/null; then
        log "Session may be corrupted — resetting"
        rm -f "$SESSION_FILE"
    fi

    send_to_user "[Unavailable right now — try again in a moment]"

    # Poison message skip: after 3 consecutive failures, advance timestamp
    FAIL_COUNT=0
    [ -f "$FAIL_COUNT_FILE" ] && FAIL_COUNT=$(cat "$FAIL_COUNT_FILE")
    FAIL_COUNT=$((FAIL_COUNT + 1))
    echo "$FAIL_COUNT" > "$FAIL_COUNT_FILE"

    if [ "$FAIL_COUNT" -ge 3 ]; then
        log "3 consecutive failures — advancing timestamp to skip poison messages"
        echo "$NEXT_STATE_TS" > "$STATE_FILE"
        echo 0 > "$FAIL_COUNT_FILE"
    fi
fi

rm -f "$CLAUDE_ERR"
log "Done"
