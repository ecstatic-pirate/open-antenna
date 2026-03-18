#!/usr/bin/env node

'use strict';

const { program } = require('commander');
const path = require('path');
const pkg = require('../package.json');

program
  .name('antenna')
  .description('AI-powered daily intelligence briefing from YouTube + Hacker News')
  .version(pkg.version);

// ── antenna run ───────────────────────────────────────────────────────────────

program
  .command('run')
  .description('Run the digest pipeline once')
  .option('-c, --config <path>', 'Path to config.yaml', './config.yaml')
  .option('--no-pdf', 'Skip PDF conversion, output markdown only')
  .option('--no-notify', 'Skip notifications, write files only')
  .action((options) => {
    const run = require('../lib/run');
    run(options).catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
  });

// ── antenna init ──────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Interactive setup wizard — configure sources, notifications, and schedule')
  .action(() => {
    const init = require('../lib/init');
    init().catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
  });

// ── antenna test-notify ───────────────────────────────────────────────────────

program
  .command('test-notify')
  .description('Send a test notification through all configured channels')
  .option('-c, --config <path>', 'Path to config.yaml', './config.yaml')
  .action(async (options) => {
    const fs = require('fs');
    const yaml = require('js-yaml');

    const configPath = path.resolve(options.config);
    if (!fs.existsSync(configPath)) {
      console.error(`Config not found: ${configPath}\nRun 'antenna init' to create one.`);
      process.exit(1);
    }

    const config = yaml.load(fs.readFileSync(configPath, 'utf8'));

    const outputDir = path.resolve(config.output?.dir ?? './output');
    fs.mkdirSync(outputDir, { recursive: true });

    const today = new Date().toISOString().split('T')[0];
    const sampleMd = path.join(outputDir, `${today}-test-digest.md`);

    const sampleContent = `# Test Digest — ${today}

This is a test notification from Open Antenna.

## What This Is

Your daily intelligence briefing pipeline is working correctly.
When the real digest runs, it will replace this with summarized content
from your configured YouTube channels and Hacker News.

## Next Steps

- Run \`antenna run\` to generate your first real digest
- Edit \`config.yaml\` to adjust sources, schedule, and notifications
`;

    fs.writeFileSync(sampleMd, sampleContent, 'utf8');
    console.log(`[test-notify] Sample digest written: ${sampleMd}`);

    let digestPath = sampleMd;

    const wantPdf = config.output?.format === 'pdf';
    if (wantPdf) {
      try {
        const pdf = require('../lib/pdf');
        digestPath = await pdf.convert(sampleMd);
        console.log(`[test-notify] PDF written: ${digestPath}`);
      } catch (err) {
        console.warn(`[test-notify] PDF conversion failed: ${err.message} — sending markdown instead`);
      }
    }

    const notify = config.notifications || {};
    let sent = 0;
    let failed = 0;

    if (notify.whatsapp?.enabled) {
      try {
        const notifyWa = require('../lib/notify-whatsapp');
        await notifyWa.send(config, digestPath);
        console.log('[test-notify] WhatsApp: sent');
        sent++;
      } catch (err) {
        console.error(`[test-notify] WhatsApp: FAILED — ${err.message}`);
        failed++;
      }
    } else {
      console.log('[test-notify] WhatsApp: disabled (set notifications.whatsapp.enabled: true to enable)');
    }

    if (notify.email?.enabled) {
      try {
        const notifyEmail = require('../lib/notify-email');
        await notifyEmail.send(config, digestPath);
        console.log('[test-notify] Email: sent');
        sent++;
      } catch (err) {
        console.error(`[test-notify] Email: FAILED — ${err.message}`);
        failed++;
      }
    } else {
      console.log('[test-notify] Email: disabled (set notifications.email.enabled: true to enable)');
    }

    if (sent === 0 && failed === 0) {
      console.log('\n[test-notify] No notifications are enabled. Edit config.yaml to enable WhatsApp or email.');
    } else if (failed > 0) {
      console.error(`\n[test-notify] ${failed} channel(s) failed. Check errors above.`);
      process.exit(1);
    } else {
      console.log(`\n[test-notify] Done — ${sent} channel(s) notified.`);
    }
  });

// ── antenna schedule ──────────────────────────────────────────────────────────

program
  .command('schedule')
  .description('View or update the daily schedule')
  .option('-c, --config <path>', 'Path to config.yaml', './config.yaml')
  .option('-t, --time <HH:MM>', 'New time (24h format, e.g. 07:30)')
  .option('-z, --timezone <tz>', 'New timezone (e.g. America/New_York)')
  .action((options) => {
    const schedule = require('../lib/schedule');
    schedule(options).catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
  });

// ── antenna bridge <start|stop|status|logs> ───────────────────────────────────

const bridge = program
  .command('bridge')
  .description('Manage the two-way WhatsApp AI assistant daemon');

bridge
  .command('start')
  .description('Install and start the WhatsApp bridge daemon')
  .option('-c, --config <path>', 'Path to config.yaml', './config.yaml')
  .action((options) => {
    const bridgeLib = require('../lib/bridge');
    bridgeLib.start(options).catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
  });

bridge
  .command('stop')
  .description('Stop the WhatsApp bridge daemon')
  .action(() => {
    const bridgeLib = require('../lib/bridge');
    bridgeLib.stop().catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
  });

bridge
  .command('status')
  .description('Check if the bridge daemon is running')
  .action(() => {
    const bridgeLib = require('../lib/bridge');
    bridgeLib.status().catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
  });

bridge
  .command('logs')
  .description('Tail the bridge log')
  .option('-n, --lines <n>', 'Number of lines to show', '50')
  .action((options) => {
    const bridgeLib = require('../lib/bridge');
    bridgeLib.logs({ lines: parseInt(options.lines, 10) }).catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
  });

// ── antenna skills ────────────────────────────────────────────────────────────

program
  .command('skills')
  .description('List installed skills')
  .option('--detail', 'Show description of each skill')
  .action((options) => {
    const fs = require('fs');
    const skillsDir = path.join(__dirname, '..', 'skills');
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    if (entries.length === 0) {
      console.log('No skills installed.');
      return;
    }

    if (options.detail) {
      console.log('Installed skills:\n');
      for (const name of entries) {
        const skillFile = path.join(skillsDir, name, 'SKILL.md');
        if (!fs.existsSync(skillFile)) continue;

        const content = fs.readFileSync(skillFile, 'utf8');

        // Extract description from YAML frontmatter
        // Handles both inline (`description: text`) and block scalar (`description: >\n  text`)
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
        let desc = '(no description)';

        if (frontmatterMatch) {
          const fm = frontmatterMatch[1];
          // Block scalar: description: >\n  text...
          const blockMatch = fm.match(/^description:\s*[|>]\s*\n((?:\s+.+\n?)+)/m);
          if (blockMatch) {
            desc = blockMatch[1]
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
              .join(' ');
          } else {
            // Inline: description: text
            const inlineMatch = fm.match(/^description:\s*(.+)/m);
            if (inlineMatch) desc = inlineMatch[1].trim().replace(/^["']|["']$/g, '');
          }
        }

        // Truncate long descriptions
        if (desc.length > 120) desc = desc.slice(0, 117) + '...';

        console.log(`  ${name}`);
        console.log(`    ${desc}`);
        console.log('');
      }
    } else {
      console.log('Installed skills:\n');
      for (const name of entries) {
        console.log(`  ${name}`);
      }
      console.log('\nRun `antenna skills --detail` for descriptions.');
    }
  });

// ── antenna create-skill ──────────────────────────────────────────────────────

program
  .command('create-skill <description>')
  .description('Create a new skill from a natural language description')
  .option('-c, --config <path>', 'Path to config.yaml', './config.yaml')
  .addHelpText('after', `
Examples:
  antenna create-skill "summarize Slack threads from #engineering"
  antenna create-skill "weekly team standup digest from Linear tickets"
  antenna create-skill "fetch top Reddit posts from r/technology"

Claude will:
  1. Research how to do it (APIs, auth, tools)
  2. Ask you for credentials if needed
  3. Generate a SKILL.md
  4. Test it with sample input
  5. Install it to skills/ so it's immediately available
`)
  .action((description, options) => {
    const { spawnSync: spawnS } = require('child_process');
    const skillsDir = path.join(__dirname, '..', 'skills');
    const createSkillMd = path.join(skillsDir, 'create-skill', 'SKILL.md');

    if (!spawnS('which', ['claude'], { encoding: 'utf8' }).stdout?.trim()) {
      console.error('Claude Code CLI not found. Install from: https://claude.ai/code');
      process.exit(1);
    }

    const prompt = `Run the create-skill meta-skill to create a new skill.

User's request: "${description}"

Skills directory: ${skillsDir}
Create-skill skill: ${createSkillMd}
Config: ${path.resolve(options.config)}

Follow the create-skill SKILL.md exactly:
1. Research how to implement this skill (APIs, tools, auth needed)
2. Ask the user for any required credentials
3. Generate a complete SKILL.md
4. Test it with sample input
5. Install it to ${skillsDir}/{skill-name}/SKILL.md

The skill should be immediately usable after creation.`;

    console.log(`[create-skill] Invoking Claude to create skill: "${description}"`);
    console.log('[create-skill] Claude will research the implementation and may ask questions.\n');

    // Use interactive mode (no --print) so Claude can prompt for credentials
    const result = spawnS(
      'claude',
      ['--allowedTools', 'Read,Write,Bash,WebFetch', '--add-dir', skillsDir, '-p', prompt],
      {
        stdio: 'inherit',
        encoding: 'utf8',
        timeout: 600_000,
      }
    );

    if (result.status !== 0) {
      console.error(`[create-skill] Claude exited with status ${result.status}`);
      process.exit(result.status ?? 1);
    }

    // Confirm the skill was installed
    const newSkills = require('fs').readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);

    console.log('\n[create-skill] Done. Installed skills:');
    for (const s of newSkills.sort()) console.log(`  ${s}`);
  });

program.parse(process.argv);
