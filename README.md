# Open Antenna

Daily intelligence briefing, delivered to your phone. Open Antenna scans YouTube channels and Hacker News, filters for what matters to you, processes everything through Claude, and sends a PDF digest via WhatsApp or email — automatically, every morning.

Optionally: a two-way WhatsApp AI assistant. Send URLs, questions, or commands from WhatsApp and get Claude-powered replies back.

---

## Quick Start

```bash
npm install -g open-antenna
antenna init
```

`antenna init` handles everything in one terminal session: dependency checks, WhatsApp auth, email setup, source configuration, profile setup, and cron scheduling.

**Prerequisites:**
- Node.js 18+
- [Claude Code CLI](https://claude.ai/code)
- Python 3
- A WhatsApp account (for WhatsApp delivery or the bridge)

---

## Commands

| Command | Description |
|---------|-------------|
| `antenna init` | Full setup wizard — run once to configure everything |
| `antenna run` | Generate today's digest and send it |
| `antenna run --no-notify` | Generate digest without sending |
| `antenna run --no-pdf` | Output markdown instead of PDF |
| `antenna test-notify` | Send a test through configured channels |
| `antenna schedule` | View the current cron schedule |
| `antenna schedule --time 08:00 --timezone Europe/Berlin` | Update the schedule |
| `antenna skills` | List installed skills |
| `antenna skills --detail` | Show descriptions |
| `antenna create-skill "<description>"` | Create a new skill from plain language |
| `antenna bridge start` | Start the two-way WhatsApp assistant |
| `antenna bridge stop` | Stop the bridge daemon |
| `antenna bridge status` | Check if the bridge is running |
| `antenna bridge logs` | Tail the bridge log |

---

## Config Format

Config lives in `./config.yaml`. Created by `antenna init`, editable directly.

```yaml
# Sources to scan
sources:
  youtube:
    enabled: true
    channels:
      - handle: "@allin"
        label: "All-In Podcast"
      - handle: "@LennysPodcast"
        label: "Lenny's Podcast"
    max_age_hours: 24
    exclude_shorts: true

  hackernews:
    enabled: true
    top_n: 20
    min_score: 50

# About you — personalizes filtering and digest tone
profile:
  name: "Marcus"
  role: "VP Engineering"
  topics:
    - AI
    - developer tools
    - cloud infrastructure

# AI processing
processing:
  relevance_filter: "useful for a VP Engineering interested in AI and developer tools"
  claude_model: "sonnet"

# Output
output:
  dir: "./output"
  format: "pdf"            # pdf or markdown

# Notifications
notifications:
  whatsapp:
    enabled: true
    recipient: "+1234567890"

  email:
    enabled: false
    smtp_host: "smtp.gmail.com"
    smtp_port: 587
    smtp_user: "you@gmail.com"
    smtp_pass_env: "ANTENNA_SMTP_PASS"   # env var holding your SMTP password
    to: "you@gmail.com"
    subject_prefix: "[Daily Intel]"

# WhatsApp Bridge (two-way AI assistant)
bridge:
  enabled: false
  sender_id: ""              # WhatsApp internal ID of the authorized sender
  poll_interval: 30          # seconds between polls
  message_timeout: 600
  antenna_timeout: 900

# Schedule
schedule:
  time: "07:00"
  timezone: "America/New_York"
```

**SMTP password:** Never stored in config.yaml. Set an environment variable (`ANTENNA_SMTP_PASS` by default) and point `smtp_pass_env` to its name.

---

## Adding Custom Skills

Skills are plain `.md` files in the `skills/` directory. Claude reads them at runtime — no restart required.

### Create a skill from plain language

```bash
antenna create-skill "summarize Slack threads from #engineering"
antenna create-skill "weekly digest from Linear tickets assigned to me"
antenna create-skill "top posts from r/MachineLearning"
```

Claude will research the implementation, ask for any credentials, generate the SKILL.md, test it, and install it. The skill is available immediately.

### Edit existing skills

Skills are in `skills/{name}/SKILL.md`. Open in any editor, save, and the next run picks up changes.

### List skills

```bash
antenna skills           # names only
antenna skills --detail  # with descriptions
```

### Use a skill via WhatsApp (bridge required)

Once the bridge is running, send a WhatsApp message like:
```
/slack-digest
summarize this article: https://...
```

---

## WhatsApp Bridge — Two-Way AI Assistant

The bridge is a daemon that polls WhatsApp every 30 seconds, pipes messages to Claude, and replies back. It's a full AI assistant accessible from your phone.

### Setup

```bash
antenna init   # sets up bridge during initial setup
# or
antenna bridge start
```

The bridge runs as a system daemon:
- **macOS**: launchd (`~/Library/LaunchAgents/io.open-antenna.bridge.plist`)
- **Linux**: systemd user service (`~/.config/systemd/user/open-antenna-bridge.*`)

### Features

- Persistent session — context preserved across messages
- Long-task acknowledgment — sends "On it..." immediately for slow requests
- Poison message skip — after 3 consecutive failures, advances past the bad message
- Session recovery — detects corrupted sessions and resets automatically
- Log rotation at 1MB
- Lock file prevents overlapping runs

### Commands

```bash
antenna bridge start    # install and start daemon
antenna bridge stop     # stop daemon
antenna bridge status   # check if running
antenna bridge logs     # tail bridge.log (Ctrl+C to stop)
antenna bridge logs -n 100   # show last 100 lines
```

---

## Scheduling

`antenna init` installs a cron job for daily runs. To change the schedule:

```bash
antenna schedule                                    # view current
antenna schedule --time 08:30                       # update time
antenna schedule --time 08:30 --timezone US/Pacific # update time + timezone
```

Logs for cron runs go to `~/.antenna/cron.log`.

---

## Requirements

| Dependency | Purpose | Install |
|-----------|---------|---------|
| Node.js 18+ | Runtime | [nodejs.org](https://nodejs.org) |
| Claude Code CLI | AI processing | [claude.ai/code](https://claude.ai/code) |
| Python 3 | YouTube + HN scanners | `brew install python3` or [python.org](https://python.org) |
| wacli | WhatsApp CLI | Auto-installed by `antenna init` |

Python packages (`requests`, `feedparser`) are installed automatically by `antenna init`.

---

## Troubleshooting

**Digest file not generated**
- Check Claude is in your PATH: `which claude`
- Run `antenna run` manually and look at the output
- Check `~/.antenna/cron.log` for scheduled run errors

**WhatsApp not receiving**
- Run `antenna test-notify` to test the channel
- Verify wacli is authenticated: `wacli status`
- Check recipient phone number format (`+` prefix required)

**Bridge not responding**
- `antenna bridge status` — is it running?
- `antenna bridge logs` — check for errors
- Restart: `antenna bridge stop && antenna bridge start`

**Email not sending**
- Verify the env var is set: `echo $ANTENNA_SMTP_PASS`
- For Gmail: use an App Password (not your account password). [How to generate one](https://support.google.com/accounts/answer/185833)

---

## License

MIT
