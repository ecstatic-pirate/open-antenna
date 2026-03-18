'use strict';

/**
 * antenna init — interactive setup wizard.
 *
 * Flow:
 *   1. Dependency checks (Node, Claude CLI, Python 3)
 *   2. Python scanner deps
 *   3. WhatsApp setup (wacli download + QR auth)
 *   4. Email setup (optional, SMTP)
 *   5. Personal profile (name, role, topics)
 *   6. Sources (YouTube channels, HN prefs)
 *   7. Relevance filter
 *   8. WhatsApp bridge (optional, sender ID detection + daemon install)
 *   9. Schedule (time + timezone → cron)
 *  10. Test notification
 *  11. Write config.yaml
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { spawnSync, spawn } = require('child_process');
const yaml = require('js-yaml');

const PKG_ROOT = path.join(__dirname, '..');
const SCANNERS_DIR = path.join(PKG_ROOT, 'scanners');
const WACLI_VERSION = '0.4.2';

// ── Terminal helpers ───────────────────────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';

function section(title) {
  console.log(`\n${BOLD}${CYAN}── ${title} ${'─'.repeat(Math.max(0, 44 - title.length))}${RESET}`);
}

function ok(msg) {
  console.log(`${GREEN}✓${RESET} ${msg}`);
}

function spin(msg) {
  process.stdout.write(`${YELLOW}⟳${RESET} ${msg}...`);
}

function spinDone(msg = 'done') {
  process.stdout.write(` ${GREEN}✓${RESET} ${msg}\n`);
}

function info(msg) {
  console.log(`  ${DIM}${msg}${RESET}`);
}

function warn(msg) {
  console.log(`${YELLOW}⚠${RESET}  ${msg}`);
}

// ── Prompting ──────────────────────────────────────────────────────────────────

function createRl() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function ask(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function prompt(rl, label, defaultVal = '') {
  const hint = defaultVal ? ` [${defaultVal}]` : '';
  const answer = await ask(rl, `  ${label}${hint}: `);
  return answer || defaultVal;
}

async function confirm(rl, label, defaultYes = true) {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = await ask(rl, `  ${label} ${hint}: `);
  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith('y');
}

// ── Dependency checks ──────────────────────────────────────────────────────────

function checkBin(name) {
  const result = spawnSync('which', [name], { encoding: 'utf8' });
  return result.status === 0;
}

async function checkDependencies(rl) {
  section('Dependencies');

  // Node — always present if we're running
  const nodeVer = process.version;
  ok(`Node.js ${nodeVer} found`);

  // Claude Code CLI
  if (checkBin('claude')) {
    ok('Claude Code CLI found');
  } else {
    warn('Claude Code CLI not found');
    console.log('  Install from: https://claude.ai/code');
    console.log('  After installing, re-run: antenna init\n');
    const cont = await confirm(rl, 'Continue anyway (antenna run will fail without Claude)?', false);
    if (!cont) process.exit(1);
  }

  // Python 3
  if (checkBin('python3')) {
    const ver = spawnSync('python3', ['--version'], { encoding: 'utf8' });
    ok(`${ver.stdout.trim() || 'Python 3'} found`);
  } else {
    warn('Python 3 not found');
    console.log('  Install from: https://python.org (or via brew: brew install python3)');
    const cont = await confirm(rl, 'Continue anyway?', false);
    if (!cont) process.exit(1);
  }
}

async function installPythonDeps() {
  const reqFile = path.join(SCANNERS_DIR, 'requirements.txt');
  if (!fs.existsSync(reqFile)) {
    warn('requirements.txt not found — skipping pip install');
    return;
  }

  spin('Installing Python scanner deps (requests, feedparser)');
  const result = spawnSync('pip3', ['install', '-r', reqFile, '--quiet'], {
    encoding: 'utf8',
    timeout: 60_000,
  });

  if (result.status !== 0) {
    spinDone('failed');
    warn(`pip install failed:\n${result.stderr}`);
    warn('Scanners may not work — install manually: pip3 install requests feedparser');
  } else {
    spinDone();
    ok('Python deps installed');
    // Write sentinel
    fs.writeFileSync(path.join(SCANNERS_DIR, '.deps-installed'), new Date().toISOString());
  }
}

// ── wacli install ──────────────────────────────────────────────────────────────

function detectWacliPlatform() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'darwin') {
    return arch === 'arm64' ? 'darwin-arm64' : 'darwin-amd64';
  }
  if (platform === 'linux') {
    return arch === 'arm64' ? 'linux-arm64' : 'linux-amd64';
  }
  return null;
}

function wacliInstallPath() {
  // Prefer /usr/local/bin if writable, else ~/.local/bin
  try {
    fs.accessSync('/usr/local/bin', fs.constants.W_OK);
    return '/usr/local/bin/wacli';
  } catch {
    return path.join(os.homedir(), '.local', 'bin', 'wacli');
  }
}

async function installWacli() {
  if (checkBin('wacli')) {
    ok('wacli already installed');
    return;
  }

  spin('Installing WhatsApp CLI (wacli)');

  const plat = detectWacliPlatform();
  if (!plat) {
    spinDone('skipped');
    warn(`Unsupported platform: ${process.platform}/${process.arch}. Install wacli manually.`);
    info('https://github.com/SOME-ORG/wacli/releases');
    return;
  }

  const installPath = wacliInstallPath();
  const dir = path.dirname(installPath);
  fs.mkdirSync(dir, { recursive: true });

  // Ensure dir is in PATH hint
  const url = `https://github.com/SOME-ORG/wacli/releases/download/v${WACLI_VERSION}/wacli-${plat}`;
  info(`Downloading wacli v${WACLI_VERSION} for ${plat}...`);

  const dlResult = spawnSync('curl', ['-fsSL', '-o', installPath, url], {
    encoding: 'utf8',
    timeout: 60_000,
  });

  if (dlResult.status !== 0) {
    spinDone('failed');
    warn('Download failed. Install wacli manually from: https://github.com/SOME-ORG/wacli/releases');
    warn('Then re-run: antenna init');
    return;
  }

  fs.chmodSync(installPath, 0o755);
  spinDone();
  ok(`wacli installed to ${installPath}`);
}

// ── WhatsApp setup ─────────────────────────────────────────────────────────────

async function setupWhatsApp(rl, config) {
  section('WhatsApp Setup');

  await installWacli();

  if (!checkBin('wacli')) {
    warn('wacli not available — skipping WhatsApp setup.');
    return;
  }

  // QR auth
  console.log('\n📱 Scan this QR code with your phone:');
  info('WhatsApp → Settings → Linked Devices → Link a Device');
  console.log('');

  // Run wacli login — inherits stdio so QR prints in terminal
  const loginResult = spawnSync('wacli', ['login'], { stdio: 'inherit', encoding: 'utf8' });

  if (loginResult.status !== 0) {
    warn('wacli login failed or was cancelled. You can re-run: antenna init');
  } else {
    ok('WhatsApp connected');
  }

  // Recipient phone number
  const recipient = await prompt(rl, 'Send digest to (phone number, e.g. +1234567890)', config.notifications?.whatsapp?.recipient || '');

  if (recipient) {
    config.notifications = config.notifications || {};
    config.notifications.whatsapp = {
      enabled: true,
      recipient,
    };
    ok('WhatsApp configured');
  } else {
    warn('No recipient — WhatsApp notifications disabled');
    config.notifications = config.notifications || {};
    config.notifications.whatsapp = { enabled: false, recipient: '' };
  }
}

// ── Email setup ────────────────────────────────────────────────────────────────

async function setupEmail(rl, config) {
  section('Email Setup (optional)');

  const enable = await confirm(rl, 'Enable email delivery?', false);
  if (!enable) {
    config.notifications = config.notifications || {};
    config.notifications.email = { enabled: false };
    return;
  }

  const smtp_host = await prompt(rl, 'SMTP host', config.notifications?.email?.smtp_host || 'smtp.gmail.com');
  const smtp_port = parseInt(await prompt(rl, 'SMTP port', String(config.notifications?.email?.smtp_port || 587)), 10);
  const smtp_user = await prompt(rl, 'SMTP user (your email)', config.notifications?.email?.smtp_user || '');
  const smtp_pass_env = await prompt(rl, 'SMTP password env var name', config.notifications?.email?.smtp_pass_env || 'ANTENNA_SMTP_PASS');
  const to = await prompt(rl, 'Send digest to (recipient email)', config.notifications?.email?.to || smtp_user);
  const subject_prefix = await prompt(rl, 'Email subject prefix', config.notifications?.email?.subject_prefix || '[Daily Intel]');

  config.notifications = config.notifications || {};
  config.notifications.email = {
    enabled: true,
    smtp_host,
    smtp_port,
    smtp_user,
    smtp_pass_env,
    to,
    subject_prefix,
  };

  ok('Email configured');
  info(`Set ${smtp_pass_env} in your environment with your SMTP password.`);
}

// ── Profile ────────────────────────────────────────────────────────────────────

async function setupProfile(rl, config) {
  section('About You');

  const name = await prompt(rl, "What's your name?", config.profile?.name || '');
  const role = await prompt(rl, "What's your role?", config.profile?.role || '');

  console.log('  What topics matter most to you?');
  info('comma-separated: AI, infrastructure, leadership, crypto, etc.');
  const topicsRaw = await ask(rl, '  > ');
  const topics = topicsRaw
    ? topicsRaw.split(',').map((t) => t.trim()).filter(Boolean)
    : (config.profile?.topics || []);

  config.profile = { name, role, topics };
  ok('Profile saved');
}

// ── Sources ────────────────────────────────────────────────────────────────────

async function setupSources(rl, config) {
  section('Sources');

  // YouTube
  const enableYt = await confirm(rl, 'Add YouTube channels to scan?', true);
  const channels = [];

  if (enableYt) {
    let addMore = true;
    while (addMore) {
      const handle = await prompt(rl, 'Channel handle (e.g. @allin)', '');
      if (!handle) break;
      const label = await prompt(rl, 'Label', handle.replace('@', ''));
      channels.push({ handle, label });
      addMore = await confirm(rl, 'Add another?', false);
    }
  }

  const enableHn = await confirm(rl, 'Enable Hacker News scanning?', true);
  const hnMinScore = enableHn
    ? parseInt(await prompt(rl, 'Minimum HN score filter', String(config.sources?.hackernews?.min_score || 50)), 10)
    : 50;

  config.sources = {
    youtube: {
      enabled: channels.length > 0,
      channels,
      max_age_hours: config.sources?.youtube?.max_age_hours ?? 24,
      exclude_shorts: config.sources?.youtube?.exclude_shorts ?? true,
    },
    hackernews: {
      enabled: enableHn,
      top_n: config.sources?.hackernews?.top_n ?? 20,
      min_score: hnMinScore,
    },
  };
}

// ── Relevance filter ───────────────────────────────────────────────────────────

async function setupRelevanceFilter(rl, config) {
  section('Relevance Filter');

  console.log('  Describe who this digest is for (the AI uses this to filter irrelevant content).');
  info('Example: "useful for a VP Engineering interested in AI and developer tools"');

  const filter = await ask(rl, '  > ');
  config.processing = config.processing || {};
  config.processing.relevance_filter = filter || `useful for ${config.profile?.role || 'a technical professional'} interested in ${(config.profile?.topics || []).join(', ')}`;
  ok('Relevance filter set');
}

// ── WhatsApp bridge ────────────────────────────────────────────────────────────

async function setupBridge(rl, config) {
  section('WhatsApp Bridge (two-way AI)');

  const enable = await confirm(rl, 'Enable two-way WhatsApp assistant?', true);
  if (!enable) {
    config.bridge = { enabled: false };
    return;
  }

  // Detect sender ID — user sends a test message, we capture their WhatsApp ID
  let sender_id = config.bridge?.sender_id || '';
  if (!sender_id) {
    console.log('  ⟳ Detecting your WhatsApp sender ID...');
    console.log('  Send a test WhatsApp message to this number now, then press Enter.');
    await ask(rl, '  (Press Enter after sending)');

    // Try to capture sender ID from recent message
    const syncResult = spawnSync('wacli', ['sync', '--once', '--json'], {
      encoding: 'utf8',
      timeout: 30_000,
    });

    if (syncResult.status === 0 && syncResult.stdout) {
      try {
        const messages = JSON.parse(syncResult.stdout);
        const first = Array.isArray(messages) ? messages[0] : null;
        if (first?.sender) {
          sender_id = first.sender;
          ok(`Detected sender: ${sender_id}`);
        }
      } catch {
        // Non-fatal
      }
    }

    if (!sender_id) {
      warn('Could not auto-detect sender ID.');
      sender_id = await prompt(rl, 'Enter your WhatsApp sender ID manually (e.g. 4041715224694@lid)', '');
    }
  } else {
    ok(`Using existing sender ID: ${sender_id}`);
  }

  config.bridge = {
    enabled: true,
    sender_id,
    poll_interval: config.bridge?.poll_interval ?? 30,
    message_timeout: config.bridge?.message_timeout ?? 600,
    antenna_timeout: config.bridge?.antenna_timeout ?? 900,
  };

  // Install daemon
  if (sender_id) {
    spin('Installing bridge daemon');
    const bridgeLib = require('./bridge');
    try {
      await bridgeLib.start({ config: './config.yaml' });
      spinDone();
      ok('Bridge installed and running (polls every 30s)');
    } catch (err) {
      spinDone('failed');
      warn(`Bridge install failed: ${err.message}`);
      info('Run manually after init: antenna bridge start');
    }
  }
}

// ── Schedule ───────────────────────────────────────────────────────────────────

async function setupSchedule(rl, config) {
  section('Schedule');

  const time = await prompt(rl, 'Daily briefing time (24h format)', config.schedule?.time || '07:00');
  const timezone = await prompt(rl, 'Timezone', config.schedule?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York');

  config.schedule = { time, timezone };

  // Build cron expression
  const [hourStr, minStr] = time.split(':');
  const hour = parseInt(hourStr, 10);
  const min = parseInt(minStr || '0', 10);

  // antenna run absolute path
  const antennaPath = process.execPath.includes('node') ? 'antenna' : process.argv[0];
  const configPath = path.resolve('./config.yaml');
  const logPath = path.join(os.homedir(), '.antenna', 'cron.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  const cronLine = `${min} ${hour} * * * TZ="${timezone}" ${antennaPath} run --config ${configPath} >> ${logPath} 2>&1`;

  // Read existing crontab, remove old antenna lines, add new
  const existingResult = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
  const existingCrontab = existingResult.status === 0 ? existingResult.stdout : '';

  const filtered = existingCrontab
    .split('\n')
    .filter((line) => !line.includes('antenna run') && !line.includes('open-antenna'))
    .join('\n')
    .trim();

  const newCrontab = (filtered ? filtered + '\n' : '') + cronLine + '\n';

  const installResult = spawnSync('crontab', ['-'], {
    input: newCrontab,
    encoding: 'utf8',
  });

  if (installResult.status !== 0) {
    warn(`crontab install failed: ${installResult.stderr?.trim()}`);
    info(`Add this line to your crontab manually (crontab -e):`);
    info(cronLine);
  } else {
    ok(`Cron job installed: daily at ${time} ${timezone}`);
  }
}

// ── Test notification ──────────────────────────────────────────────────────────

async function runTestNotify(config) {
  section('Test');

  // Write config first so test-notify can load it
  const configPath = path.resolve('./config.yaml');
  const yamlStr = yaml.dump(config, { lineWidth: -1 });
  fs.writeFileSync(configPath, yamlStr, 'utf8');

  spin('Sending test notification');
  const result = spawnSync('antenna', ['test-notify', '--config', configPath], {
    encoding: 'utf8',
    timeout: 60_000,
    stdio: 'pipe',
  });

  if (result.status !== 0) {
    spinDone('failed');
    warn('Test notification failed. Run `antenna test-notify` manually to debug.');
    if (result.stdout) info(result.stdout.slice(0, 300));
    if (result.stderr) info(result.stderr.slice(0, 300));
  } else {
    spinDone();
    if (result.stdout) {
      result.stdout.trim().split('\n').forEach((line) => {
        if (line.includes('sent')) ok(line.replace('[test-notify] ', ''));
        else info(line.replace('[test-notify] ', ''));
      });
    }
  }
}

// ── Write config ───────────────────────────────────────────────────────────────

function writeConfig(config) {
  const configPath = path.resolve('./config.yaml');

  // Add output block if missing
  config.output = config.output || { dir: './output', format: 'pdf' };
  config.processing = config.processing || { claude_model: 'sonnet' };

  const header = `# Open Antenna — config.yaml
# Generated by \`antenna init\`. Edit freely.
# Re-run \`antenna init\` to update interactively.

`;
  const yamlStr = yaml.dump(config, { lineWidth: -1 });
  fs.writeFileSync(configPath, header + yamlStr, 'utf8');
  ok(`Config saved to ${configPath}`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function init() {
  console.log(`\n${BOLD}Open Antenna — Setup Wizard${RESET}`);
  console.log('This will configure your daily briefing and (optionally) the WhatsApp AI assistant.');
  console.log('Press Ctrl+C at any time to quit.\n');

  const rl = createRl();

  // Load existing config if present (re-run friendly)
  let config = {};
  const existingConfigPath = path.resolve('./config.yaml');
  if (fs.existsSync(existingConfigPath)) {
    try {
      config = yaml.load(fs.readFileSync(existingConfigPath, 'utf8')) || {};
      info('Found existing config.yaml — values shown as defaults');
    } catch {
      // Start fresh if corrupt
    }
  }

  try {
    await checkDependencies(rl);
    await installPythonDeps();
    await setupWhatsApp(rl, config);
    await setupEmail(rl, config);
    await setupProfile(rl, config);
    await setupSources(rl, config);
    await setupRelevanceFilter(rl, config);
    await setupBridge(rl, config);
    await setupSchedule(rl, config);

    writeConfig(config);

    const doTest = await confirm(rl, 'Send a test notification now?', true);
    if (doTest) {
      await runTestNotify(config);
    }

    section('Done');
    ok(`Config saved to ./config.yaml`);
    ok(`Daily briefing scheduled for ${config.schedule?.time} ${config.schedule?.timezone}`);
    console.log('');
    console.log('  Commands:');
    console.log('  • Run now:       antenna run');
    console.log('  • Change config: antenna init');
    console.log('  • Test notify:   antenna test-notify');
    console.log('  • View schedule: antenna schedule');
    console.log('  • Bridge status: antenna bridge status');
    console.log('');
  } finally {
    rl.close();
  }
}

module.exports = init;
