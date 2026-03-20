#!/bin/bash
# Open Antenna — Email Bridge
#
# Two-way email daemon:
#   - Polls an IMAP inbox for new (unseen) messages every POLL_INTERVAL seconds
#   - Pipes message subject + body to Claude Code CLI with bundled antenna skills
#   - Sends Claude's response as an email to the configured reply_to address
#   - Shares the same Claude session as the WhatsApp bridge
#
# Resilience features:
#   - Lock file (kernel-level, no PID reuse risk)
#   - Configurable timeout per message (default 600s)
#   - Poison message skip: after 3 consecutive Claude failures, marks message as seen
#   - Session recovery: detects corrupted Claude sessions, auto-resets
#   - Log rotation at 1MB
#
# Usage: Run by the daemon manager (launchd / systemd).
#        Reads config from ANTENNA_CONFIG (env var, default: ./config.yaml)
#        State files stored in ANTENNA_DATA_DIR (env var, default: ~/.antenna)

set -euo pipefail

# ── Config resolution ─────────────────────────────────────────────────────────

CONFIG_FILE="${ANTENNA_CONFIG:-./config.yaml}"
DATA_DIR="${ANTENNA_DATA_DIR:-$HOME/.antenna}"

if [ ! -f "$CONFIG_FILE" ]; then
    echo "ERROR: config file not found: $CONFIG_FILE" >&2
    exit 1
fi

# ── Parse config.yaml with python3 ───────────────────────────────────────────

_CONFIG_VALS=$(python3 - "$CONFIG_FILE" <<'PYEOF'
import sys, re

def parse_simple_yaml(path):
    """Minimal YAML parser: handles flat and two-level nested keys."""
    data = {}
    current_section = None
    current_subsection = None
    with open(path) as f:
        for line in f:
            line = re.sub(r'\s*#.*$', '', line).rstrip()
            if not line:
                continue
            # Top-level key with no value (section header)
            m = re.match(r'^(\w[\w\-]*)\s*:\s*$', line)
            if m:
                current_section = m.group(1)
                data[current_section] = {}
                current_subsection = None
                continue
            # Two-space indent: could be subsection or value
            m = re.match(r'^  (\w[\w\-_]*)\s*:\s*$', line)
            if m and current_section:
                current_subsection = m.group(1)
                data[current_section][current_subsection] = {}
                continue
            # Four-space indent: value under subsection
            m = re.match(r'^    (\w[\w\-_]*)\s*:\s*(.+)$', line)
            if m and current_section and current_subsection:
                val = m.group(2).strip().strip('"').strip("'")
                data[current_section][current_subsection][m.group(1)] = val
                continue
            # Two-space indent: value under section
            m = re.match(r'^\s{2,}(\w[\w\-_]*)\s*:\s*(.*)$', line)
            if m and current_section:
                val = m.group(2).strip().strip('"').strip("'")
                if current_subsection and isinstance(data[current_section].get(current_subsection), dict):
                    data[current_section][current_subsection][m.group(1)] = val
                else:
                    data[current_section][m.group(1)] = val
                continue
            # Top-level key with value
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
print(get(data, 'bridge.email.imap_host', ''))
print(get(data, 'bridge.email.imap_port', '993'))
print(get(data, 'bridge.email.imap_user', ''))
print(get(data, 'bridge.email.imap_pass_env', ''))
print(get(data, 'bridge.email.folder', 'INBOX'))
print(get(data, 'bridge.email.poll_interval', '60'))
print(get(data, 'bridge.email.message_timeout', '600'))
print(get(data, 'bridge.email.reply_to', ''))
print(get(data, 'bridge.email.smtp_host', ''))
print(get(data, 'bridge.email.smtp_port', '587'))
print(get(data, 'bridge.email.smtp_user', ''))
print(get(data, 'bridge.email.smtp_pass_env', ''))
PYEOF
)
IMAP_HOST=$(echo "$_CONFIG_VALS"        | sed -n '1p')
IMAP_PORT=$(echo "$_CONFIG_VALS"        | sed -n '2p')
IMAP_USER=$(echo "$_CONFIG_VALS"        | sed -n '3p')
IMAP_PASS_ENV=$(echo "$_CONFIG_VALS"    | sed -n '4p')
IMAP_FOLDER=$(echo "$_CONFIG_VALS"      | sed -n '5p')
POLL_INTERVAL=$(echo "$_CONFIG_VALS"    | sed -n '6p')
MESSAGE_TIMEOUT=$(echo "$_CONFIG_VALS"  | sed -n '7p')
REPLY_TO=$(echo "$_CONFIG_VALS"         | sed -n '8p')
SMTP_HOST=$(echo "$_CONFIG_VALS"        | sed -n '9p')
SMTP_PORT=$(echo "$_CONFIG_VALS"        | sed -n '10p')
SMTP_USER=$(echo "$_CONFIG_VALS"        | sed -n '11p')
SMTP_PASS_ENV=$(echo "$_CONFIG_VALS"    | sed -n '12p')

if [ -z "$IMAP_HOST" ] || [ -z "$IMAP_USER" ]; then
    echo "ERROR: bridge.email.imap_host and imap_user must be set in $CONFIG_FILE" >&2
    exit 1
fi

if [ -z "$IMAP_PASS_ENV" ]; then
    echo "ERROR: bridge.email.imap_pass_env must be set in $CONFIG_FILE" >&2
    exit 1
fi

IMAP_PASS="${!IMAP_PASS_ENV:-}"
if [ -z "$IMAP_PASS" ]; then
    echo "ERROR: env var '$IMAP_PASS_ENV' is not set (IMAP password)" >&2
    exit 1
fi

# SMTP password (for sending replies)
SMTP_PASS=""
if [ -n "$SMTP_PASS_ENV" ]; then
    SMTP_PASS="${!SMTP_PASS_ENV:-}"
fi

# ── Paths ─────────────────────────────────────────────────────────────────────

mkdir -p "$DATA_DIR"

SESSION_FILE="$DATA_DIR/bridge-session"
LOCK_FILE="$DATA_DIR/email-bridge.lock"
FAIL_COUNT_FILE="$DATA_DIR/email-bridge-fails"
LOG_FILE="$DATA_DIR/email-bridge.log"
CLAUDE_ERR="$DATA_DIR/email-bridge-claude-err"

# ── Binary resolution ─────────────────────────────────────────────────────────

OS=$(uname -s)

# Claude Code CLI
CLAUDE_BIN=$(which claude 2>/dev/null || echo "$HOME/.local/bin/claude")
if [ ! -f "$CLAUDE_BIN" ] && ! which claude >/dev/null 2>&1; then
    echo "ERROR: Claude Code CLI not found. Install from https://claude.ai/code" >&2
    exit 1
fi

# Skills dir — bundled with the package
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(dirname "$SCRIPT_DIR")"
SKILLS_DIR="$PKG_DIR/skills"

# ── Helpers ───────────────────────────────────────────────────────────────────

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG_FILE"
}

generate_uuid() {
    uuidgen 2>/dev/null | tr '[:upper:]' '[:lower:]' || python3 -c "import uuid; print(uuid.uuid4())"
}

# load_or_create_session <label>
# Sets SESSION_FLAG. Uses the SHARED session file (same as WhatsApp bridge).
# Atomic write via temp file + mv to avoid race with WhatsApp bridge.
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
            local tmpfile
            tmpfile=$(mktemp "$DATA_DIR/bridge-session.XXXXXX")
            echo "$session_id" > "$tmpfile"
            mv "$tmpfile" "$SESSION_FILE"  # atomic on same filesystem
            SESSION_FLAG="--session-id $session_id"
            log "$label: created session $session_id"
        fi
    fi
}

# send_email_reply <subject> <body>
# Sends an email reply via SMTP using python3 + smtplib.
# Credentials passed via env vars (not argv) to avoid ps visibility.
send_email_reply() {
    local subject="$1"
    local body="$2"

    _ANTENNA_SMTP_HOST="$SMTP_HOST" \
    _ANTENNA_SMTP_PORT="$SMTP_PORT" \
    _ANTENNA_SMTP_USER="$SMTP_USER" \
    _ANTENNA_SMTP_PASS="$SMTP_PASS" \
    _ANTENNA_REPLY_TO="$REPLY_TO" \
    _ANTENNA_SUBJECT="$subject" \
    _ANTENNA_BODY="$body" \
    python3 - <<'PYEOF'
import os, smtplib
from email.mime.text import MIMEText

smtp_host = os.environ['_ANTENNA_SMTP_HOST']
smtp_port = int(os.environ['_ANTENNA_SMTP_PORT'])
smtp_user = os.environ['_ANTENNA_SMTP_USER']
smtp_pass = os.environ['_ANTENNA_SMTP_PASS']
reply_to = os.environ['_ANTENNA_REPLY_TO']
subject = os.environ['_ANTENNA_SUBJECT']
body = os.environ['_ANTENNA_BODY']

msg = MIMEText(body, 'plain', 'utf-8')
msg['From'] = smtp_user
msg['To'] = reply_to
msg['Subject'] = f"Re: {subject}"

if smtp_port == 465:
    server = smtplib.SMTP_SSL(smtp_host, smtp_port)
else:
    server = smtplib.SMTP(smtp_host, smtp_port)
    server.starttls()

server.login(smtp_user, smtp_pass)
server.sendmail(smtp_user, [reply_to], msg.as_string())
server.quit()
PYEOF
}

# fetch_unseen_emails
# Returns JSON array of unseen emails: [{uid, subject, body, from}, ...]
# Uses IMAP UID commands (not sequence numbers) for concurrent-access safety.
# Credentials passed via env vars to avoid ps visibility.
fetch_unseen_emails() {
    _ANTENNA_IMAP_HOST="$IMAP_HOST" \
    _ANTENNA_IMAP_PORT="$IMAP_PORT" \
    _ANTENNA_IMAP_USER="$IMAP_USER" \
    _ANTENNA_IMAP_PASS="$IMAP_PASS" \
    _ANTENNA_IMAP_FOLDER="$IMAP_FOLDER" \
    python3 - <<'PYEOF'
import os, imaplib, email, json
from email.header import decode_header

imap_host = os.environ['_ANTENNA_IMAP_HOST']
imap_port = int(os.environ['_ANTENNA_IMAP_PORT'])
imap_user = os.environ['_ANTENNA_IMAP_USER']
imap_pass = os.environ['_ANTENNA_IMAP_PASS']
folder = os.environ['_ANTENNA_IMAP_FOLDER']

try:
    mail = imaplib.IMAP4_SSL(imap_host, imap_port)
    mail.login(imap_user, imap_pass)
    mail.select(folder)

    # Use UID SEARCH (not SEARCH) — UIDs are stable across concurrent access
    status, data = mail.uid('search', None, 'UNSEEN')
    if status != 'OK' or not data[0]:
        print('[]')
        mail.logout()
        exit(0)

    uids = data[0].split()
    # Limit to 10 messages per poll to avoid overload
    uids = uids[:10]

    results = []
    for uid in uids:
        # Use UID FETCH (not FETCH) — matches UID SEARCH results
        status, msg_data = mail.uid('fetch', uid, '(RFC822)')
        if status != 'OK':
            continue

        raw_email = msg_data[0][1]
        msg = email.message_from_bytes(raw_email)

        # Decode subject
        subject_parts = decode_header(msg['Subject'] or '')
        subject = ''
        for part, charset in subject_parts:
            if isinstance(part, bytes):
                subject += part.decode(charset or 'utf-8', errors='replace')
            else:
                subject += part

        # Get sender
        sender = msg.get('From', '')

        # Extract body (plain text preferred)
        body = ''
        if msg.is_multipart():
            for part in msg.walk():
                content_type = part.get_content_type()
                if content_type == 'text/plain':
                    charset = part.get_content_charset() or 'utf-8'
                    body = part.get_payload(decode=True).decode(charset, errors='replace')
                    break
        else:
            charset = msg.get_content_charset() or 'utf-8'
            body = msg.get_payload(decode=True).decode(charset, errors='replace')

        results.append({
            'uid': uid.decode(),
            'subject': subject.strip(),
            'body': body.strip()[:5000],  # Cap at 5000 chars
            'from': sender
        })

    mail.logout()
    print(json.dumps(results))
except Exception as e:
    print('[]', file=sys.stdout)
    print(f'IMAP error: {e}', file=sys.stderr)
    exit(1)
PYEOF
}

# mark_as_seen <uid>
# Marks a specific email as seen (read) in IMAP using UID STORE.
# Returns 0 on success, 1 on failure.
mark_as_seen() {
    local uid="$1"
    _ANTENNA_IMAP_HOST="$IMAP_HOST" \
    _ANTENNA_IMAP_PORT="$IMAP_PORT" \
    _ANTENNA_IMAP_USER="$IMAP_USER" \
    _ANTENNA_IMAP_PASS="$IMAP_PASS" \
    _ANTENNA_IMAP_FOLDER="$IMAP_FOLDER" \
    _ANTENNA_UID="$uid" \
    python3 - <<'PYEOF'
import os, imaplib

imap_host = os.environ['_ANTENNA_IMAP_HOST']
imap_port = int(os.environ['_ANTENNA_IMAP_PORT'])
imap_user = os.environ['_ANTENNA_IMAP_USER']
imap_pass = os.environ['_ANTENNA_IMAP_PASS']
folder = os.environ['_ANTENNA_IMAP_FOLDER']
uid = os.environ['_ANTENNA_UID']

try:
    mail = imaplib.IMAP4_SSL(imap_host, imap_port)
    mail.login(imap_user, imap_pass)
    mail.select(folder)
    # Use UID STORE (not STORE) — matches UID from UID SEARCH
    mail.uid('store', uid, '+FLAGS', '\\Seen')
    mail.logout()
except Exception as e:
    print(f'mark_as_seen error: {e}', file=__import__("sys").stderr)
    exit(1)
PYEOF
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

if [ -z "${ANTENNA_EMAIL_BRIDGE_LOCKED:-}" ]; then
    export ANTENNA_EMAIL_BRIDGE_LOCKED=1
    if [ "$OS" = "Darwin" ]; then
        exec /usr/bin/lockf -t 0 "$LOCK_FILE" "$0" "$@"
    else
        exec flock -n "$LOCK_FILE" "$0" "$@"
    fi
fi

# ── Fetch unseen emails ─────────────────────────────────────────────────────

log "Polling IMAP ${IMAP_USER}@${IMAP_HOST}:${IMAP_FOLDER}"

EMAILS=$(fetch_unseen_emails 2>>"$LOG_FILE")

if [ -z "$EMAILS" ] || [ "$EMAILS" = "[]" ]; then
    log "No unseen emails"
    exit 0
fi

# Parse email count
EMAIL_COUNT=$(echo "$EMAILS" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")

if [ "$EMAIL_COUNT" -eq 0 ]; then
    log "No unseen emails"
    exit 0
fi

log "Found $EMAIL_COUNT unseen email(s)"

# ── Session management ───────────────────────────────────────────────────────

load_or_create_session "Email"
if [ -z "$SESSION_FLAG" ]; then
    log "Failed to generate session UUID"
    exit 1
fi

# ── Email formatting system prompt ───────────────────────────────────────────

EMAIL_FORMAT="You are responding via email. Format ALL output for email:
- Use clean, readable plain text formatting.
- Use blank lines between paragraphs for readability.
- For lists, use simple dashes (- item) or numbers (1. item).
- For emphasis, use CAPS sparingly or *asterisks* for key terms.
- Keep responses focused and well-structured.
- No HTML tags. No markdown headers (# ##). Plain text only.
- Sign off naturally — no 'Best regards' or corporate signatures."

# ── Process each email ──────────────────────────────────────────────────────

echo "$EMAILS" | python3 -c "
import sys, json
emails = json.load(sys.stdin)
for i, e in enumerate(emails):
    print(f\"---EMAIL-DELIM-{i}---\")
    print(json.dumps(e))
" | while IFS= read -r line; do
    # Skip delimiter lines, capture email JSON
    if [[ "$line" == ---EMAIL-DELIM-* ]]; then
        continue
    fi

    # Parse this email
    EMAIL_UID=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['uid'])")
    EMAIL_SUBJECT=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['subject'])")
    EMAIL_BODY=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['body'])")
    EMAIL_FROM=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['from'])")

    log "Processing email UID=$EMAIL_UID from=$EMAIL_FROM subject='${EMAIL_SUBJECT:0:60}'"

    # Compose the message for Claude: subject + body
    USER_MSG="[Email from: $EMAIL_FROM]
Subject: $EMAIL_SUBJECT

$EMAIL_BODY"

    # ── Claude invocation ────────────────────────────────────────────────────

    RESPONSE=$(echo "$USER_MSG" | timeout "$MESSAGE_TIMEOUT" "$CLAUDE_BIN" \
        --print \
        --dangerously-skip-permissions \
        --allowedTools "Read,Write,Bash,WebFetch" \
        --add-dir "$SKILLS_DIR" \
        $SESSION_FLAG \
        --append-system-prompt "$EMAIL_FORMAT" \
        2>"$CLAUDE_ERR")
    EXIT_CODE=$?

    # ── Response handling ────────────────────────────────────────────────────

    # Timeout
    if [ $EXIT_CODE -eq 124 ]; then
        log "Claude timed out after ${MESSAGE_TIMEOUT}s for UID=$EMAIL_UID"
        mark_as_seen "$EMAIL_UID" 2>>"$LOG_FILE" || log "WARNING: mark_as_seen failed for UID=$EMAIL_UID"
        echo 0 > "$FAIL_COUNT_FILE"
        rm -f "$CLAUDE_ERR"
        continue
    fi

    if [ $EXIT_CODE -eq 0 ] && [ -n "$RESPONSE" ]; then
        # Send reply email
        if [ -n "$SMTP_HOST" ] && [ -n "$SMTP_USER" ] && [ -n "$SMTP_PASS" ]; then
            send_email_reply "$EMAIL_SUBJECT" "$RESPONSE" 2>>"$LOG_FILE"
            if [ $? -eq 0 ]; then
                log "Sent reply for UID=$EMAIL_UID (${#RESPONSE} chars) to $REPLY_TO"
            else
                log "Failed to send reply email for UID=$EMAIL_UID"
            fi
        else
            log "SMTP not configured — response generated but not sent (${#RESPONSE} chars)"
        fi

        if ! mark_as_seen "$EMAIL_UID" 2>>"$LOG_FILE"; then
            log "WARNING: mark_as_seen failed for UID=$EMAIL_UID — may be reprocessed"
        fi
        echo 0 > "$FAIL_COUNT_FILE"
    else
        log "Claude failed (exit $EXIT_CODE) for UID=$EMAIL_UID: $(tail -5 "$CLAUDE_ERR" 2>/dev/null)"

        # Session corruption check
        if grep -qi "session\|resume\|invalid" "$CLAUDE_ERR" 2>/dev/null; then
            log "Session may be corrupted — resetting"
            rm -f "$SESSION_FILE"
        fi

        # Poison message skip: after 3 consecutive failures, mark as seen and move on
        FAIL_COUNT=0
        [ -f "$FAIL_COUNT_FILE" ] && FAIL_COUNT=$(cat "$FAIL_COUNT_FILE")
        FAIL_COUNT=$((FAIL_COUNT + 1))
        echo "$FAIL_COUNT" > "$FAIL_COUNT_FILE"

        if [ "$FAIL_COUNT" -ge 3 ]; then
            log "3 consecutive failures — marking UID=$EMAIL_UID as seen to skip"
            mark_as_seen "$EMAIL_UID" 2>>"$LOG_FILE"
            echo 0 > "$FAIL_COUNT_FILE"
        fi
    fi

    rm -f "$CLAUDE_ERR"
done

log "Done"
