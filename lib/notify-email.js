'use strict';

/**
 * Email notification via nodemailer.
 *
 * Sends the digest PDF (or markdown) as an email attachment.
 * SMTP password is read from the environment variable named in
 * config.notifications.email.smtp_pass_env — never from the config file itself.
 */

const fs = require('fs');
const path = require('path');

/**
 * Send the digest via email.
 *
 * @param {object} config - Parsed config.yaml
 * @param {string} digestPath - Absolute path to the digest file (md or pdf)
 */
async function send(config, digestPath) {
  const emailConfig = config.notifications?.email;
  if (!emailConfig?.enabled) {
    console.log('[notify-email] Disabled — skipping.');
    return;
  }

  // Validate required fields
  const required = ['smtp_host', 'smtp_user', 'smtp_pass_env', 'to'];
  const missing = required.filter((k) => !emailConfig[k]);
  if (missing.length > 0) {
    throw new Error(`[notify-email] Missing config fields: ${missing.join(', ')}`);
  }

  // Read SMTP password from env var — never from the config file
  const smtpPass = process.env[emailConfig.smtp_pass_env];
  if (!smtpPass) {
    throw new Error(
      `[notify-email] SMTP password env var '${emailConfig.smtp_pass_env}' is not set.`
    );
  }

  if (!fs.existsSync(digestPath)) {
    throw new Error(`[notify-email] Digest file not found: ${digestPath}`);
  }

  // Lazy-load nodemailer — it's a required dependency but we only need it here
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch {
    throw new Error(
      '[notify-email] nodemailer is not installed. Run: npm install (from the antenna project directory)'
    );
  }

  const smtpPort = emailConfig.smtp_port ?? 587;
  const transporter = nodemailer.createTransport({
    host: emailConfig.smtp_host,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: {
      user: emailConfig.smtp_user,
      pass: smtpPass,
    },
  });

  const date = new Date().toISOString().split('T')[0];
  const prefix = emailConfig.subject_prefix ?? '[Daily Intel]';
  const subject = `${prefix} ${date}`;
  const filename = path.basename(digestPath);
  const isPdf = digestPath.endsWith('.pdf');

  const mailOptions = {
    from: emailConfig.smtp_user,
    to: emailConfig.to,
    subject,
    text: `Your daily intelligence briefing for ${date} is attached.`,
    attachments: [
      {
        filename,
        path: digestPath,
        contentType: isPdf ? 'application/pdf' : 'text/markdown',
      },
    ],
  };

  console.log(`[notify-email] Sending to ${emailConfig.to}...`);
  await transporter.sendMail(mailOptions);
  console.log('[notify-email] Sent.');
}

module.exports = { send };
