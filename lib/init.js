'use strict';

/**
 * antenna init — interactive setup wizard.
 *
 * Guides the user through:
 *   - Dependency checks (Node, Claude CLI, Python, wacli)
 *   - YouTube channel configuration
 *   - HN settings
 *   - User profile (name, role, topics)
 *   - WhatsApp notification setup
 *   - Email (SMTP) notification setup
 *   - WhatsApp bridge (two-way AI assistant)
 *   - Schedule (cron job)
 *   - Test notification
 *
 * TODO: Implement in Phase 4.
 * The init wizard is the final polish step — Phase 1 focuses on the core pipeline.
 */

async function init() {
  console.log('antenna init: interactive setup wizard coming in Phase 4.');
  console.log('');
  console.log('For now, copy the default config and edit it manually:');
  console.log('  cp node_modules/open-antenna/config/default.yaml ./config.yaml');
  console.log('  $EDITOR ./config.yaml');
  console.log('');
  console.log('Then run: antenna run');
}

module.exports = init;
