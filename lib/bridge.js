'use strict';

/**
 * antenna bridge — daemon management for the WhatsApp bridge.
 *
 * Supports:
 *   start   — install and start the daemon (launchd on macOS, systemd on Linux)
 *   stop    — stop and unload the daemon
 *   status  — check if the daemon is running
 *   logs    — tail the bridge log file
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn, execFileSync } = require('child_process');
const yaml = require('js-yaml');

const PKG_ROOT = path.join(__dirname, '..');
const BRIDGE_DIR = path.join(PKG_ROOT, 'bridge');
const BRIDGE_SCRIPT = path.join(BRIDGE_DIR, 'whatsapp-bridge.sh');

const LAUNCHD_LABEL = 'io.open-antenna.bridge';
const LAUNCHD_PLIST_PATH = path.join(
  os.homedir(),
  'Library',
  'LaunchAgents',
  `${LAUNCHD_LABEL}.plist`
);

const SYSTEMD_SERVICE_NAME = 'open-antenna-bridge';
const SYSTEMD_UNIT_DIR = path.join(
  os.homedir(),
  '.config',
  'systemd',
  'user'
);

/**
 * Load config.yaml from the given path.
 */
function loadConfig(configPath) {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Config file not found: ${resolved}\nRun 'antenna init' to create one.`);
  }
  return yaml.load(fs.readFileSync(resolved, 'utf8'));
}

/**
 * Detect the host platform.
 * @returns {'macos' | 'linux' | 'unsupported'}
 */
function detectPlatform() {
  const platform = process.platform;
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  return 'unsupported';
}

/**
 * Render a template file by replacing {{PLACEHOLDER}} tokens.
 */
function renderTemplate(templatePath, vars) {
  let content = fs.readFileSync(templatePath, 'utf8');
  for (const [key, value] of Object.entries(vars)) {
    content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return content;
}

/**
 * Resolve the data directory (default: ~/.antenna).
 */
function dataDir() {
  return path.join(os.homedir(), '.antenna');
}

/**
 * Build the template vars used for both launchd and systemd.
 */
function buildTemplateVars(configPath, pollInterval) {
  return {
    BRIDGE_SCRIPT,
    CONFIG_PATH: path.resolve(configPath),
    DATA_DIR: dataDir(),
    POLL_INTERVAL: String(pollInterval ?? 30),
    // Preserve common binary paths so the daemon finds node, python, wacli, claude
    PATH_VALUE: [
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      `${os.homedir()}/.local/bin`,
      `${os.homedir()}/.nvm/versions/node/current/bin`,
    ].join(':'),
  };
}

// ── macOS launchd ─────────────────────────────────────────────────────────────

function launchdStart(configPath, config) {
  const pollInterval = config.bridge?.poll_interval ?? 30;
  const vars = buildTemplateVars(configPath, pollInterval);

  const templatePath = path.join(BRIDGE_DIR, 'launchd.plist.template');
  const rendered = renderTemplate(templatePath, vars);

  // Ensure LaunchAgents directory exists
  const agentsDir = path.dirname(LAUNCHD_PLIST_PATH);
  fs.mkdirSync(agentsDir, { recursive: true });

  // Unload any existing instance before writing new plist
  spawnSync('launchctl', ['unload', LAUNCHD_PLIST_PATH], { encoding: 'utf8' });

  fs.writeFileSync(LAUNCHD_PLIST_PATH, rendered, 'utf8');
  console.log(`[bridge] Plist written: ${LAUNCHD_PLIST_PATH}`);

  const result = spawnSync('launchctl', ['load', '-w', LAUNCHD_PLIST_PATH], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`launchctl load failed: ${result.stderr?.trim()}`);
  }

  console.log('[bridge] Bridge daemon started (launchd).');
  console.log(`[bridge] Logs: ${path.join(dataDir(), 'bridge.log')}`);
}

function launchdStop() {
  if (!fs.existsSync(LAUNCHD_PLIST_PATH)) {
    console.log('[bridge] No plist found — daemon is not installed.');
    return;
  }
  const result = spawnSync('launchctl', ['unload', '-w', LAUNCHD_PLIST_PATH], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.warn(`[bridge] launchctl unload warning: ${result.stderr?.trim()}`);
  }
  console.log('[bridge] Bridge daemon stopped.');
}

function launchdStatus() {
  const result = spawnSync('launchctl', ['list', LAUNCHD_LABEL], { encoding: 'utf8' });
  if (result.status === 0) {
    console.log('[bridge] Running (launchd)');
    // Print PID if available
    const pidMatch = result.stdout.match(/"PID"\s*=\s*(\d+)/);
    if (pidMatch) console.log(`[bridge] PID: ${pidMatch[1]}`);
  } else {
    console.log('[bridge] Not running');
    if (!fs.existsSync(LAUNCHD_PLIST_PATH)) {
      console.log('[bridge] Not installed — run: antenna bridge start');
    }
  }
}

// ── Linux systemd ─────────────────────────────────────────────────────────────

function systemdStart(configPath, config) {
  const pollInterval = config.bridge?.poll_interval ?? 30;
  const vars = buildTemplateVars(configPath, pollInterval);

  fs.mkdirSync(SYSTEMD_UNIT_DIR, { recursive: true });

  const serviceSrc = path.join(BRIDGE_DIR, 'systemd.service.template');
  const timerSrc = path.join(BRIDGE_DIR, 'systemd.timer.template');

  const serviceDest = path.join(SYSTEMD_UNIT_DIR, `${SYSTEMD_SERVICE_NAME}.service`);
  const timerDest = path.join(SYSTEMD_UNIT_DIR, `${SYSTEMD_SERVICE_NAME}.timer`);

  fs.writeFileSync(serviceDest, renderTemplate(serviceSrc, vars), 'utf8');
  fs.writeFileSync(timerDest, renderTemplate(timerSrc, vars), 'utf8');

  console.log(`[bridge] Unit files written to ${SYSTEMD_UNIT_DIR}`);

  spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8' });

  const enable = spawnSync('systemctl', ['--user', 'enable', '--now', `${SYSTEMD_SERVICE_NAME}.timer`], { encoding: 'utf8' });
  if (enable.status !== 0) {
    throw new Error(`systemctl enable failed: ${enable.stderr?.trim()}`);
  }

  console.log('[bridge] Bridge daemon started (systemd timer).');
  console.log(`[bridge] Logs: journalctl --user -u ${SYSTEMD_SERVICE_NAME}`);
}

function systemdStop() {
  spawnSync('systemctl', ['--user', 'stop', `${SYSTEMD_SERVICE_NAME}.timer`], { encoding: 'utf8' });
  spawnSync('systemctl', ['--user', 'disable', `${SYSTEMD_SERVICE_NAME}.timer`], { encoding: 'utf8' });
  console.log('[bridge] Bridge daemon stopped.');
}

function systemdStatus() {
  const result = spawnSync(
    'systemctl',
    ['--user', 'is-active', `${SYSTEMD_SERVICE_NAME}.timer`],
    { encoding: 'utf8' }
  );
  if (result.stdout.trim() === 'active') {
    console.log('[bridge] Running (systemd timer active)');
  } else {
    console.log(`[bridge] Not running (timer status: ${result.stdout.trim() || 'unknown'})`);
  }
}

// ── Log tailing ───────────────────────────────────────────────────────────────

function tailLogs(lines = 50) {
  const logPath = path.join(dataDir(), 'bridge.log');

  if (!fs.existsSync(logPath)) {
    console.log(`[bridge] No log file found at ${logPath}`);
    console.log('[bridge] Has the bridge ever run? Start it with: antenna bridge start');
    return;
  }

  console.log(`[bridge] Tailing ${logPath} (Ctrl+C to stop)\n`);

  // Use tail -f for live following
  const tail = spawn('tail', ['-n', String(lines), '-f', logPath], {
    stdio: 'inherit',
  });

  tail.on('error', (err) => {
    // Fallback: just print the last N lines
    console.error(`[bridge] tail command failed: ${err.message}`);
    const content = fs.readFileSync(logPath, 'utf8');
    const allLines = content.split('\n');
    console.log(allLines.slice(-lines).join('\n'));
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

async function start(options = {}) {
  const configPath = options.config || './config.yaml';
  const config = loadConfig(configPath);

  if (!config.bridge?.enabled) {
    console.log('[bridge] bridge.enabled is false in config — nothing to start.');
    console.log('[bridge] Set bridge.enabled: true and bridge.sender_id in your config.yaml first.');
    return;
  }

  if (!config.bridge?.sender_id) {
    throw new Error(
      '[bridge] bridge.sender_id is not set. Run `antenna init` to detect your WhatsApp sender ID.'
    );
  }

  // Ensure the bridge script is executable
  try {
    fs.chmodSync(BRIDGE_SCRIPT, 0o755);
  } catch {
    // Non-fatal
  }

  const platform = detectPlatform();

  if (platform === 'macos') {
    launchdStart(configPath, config);
  } else if (platform === 'linux') {
    systemdStart(configPath, config);
  } else {
    throw new Error(
      `[bridge] Unsupported platform: ${process.platform}. Manual setup required.\n` +
      `Run the bridge script directly: ${BRIDGE_SCRIPT}`
    );
  }
}

async function stop() {
  const platform = detectPlatform();
  if (platform === 'macos') {
    launchdStop();
  } else if (platform === 'linux') {
    systemdStop();
  } else {
    console.log(`[bridge] Unsupported platform — stop the bridge process manually.`);
  }
}

async function status() {
  const platform = detectPlatform();
  console.log(`[bridge] Platform: ${platform}`);
  if (platform === 'macos') {
    launchdStatus();
  } else if (platform === 'linux') {
    systemdStatus();
  } else {
    console.log('[bridge] Unsupported platform — check process list manually.');
  }
}

async function logs(options = {}) {
  const lines = options.lines ?? 50;
  tailLogs(lines);
}

module.exports = { start, stop, status, logs };
