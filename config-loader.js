// config-loader.js — load + validate config, compute sync-DB offsets.
// Wraps the existing layout.js offset engine (single source of truth).
const fs = require('fs');
const jsonc = require('jsonc-parser');
const layout = require('./layout');

/**
 * Loads a config file (JSON-with-comments), validates the minimal shape,
 * and computes each PLC's syncDbOffset in place via layout.js.
 * @param {string} pathToConfig - path to config.json / config.new.json
 * @returns {object} parsed config with plc.syncDbOffset populated
 */
function loadConfig(pathToConfig) {
  const raw = fs.readFileSync(pathToConfig, 'utf8');
  const config = jsonc.parse(raw);
  if (!config || !Array.isArray(config.plcs)) {
    throw new Error('Invalid config: expected an object with a "plcs" array.');
  }
  layout.computeSyncDbOffsets(config.plcs); // sets plc.syncDbOffset in place
  return config;
}

module.exports = { loadConfig };
