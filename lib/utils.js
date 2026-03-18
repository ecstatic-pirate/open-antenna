'use strict';

const { spawnSync } = require('child_process');

/**
 * Check if a binary is available on PATH.
 * @param {string} name - Binary name
 * @returns {boolean}
 */
function checkBin(name) {
  const result = spawnSync('which', [name], { encoding: 'utf8' });
  return result.status === 0;
}

/**
 * Return today's date string in YYYY-MM-DD format.
 * @returns {string}
 */
function todayString() {
  return new Date().toISOString().split('T')[0];
}

module.exports = { checkBin, todayString };
