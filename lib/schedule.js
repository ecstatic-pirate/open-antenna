'use strict';

/**
 * antenna schedule — view or update the daily cron schedule.
 *
 * Without flags: show current schedule.
 * With --time / --timezone: update the cron job.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { loadConfig } = require('./config');
const yaml = require('js-yaml');

// Dedup marker — all managed cron lines carry this suffix
const ANTENNA_CRON_MARKER = '# open-antenna-managed';

/**
 * Read current crontab lines. Returns [] if no crontab is set.
 */
function readCrontab() {
  const result = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  return result.stdout.split('\n');
}

/**
 * Find the antenna cron line (if any).
 */
function findAntennaLine(lines) {
  return lines.find((l) => l.includes(ANTENNA_CRON_MARKER)) || null;
}

/**
 * Parse a cron line and return { min, hour, timezone, command } or null.
 */
function parseCronLine(line) {
  if (!line) return null;
  const match = line.match(/^(\d+)\s+(\d+)\s+\*\s+\*\s+\*\s+(.*)/);
  if (!match) return null;
  const [, min, hour, rest] = match;
  const tzMatch = rest.match(/TZ="([^"]+)"/);
  return {
    min: parseInt(min, 10),
    hour: parseInt(hour, 10),
    timezone: tzMatch ? tzMatch[1] : 'system default',
    command: rest,
  };
}

/**
 * Format cron time as HH:MM.
 */
function formatTime(hour, min) {
  return `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * Validate a time string (HH:MM, 24h). Returns true if valid.
 */
function isValidTime(time) {
  if (!/^\d{1,2}:\d{2}$/.test(time)) return false;
  const [h, m] = time.split(':').map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

/**
 * Validate a timezone string using Intl (Node 18+).
 * Falls back gracefully if supportedValuesOf is unavailable.
 */
function isValidTimezone(tz) {
  try {
    if (typeof Intl.supportedValuesOf === 'function') {
      return Intl.supportedValuesOf('timeZone').includes(tz);
    }
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a new cron line for antenna.
 * Paths are quoted. Line ends with the dedup marker.
 */
function buildCronLine(time, timezone, configPath) {
  const [hourStr, minStr] = time.split(':');
  const hour = parseInt(hourStr, 10);
  const min = parseInt(minStr || '0', 10);

  const logPath = path.join(os.homedir(), '.antenna', 'cron.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  return `${min} ${hour} * * * TZ="${timezone}" antenna run --config "${configPath}" >> "${logPath}" 2>&1 ${ANTENNA_CRON_MARKER}`;
}

/**
 * Write updated crontab (replaces existing antenna lines).
 * Exported as _writeCrontab so init.js can reuse it.
 */
function _writeCrontab(newLine) {
  const existing = readCrontab();
  const filtered = existing
    .filter((l) => !l.includes(ANTENNA_CRON_MARKER))
    .join('\n')
    .trim();

  const newCrontab = (filtered ? filtered + '\n' : '') + newLine + '\n';

  const result = spawnSync('crontab', ['-'], {
    input: newCrontab,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(`crontab write failed: ${result.stderr?.trim()}`);
  }
}

/**
 * Update schedule in config.yaml.
 */
function updateConfigSchedule(configPath, time, timezone) {
  const raw = fs.readFileSync(configPath, 'utf8');
  const config = yaml.load(raw) || {};
  config.schedule = { time, timezone };

  // Preserve header comment if present
  const headerMatch = raw.match(/^(#.*\n)+/);
  const header = headerMatch ? headerMatch[0] : '';
  fs.writeFileSync(configPath, header + yaml.dump(config, { lineWidth: -1 }), 'utf8');
}

// ── Public API ─────────────────────────────────────────────────────────────────

async function schedule(options = {}) {
  const configPath = path.resolve(options.config || './config.yaml');

  // Show current schedule
  if (!options.time && !options.timezone) {
    console.log('\nCurrent schedule:\n');

    // From crontab
    const lines = readCrontab();
    const antennaLine = findAntennaLine(lines);

    if (antennaLine) {
      const parsed = parseCronLine(antennaLine);
      if (parsed) {
        console.log(`  Cron:     ${formatTime(parsed.hour, parsed.min)} daily`);
        console.log(`  Timezone: ${parsed.timezone}`);
        console.log(`  Cron line:\n    ${antennaLine}`);
      } else {
        console.log(`  Cron line (could not parse): ${antennaLine}`);
      }
    } else {
      console.log('  No cron job found for antenna.');
      console.log('  Run `antenna init` to set one up, or use `antenna schedule --time 07:00`.');
    }

    // Also show config.yaml schedule if available
    if (fs.existsSync(configPath)) {
      try {
        const config = loadConfig(configPath);
        if (config.schedule) {
          console.log(`\n  Config (config.yaml):`);
          console.log(`    time: ${config.schedule.time}`);
          console.log(`    timezone: ${config.schedule.timezone}`);
        }
      } catch {
        // Non-fatal
      }
    }

    console.log('');
    console.log('  To update: antenna schedule --time 08:00 --timezone America/Chicago');
    return;
  }

  // Update schedule — validate inputs first
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}\nRun 'antenna init' first.`);
  }

  const config = loadConfig(configPath);
  const time = options.time || config.schedule?.time || '07:00';
  const timezone = options.timezone || config.schedule?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';

  if (!isValidTime(time)) {
    throw new Error(`Invalid time "${time}". Use HH:MM format with hour 0-23 and minute 0-59.`);
  }
  if (!isValidTimezone(timezone)) {
    throw new Error(`Invalid timezone "${timezone}". Use an IANA timezone name (e.g. America/New_York).`);
  }

  const cronLine = buildCronLine(time, timezone, configPath);
  _writeCrontab(cronLine);
  updateConfigSchedule(configPath, time, timezone);

  console.log(`\n✓ Schedule updated: daily at ${time} ${timezone}`);
  console.log(`  Cron: ${cronLine}`);
}

module.exports = schedule;
module.exports._writeCrontab = _writeCrontab;
module.exports.buildCronLine = buildCronLine;
