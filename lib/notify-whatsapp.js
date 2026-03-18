'use strict';

/**
 * WhatsApp notification via wacli.
 *
 * Sends the digest PDF (or a text hook) to the configured recipient.
 *
 * TODO: Implement in Phase 2.
 * Requires wacli installed and authenticated (handled by `antenna init`).
 */

/**
 * Send the digest to WhatsApp.
 *
 * @param {object} config - Parsed config.yaml
 * @param {string} digestPath - Absolute path to the digest file (md or pdf)
 */
async function send(config, digestPath) {
  // TODO: Phase 2
  // 1. Resolve wacli binary path (config.wacli_path or auto-detect)
  // 2. sync once: wacli sync --once --idle-exit 10s
  // 3. Send PDF: wacli send file --to {recipient} --file {digestPath}
  // 4. Send hook text: wacli send text --to {recipient} --message {insightHook}
  console.log('[notify-whatsapp] TODO: implement in Phase 2');
}

module.exports = { send };
