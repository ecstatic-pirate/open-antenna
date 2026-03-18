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
  .action(() => {
    // TODO: implement in Phase 2
    console.log('test-notify: coming in Phase 2');
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
  .description('Start the WhatsApp bridge daemon')
  .option('-c, --config <path>', 'Path to config.yaml', './config.yaml')
  .action(() => {
    // TODO: implement in Phase 2
    console.log('bridge start: coming in Phase 2');
  });

bridge
  .command('stop')
  .description('Stop the WhatsApp bridge daemon')
  .action(() => {
    console.log('bridge stop: coming in Phase 2');
  });

bridge
  .command('status')
  .description('Check if the bridge daemon is running')
  .action(() => {
    console.log('bridge status: coming in Phase 2');
  });

bridge
  .command('logs')
  .description('Tail the bridge log')
  .action(() => {
    console.log('bridge logs: coming in Phase 2');
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
        // Parse first line of description from frontmatter
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
