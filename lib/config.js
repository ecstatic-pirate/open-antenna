'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/**
 * Load and parse config.yaml from the given path.
 * Throws if the file does not exist.
 *
 * @param {string} configPath
 * @returns {object} Parsed config object
 */
function loadConfig(configPath) {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `Config file not found: ${resolved}\nRun 'antenna init' to create one, or copy config/default.yaml.`
    );
  }
  const raw = fs.readFileSync(resolved, 'utf8');
  return yaml.load(raw);
}

module.exports = { loadConfig };
