'use strict';

/**
 * WhatsApp notification via wacli.
 *
 * Sends the digest PDF (or markdown) to the configured recipient.
 * Requires wacli installed and authenticated (handled by `antenna init`).
 */

const { spawnSync } = require('child_process');
const fs = require('fs');

/**
 * Resolve the wacli binary path.
 * Checks WACLI_BIN env var first, then common locations, then PATH.
 */
function resolveWacli() {
  if (process.env.WACLI_BIN && fs.existsSync(process.env.WACLI_BIN)) {
    return process.env.WACLI_BIN;
  }

  // Common install locations
  const candidates = [
    '/opt/homebrew/bin/wacli',
    '/usr/local/bin/wacli',
    `${process.env.HOME}/.local/bin/wacli`,
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // Fall back to PATH lookup
  const which = spawnSync('which', ['wacli'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) {
    return which.stdout.trim();
  }

  throw new Error(
    'wacli not found. Run `antenna init` to install it, or set the WACLI_BIN environment variable.'
  );
}

/**
 * Run a wacli command synchronously. Throws on non-zero exit.
 */
function wacli(bin, args, { silent = false } = {}) {
  const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 60_000 });
  if (result.status !== 0 && !silent) {
    throw new Error(`wacli ${args[0]} failed (exit ${result.status}): ${result.stderr?.trim()}`);
  }
  return result;
}

/**
 * Send the digest to WhatsApp.
 *
 * Strategy:
 *   1. Sync once so wacli is connected and the store is up to date.
 *   2. If the digest is a PDF → send as file.
 *   3. Also send a short text hook so the recipient knows what arrived.
 *
 * @param {object} config - Parsed config.yaml
 * @param {string} digestPath - Absolute path to the digest file (md or pdf)
 */
async function send(config, digestPath) {
  const waConfig = config.notifications?.whatsapp;
  if (!waConfig?.enabled) {
    console.log('[notify-whatsapp] Disabled — skipping.');
    return;
  }

  const recipient = waConfig.recipient;
  if (!recipient) {
    throw new Error('[notify-whatsapp] notifications.whatsapp.recipient is not set in config.');
  }

  const bin = resolveWacli();

  // Sync once to ensure connection is active
  console.log('[notify-whatsapp] Syncing...');
  wacli(bin, ['sync', '--once', '--idle-exit', '10s'], { silent: true });

  const isPdf = digestPath.endsWith('.pdf');

  if (isPdf && fs.existsSync(digestPath)) {
    // Send the PDF as a file attachment
    console.log(`[notify-whatsapp] Sending PDF to ${recipient}...`);
    wacli(bin, ['send', 'file', '--to', recipient, '--file', digestPath]);
  } else if (fs.existsSync(digestPath)) {
    // Markdown fallback — read content and send as text
    const content = fs.readFileSync(digestPath, 'utf8');
    const preview = content.slice(0, 2000) + (content.length > 2000 ? '\n\n[truncated — see full digest]' : '');
    console.log(`[notify-whatsapp] Sending markdown digest to ${recipient}...`);
    wacli(bin, ['send', 'text', '--to', recipient, '--message', preview]);
    return;
  } else {
    throw new Error(`[notify-whatsapp] Digest file not found: ${digestPath}`);
  }

  // Send a text hook after the PDF so the chat shows context
  const date = new Date().toISOString().split('T')[0];
  const hookMessage = `Daily Intelligence Briefing — ${date}`;
  wacli(bin, ['send', 'text', '--to', recipient, '--message', hookMessage], { silent: true });
  console.log('[notify-whatsapp] Sent.');
}

module.exports = { send, resolveWacli };
