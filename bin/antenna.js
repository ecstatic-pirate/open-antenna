#!/usr/bin/env node

'use strict';

const { program } = require('commander');
const path = require('path');
const pkg = require('../package.json');

program
  .name('antenna')
  .description('AI-powered daily intelligence briefing from YouTube + Hacker News')
  .version(pkg.version);

// antenna run
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

// antenna init
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

// antenna test-notify
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

    // Generate a minimal sample PDF/markdown for testing
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

    // Convert to PDF if configured
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

    // WhatsApp
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

    // Email
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

// antenna schedule
program
  .command('schedule')
  .description('View or update the daily schedule')
  .option('-c, --config <path>', 'Path to config.yaml', './config.yaml')
  .action(() => {
    // TODO: implement in Phase 4
    console.log('schedule: coming in Phase 4');
  });

// antenna bridge <start|stop|status|logs>
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

// antenna skills
program
  .command('skills')
  .description('List installed skills')
  .option('--detail', 'Show description of each skill')
  .action((options) => {
    const fs = require('fs');
    const skillsDir = path.join(__dirname, '..', 'skills');
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);

    if (entries.length === 0) {
      console.log('No skills installed.');
      return;
    }

    console.log('Installed skills:\n');
    for (const name of entries) {
      const skillFile = path.join(skillsDir, name, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;

      if (options.detail) {
        const content = fs.readFileSync(skillFile, 'utf8');
        const descMatch = content.match(/^description:\s*>?\s*\n\s+(.+)/m);
        const desc = descMatch ? descMatch[1].trim() : '(no description)';
        console.log(`  ${name}\n    ${desc}\n`);
      } else {
        console.log(`  ${name}`);
      }
    }
  });

program.parse(process.argv);
