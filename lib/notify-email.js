'use strict';

/**
 * Email notification via nodemailer.
 *
 * Sends the digest PDF as an email attachment to the configured recipient.
 *
 * TODO: Implement in Phase 2.
 */

/**
 * Send the digest via email.
 *
 * @param {object} config - Parsed config.yaml
 * @param {string} digestPath - Absolute path to the digest file (md or pdf)
 */
async function send(config, digestPath) {
  // TODO: Phase 2
  // 1. Read SMTP config from config.notifications.email
  // 2. Read SMTP password from process.env[config.notifications.email.smtp_pass_env]
  // 3. Create nodemailer transporter
  // 4. Build email: subject = "{prefix} {date}", attach digestPath
  // 5. Send
  console.log('[notify-email] TODO: implement in Phase 2');
}

module.exports = { send };
