'use strict';

/**
 * antenna bridge — daemon management for WhatsApp and Email bridges.
 *
 * Both bridges share the same Claude Code session (via ~/.antenna/bridge-session).
 * Each bridge has its own daemon (launchd agent or systemd timer).
 *
 * Supports:
 *   start   — install and start daemon(s)
 *   stop    — stop and unload daemon(s)
 *   status  — check if daemon(s) are running
 *   logs    — tail the bridge log file(s)
 *
 * Flags:
 *   --whatsapp  — operate on WhatsApp bridge only
 *   --email     — operate on email bridge only
 *   (no flag)   — operate on all enabled bridges
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn } = require('child_process');
const { loadConfig } = require('./config');

const PKG_ROOT = path.join(__dirname, '..');
const BRIDGE_DIR = path.join(PKG_ROOT, 'bridge');

// ── Bridge definitions ───────────────────────────────────────────────────────

const BRIDGES = {
  whatsapp: {
    script: path.join(BRIDGE_DIR, 'whatsapp-bridge.sh'),
    launchd: {
      label: 'io.open-antenna.whatsapp-bridge',
      template: path.join(BRIDGE_DIR, 'launchd-whatsapp.plist.template'),
      plistPath: path.join(os.homedir(), 'Library', 'LaunchAgents', 'io.open-antenna.whatsapp-bridge.plist'),
    },
    systemd: {
      serviceName: 'open-antenna-whatsapp-bridge',
      serviceTemplate: path.join(BRIDGE_DIR, 'systemd-whatsapp.service.template'),
      timerTemplate: path.join(BRIDGE_DIR, 'systemd-whatsapp.timer.template'),
    },
    logFile: 'bridge.log',
    configKey: 'whatsapp',
    displayName: 'WhatsApp',
  },
  email: {
    script: path.join(BRIDGE_DIR, 'email-bridge.sh'),
    launchd: {
      label: 'io.open-antenna.email-bridge',
      template: path.join(BRIDGE_DIR, 'launchd-email.plist.template'),
      plistPath: path.join(os.homedir(), 'Library', 'LaunchAgents', 'io.open-antenna.email-bridge.plist'),
    },
    systemd: {
      serviceName: 'open-antenna-email-bridge',
      serviceTemplate: path.join(BRIDGE_DIR, 'systemd-email.service.template'),
      timerTemplate: path.join(BRIDGE_DIR, 'systemd-email.timer.template'),
    },
    logFile: 'email-bridge.log',
    configKey: 'email',
    displayName: 'Email',
  },
};

// Legacy cleanup: remove old unified plist/service if present
const LEGACY_LAUNCHD_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', 'io.open-antenna.bridge.plist');
const LEGACY_SYSTEMD_SERVICE = 'open-antenna-bridge';

const SYSTEMD_UNIT_DIR = path.join(os.homedir(), '.config', 'systemd', 'user');

// ── Helpers ──────────────────────────────────────────────────────────────────

function detectPlatform() {
  const platform = process.platform;
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  return 'unsupported';
}

function renderTemplate(templatePath, vars) {
  let content = fs.readFileSync(templatePath, 'utf8');
  for (const [key, value] of Object.entries(vars)) {
    content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return content;
}

function dataDir() {
  return path.join(os.homedir(), '.antenna');
}

function buildTemplateVars(configPath, pollInterval, envVars = '') {
  return {
    BRIDGE_SCRIPT: '', // filled per-bridge
    CONFIG_PATH: path.resolve(configPath),
    DATA_DIR: dataDir(),
    POLL_INTERVAL: String(pollInterval ?? 30),
    ENV_VARS: envVars,
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

/**
 * Build environment variable entries for daemon templates.
 * Email bridge needs IMAP/SMTP passwords passed through from the host env.
 */
function buildEnvVars(bridgeName, config) {
  if (bridgeName !== 'email') return '';

  const emailConfig = config.bridge?.email;
  if (!emailConfig) return '';

  const vars = [];
  // Pass through IMAP password env var
  if (emailConfig.imap_pass_env && process.env[emailConfig.imap_pass_env]) {
    const envName = emailConfig.imap_pass_env;
    const envVal = process.env[envName];
    vars.push({ name: envName, value: envVal });
  }
  // Pass through SMTP password env var
  if (emailConfig.smtp_pass_env && process.env[emailConfig.smtp_pass_env]) {
    const envName = emailConfig.smtp_pass_env;
    const envVal = process.env[envName];
    vars.push({ name: envName, value: envVal });
  }

  const platform = detectPlatform();
  if (platform === 'macos') {
    // launchd plist format
    return vars.map(v =>
      `<key>${v.name}</key>\n        <string>${v.value}</string>`
    ).join('\n        ');
  } else {
    // systemd format
    return vars.map(v => `Environment=${v.name}=${v.value}`).join('\n');
  }
}

/**
 * Determine which bridges to operate on based on options.
 */
function resolveBridges(options, config) {
  if (options?.whatsapp) return ['whatsapp'];
  if (options?.email) return ['email'];

  // Default: all enabled bridges
  const bridges = [];
  if (config?.bridge?.whatsapp?.enabled) bridges.push('whatsapp');
  if (config?.bridge?.email?.enabled) bridges.push('email');
  return bridges;
}

/**
 * Clean up legacy unified daemon (from pre-v0.2.0).
 */
function cleanupLegacy() {
  const platform = detectPlatform();
  if (platform === 'macos' && fs.existsSync(LEGACY_LAUNCHD_PLIST)) {
    spawnSync('launchctl', ['unload', LEGACY_LAUNCHD_PLIST], { encoding: 'utf8' });
    try { fs.unlinkSync(LEGACY_LAUNCHD_PLIST); } catch {}
    console.log('[bridge] Cleaned up legacy unified daemon.');
  }
  if (platform === 'linux') {
    spawnSync('systemctl', ['--user', 'stop', `${LEGACY_SYSTEMD_SERVICE}.timer`], { encoding: 'utf8' });
    spawnSync('systemctl', ['--user', 'disable', `${LEGACY_SYSTEMD_SERVICE}.timer`], { encoding: 'utf8' });
  }
}

// ── macOS launchd ─────────────────────────────────────────────────────────────

function launchdStart(bridge, vars) {
  const rendered = renderTemplate(bridge.launchd.template, vars);

  const agentsDir = path.dirname(bridge.launchd.plistPath);
  fs.mkdirSync(agentsDir, { recursive: true });

  spawnSync('launchctl', ['unload', bridge.launchd.plistPath], { encoding: 'utf8' });

  fs.writeFileSync(bridge.launchd.plistPath, rendered, 'utf8');
  console.log(`[bridge:${bridge.displayName}] Plist written: ${bridge.launchd.plistPath}`);

  const result = spawnSync('launchctl', ['load', '-w', bridge.launchd.plistPath], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`launchctl load failed for ${bridge.displayName}: ${result.stderr?.trim()}`);
  }

  console.log(`[bridge:${bridge.displayName}] Daemon started (launchd).`);
}

function launchdStop(bridge) {
  if (!fs.existsSync(bridge.launchd.plistPath)) {
    console.log(`[bridge:${bridge.displayName}] No plist found — daemon is not installed.`);
    return;
  }
  spawnSync('launchctl', ['unload', '-w', bridge.launchd.plistPath], { encoding: 'utf8' });
  console.log(`[bridge:${bridge.displayName}] Daemon stopped.`);
}

function launchdStatus(bridge) {
  const result = spawnSync('launchctl', ['list', bridge.launchd.label], { encoding: 'utf8' });
  if (result.status === 0) {
    console.log(`[bridge:${bridge.displayName}] Running (launchd)`);
    const pidMatch = result.stdout.match(/"PID"\s*=\s*(\d+)/);
    if (pidMatch) console.log(`[bridge:${bridge.displayName}] PID: ${pidMatch[1]}`);
  } else {
    console.log(`[bridge:${bridge.displayName}] Not running`);
    if (!fs.existsSync(bridge.launchd.plistPath)) {
      console.log(`[bridge:${bridge.displayName}] Not installed — run: antenna bridge start --${bridge.configKey}`);
    }
  }
}

// ── Linux systemd ─────────────────────────────────────────────────────────────

function systemdStart(bridge, vars) {
  fs.mkdirSync(SYSTEMD_UNIT_DIR, { recursive: true });

  const serviceDest = path.join(SYSTEMD_UNIT_DIR, `${bridge.systemd.serviceName}.service`);
  const timerDest = path.join(SYSTEMD_UNIT_DIR, `${bridge.systemd.serviceName}.timer`);

  fs.writeFileSync(serviceDest, renderTemplate(bridge.systemd.serviceTemplate, vars), 'utf8');
  fs.writeFileSync(timerDest, renderTemplate(bridge.systemd.timerTemplate, vars), 'utf8');

  console.log(`[bridge:${bridge.displayName}] Unit files written to ${SYSTEMD_UNIT_DIR}`);

  spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8' });

  const enable = spawnSync('systemctl', ['--user', 'enable', '--now', `${bridge.systemd.serviceName}.timer`], { encoding: 'utf8' });
  if (enable.status !== 0) {
    throw new Error(`systemctl enable failed for ${bridge.displayName}: ${enable.stderr?.trim()}`);
  }

  console.log(`[bridge:${bridge.displayName}] Daemon started (systemd timer).`);
}

function systemdStop(bridge) {
  spawnSync('systemctl', ['--user', 'stop', `${bridge.systemd.serviceName}.timer`], { encoding: 'utf8' });
  spawnSync('systemctl', ['--user', 'disable', `${bridge.systemd.serviceName}.timer`], { encoding: 'utf8' });
  console.log(`[bridge:${bridge.displayName}] Daemon stopped.`);
}

function systemdStatus(bridge) {
  const result = spawnSync(
    'systemctl',
    ['--user', 'is-active', `${bridge.systemd.serviceName}.timer`],
    { encoding: 'utf8' }
  );
  if (result.stdout.trim() === 'active') {
    console.log(`[bridge:${bridge.displayName}] Running (systemd timer active)`);
  } else {
    console.log(`[bridge:${bridge.displayName}] Not running (timer status: ${result.stdout.trim() || 'unknown'})`);
  }
}

// ── Log tailing ───────────────────────────────────────────────────────────────

function tailLogs(logFileName, lines = 50) {
  const logPath = path.join(dataDir(), logFileName);

  if (!fs.existsSync(logPath)) {
    console.log(`[bridge] No log file found at ${logPath}`);
    return;
  }

  console.log(`[bridge] Tailing ${logPath} (Ctrl+C to stop)\n`);

  const tail = spawn('tail', ['-n', String(lines), '-f', logPath], {
    stdio: 'inherit',
  });

  tail.on('error', (err) => {
    console.error(`[bridge] tail command failed: ${err.message}`);
    const content = fs.readFileSync(logPath, 'utf8');
    const allLines = content.split('\n');
    console.log(allLines.slice(-lines).join('\n'));
  });
}

// ── Platform dispatch ─────────────────────────────────────────────────────────

const PLATFORM_OPS = {
  macos: {
    start: launchdStart,
    stop: launchdStop,
    status: launchdStatus,
  },
  linux: {
    start: systemdStart,
    stop: systemdStop,
    status: systemdStatus,
  },
};

// ── Public API ────────────────────────────────────────────────────────────────

async function start(options = {}) {
  const configPath = options.config || './config.yaml';
  const config = loadConfig(configPath);

  // Clean up legacy unified daemon on first run of new version
  cleanupLegacy();

  const platform = detectPlatform();
  const ops = PLATFORM_OPS[platform];
  if (!ops) {
    throw new Error(
      `[bridge] Unsupported platform: ${process.platform}. Manual setup required.`
    );
  }

  // Determine which bridges to start
  let bridgeNames;
  if (options.whatsapp) {
    bridgeNames = ['whatsapp'];
  } else if (options.email) {
    bridgeNames = ['email'];
  } else {
    bridgeNames = resolveBridges({}, config);
  }

  if (bridgeNames.length === 0) {
    console.log('[bridge] No bridges enabled in config.');
    console.log('[bridge] Set bridge.whatsapp.enabled: true or bridge.email.enabled: true in your config.yaml.');
    return;
  }

  for (const name of bridgeNames) {
    const bridge = BRIDGES[name];
    const bridgeConfig = config.bridge?.[name];

    if (!bridgeConfig?.enabled) {
      console.log(`[bridge:${bridge.displayName}] Not enabled in config — skipping.`);
      continue;
    }

    // Validation
    if (name === 'whatsapp' && !bridgeConfig.sender_id) {
      console.error(`[bridge:WhatsApp] sender_id is not set. Run \`antenna init\` to configure.`);
      continue;
    }
    if (name === 'email' && (!bridgeConfig.imap_host || !bridgeConfig.imap_user)) {
      console.error(`[bridge:Email] imap_host and imap_user must be set. Run \`antenna init\` to configure.`);
      continue;
    }

    // Ensure script is executable
    try { fs.chmodSync(bridge.script, 0o755); } catch {}

    const pollInterval = bridgeConfig.poll_interval ?? (name === 'email' ? 60 : 30);
    const envVars = buildEnvVars(name, config);
    const vars = buildTemplateVars(configPath, pollInterval, envVars);
    vars.BRIDGE_SCRIPT = bridge.script;

    ops.start(bridge, vars);
    console.log(`[bridge:${bridge.displayName}] Logs: ${path.join(dataDir(), bridge.logFile)}`);
  }
}

async function stop(options = {}) {
  const platform = detectPlatform();
  const ops = PLATFORM_OPS[platform];
  if (!ops) {
    console.log('[bridge] Unsupported platform — stop the bridge process manually.');
    return;
  }

  let bridgeNames;
  if (options?.whatsapp) {
    bridgeNames = ['whatsapp'];
  } else if (options?.email) {
    bridgeNames = ['email'];
  } else {
    bridgeNames = ['whatsapp', 'email']; // Stop all
  }

  for (const name of bridgeNames) {
    ops.stop(BRIDGES[name]);
  }
}

async function status(options = {}) {
  const platform = detectPlatform();
  console.log(`[bridge] Platform: ${platform}`);
  const ops = PLATFORM_OPS[platform];
  if (!ops) {
    console.log('[bridge] Unsupported platform — check process list manually.');
    return;
  }

  let bridgeNames;
  if (options?.whatsapp) {
    bridgeNames = ['whatsapp'];
  } else if (options?.email) {
    bridgeNames = ['email'];
  } else {
    bridgeNames = ['whatsapp', 'email']; // Status for all
  }

  for (const name of bridgeNames) {
    ops.status(BRIDGES[name]);
  }
}

async function logs(options = {}) {
  const lines = options.lines ?? 50;

  if (options?.email) {
    tailLogs(BRIDGES.email.logFile, lines);
  } else if (options?.whatsapp) {
    tailLogs(BRIDGES.whatsapp.logFile, lines);
  } else {
    // Default: WhatsApp logs (backward compat), mention email
    tailLogs(BRIDGES.whatsapp.logFile, lines);
    console.log(`\n[bridge] For email bridge logs, run: antenna bridge logs --email`);
  }
}

module.exports = { start, stop, status, logs };
