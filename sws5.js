// Import necessary modules and libraries
const fs = require('fs'); // File system module for reading files
const express = require('express'); // Express framework for building web servers
const basicAuth = require('express-basic-auth');
const https = require('https'); //we need to enable this for https connections
const bcrypt = require('bcrypt'); // Bcrypt for password hashing
const saltRounds = 10; // Number of salt rounds for bcrypt
const jsonc = require('jsonc-parser'); // JSON parser that supports comments
const logger = require('./logger'); // extracted winston logger (see logger.js)
const readLastLines = require('read-last-lines'); // Module to read last lines from a file
const path = require('path'); // Path module for handling file paths
const bodyParser = require('body-parser'); // Middleware to parse JSON bodies
const util = require('util'); // Utility module for inspecting objects
const favicon = require('serve-favicon'); // Middleware to serve favicon
const mqtt = require('mqtt'); // MQTT client library

const mqttClients = [];  // Array to hold clients from multiple brokers
const mqttData = {};     // Global object to store the latest values

// Add a reconnection attempt interval (e.g., every 60 seconds)
const RECONNECT_INTERVAL = 60000; // 60 seconds

// Read in your SSL certificate and key
const httpsOptions = {
  key: fs.readFileSync('./certs/key.pem'),
  cert: fs.readFileSync('./certs/cert.pem')
};

// Auth, Express app and HTTP endpoints moved to web-api.js (Stage 3).

// Read and parse the configuration file with comments
const { loadConfig } = require('./config-loader');
const config = loadConfig('config.new.json');
const DRY_RUN = config.dryRun === true;
if (DRY_RUN) logger.warn('sws4 running in DRY-RUN mode: sync writes are computed and logged but NOT written to PLCs.');

const layout = require('./layout'); // shared offset/alignment engine (single source of truth, Phase B)

/**
 * Determines the end byte of a PLC variable based on its type and offsets.
 *
 * @param {Object} descriptor - The descriptor of the variable.
 * @returns {number} - The end byte index of the variable.
 * @throws Will throw an error if the variable type is unknown.
 */
function determineVariableEndByte(descriptor) {
  return layout.endByte(descriptor); // delegated to shared layout.js (Phase B)
}

/**
 * Aligns a given offset to the nearest even boundary.
 *
 * @param {number} offset - The current offset.
 * @returns {number} - The aligned offset.
 */
function alignToEvenBoundary(offset) {
  return layout.alignEven(offset); // delegated to shared layout.js (Phase B)
}

/**
 * Calculates synchronization database offsets for all PLCs in the configuration.
 * This ensures that each PLC has a unique memory region for synchronization data.
 *
 * @param {Object} config - The configuration object containing PLC definitions.
 */
function calculateSyncDbOffsets(config) {
  layout.computeSyncDbOffsets(config.plcs); // delegated to shared layout.js (sets plc.syncDbOffset in place)
}


// Extract API configuration from the config file
const { baseUrl, dataEndpoint, guiEndpoint, manualEndpoint } = config.apiConfig;
const fullBaseUrl = `${baseUrl}:${config.httpPort}`;

// Iterate through each MQTT configuration
config.mqttConfigs.forEach((mqttConfig, index) => {
  const client = mqtt.connect(mqttConfig.brokerUrl);

  client.on('connect', () => {
    logger.info(`Connected to MQTT broker at ${mqttConfig.brokerUrl}`);
    // Check if subscribeTopics exists before iterating
    if (mqttConfig.subscribeTopics) {
      Object.keys(mqttConfig.subscribeTopics).forEach(topic => {
        client.subscribe(topic, (err) => {
          if (err) {
            logger.error(`Failed to subscribe to ${topic} on broker ${mqttConfig.brokerUrl}: ${err.message}`);
          } else {
            logger.info(`Subscribed to topic ${topic} on broker ${mqttConfig.brokerUrl}`);
          }
        });
      });
    }
  });

  client.on('message', (topic, message) => {
    if (mqttConfig.subscribeTopics) {
      const mapping = mqttConfig.subscribeTopics[topic];
      if (mapping) {
        let value;
        try {
          const rawValue = message.toString();
          switch (mapping.dataType) {
            case 'BOOL':
              value = (rawValue.toLowerCase() === 'true' || rawValue === '1');
              break;
            case 'INT':
              value = parseInt(rawValue, 10);
              if (isNaN(value)) throw new Error("Invalid integer");
              break;
            case 'REAL':
              value = parseFloat(rawValue);
              if (isNaN(value)) throw new Error("Invalid float");
              break;
            default:
              value = rawValue;
          }
          // Update global mqttData; decide on your merge strategy if multiple updates occur
          mqttData[mapping.syncVariable] = value;
          logger.info(`MQTT update: ${mapping.syncVariable} = ${value} (from ${mqttConfig.brokerUrl})`);
        } catch (e) {
          logger.error(`Error processing MQTT message on topic ${topic} from broker ${mqttConfig.brokerUrl}: ${e.message}`);
        }
      } else {
        logger.warn(`No MQTT mapping found for topic ${topic} on broker ${mqttConfig.brokerUrl}`);
      }
    }
  });

  mqttClients.push(client);
});


// Initialize global variables and configuration objects
let combinedData = {}; // Stores combined data from all PLCs
// Shared mutable state read/written by both the sync loop and web-api.js.
// serverHeartbeat increments each cycle; syncPaused is toggled via /sync/pause|resume.
const state = { serverHeartbeat: 0, syncPaused: false };
const plcVars = {}; // Holds variable mappings for each PLC

// Initialize read and write counters for monitoring
const counters = {
  readCounters: {
    totalReads: 0,
    perPLC: {},
  },
  writeCounters: {
    totalWrites: 0,
    perPLC: {},
  },
};

// Operation locks to prevent overlapping read/write operations
const operationLocks = {};
const operationLockTimestamps = {};  // e.g. { PLC_1: timestamp }

/**
 * Determines the size in bytes of a given data type.
 *
 * @param {string} type - The data type (e.g., BOOL, INT, REAL).
 * @returns {number} - The size in bytes of the type.
 * @throws Will throw an error if the data type is unknown.
 */
function getSizeOfType(type) {
  switch (type) {
    case 'BOOL':
      return 1; // 1 byte for simplicity
    case 'INT':
      return 2; // 2 bytes
    case 'REAL':
      return 4; // 4 bytes
    default:
      throw new Error(`Unknown data type: ${type}`);
  }
}

// Define PLC variables with separate read and write mappings
for (const targetPlc of config.plcs) {
  plcVars[targetPlc.name] = {}; // Initialize variable mappings for the PLC
  counters.readCounters.perPLC[targetPlc.name] = 0; // Initialize read counter
  counters.writeCounters.perPLC[targetPlc.name] = 0; // Initialize write counter
  operationLocks[targetPlc.name] = false; // Initialize operation lock

  // Define Read Variables
  for (const [key, descriptor] of Object.entries(targetPlc.variables)) {
    if (Array.isArray(descriptor)) {
      // Handle array of descriptors (multiple instances)
      descriptor.forEach((desc, index) => {
        const varName = `${targetPlc.name}__read__${key}_${index}`;
        plcVars[targetPlc.name][varName] = `DB${targetPlc.dbNumber},${desc.type}${desc.offset}`;
      });
    } else if (descriptor.type === 'BOOL') {
      // Handle BOOL type variables
      const varName = `${targetPlc.name}__read__${key}`;
      plcVars[targetPlc.name][varName] = `DB${targetPlc.dbNumber},X${descriptor.byte}.${descriptor.bit}`;
    } else {
      // Handle other data types (e.g., INT, REAL)
      const varName = `${targetPlc.name}__read__${key}`;
      plcVars[targetPlc.name][varName] = `DB${targetPlc.dbNumber},${descriptor.type}${descriptor.offset}`;
    }
  }

  // Define Write Variables for Actual PLC Variables
  for (const [key, descriptor] of Object.entries(targetPlc.variables)) {
    if (Array.isArray(descriptor)) {
      // Handle array of descriptors for write operations
      descriptor.forEach((desc, index) => {
        const varName = `${targetPlc.name}__write__${key}_${index}`;
        plcVars[targetPlc.name][varName] = `DB${targetPlc.dbNumber},${desc.type}${desc.offset}`;
      });
    } else if (descriptor.type === 'BOOL') {
      // Handle BOOL type variables for write operations
      const varName = `${targetPlc.name}__write__${key}`;
      plcVars[targetPlc.name][varName] = `DB${targetPlc.dbNumber},X${descriptor.byte}.${descriptor.bit}`;
    } else {
      // Handle other data types for write operations
      const varName = `${targetPlc.name}__write__${key}`;
      plcVars[targetPlc.name][varName] = `DB${targetPlc.dbNumber},${descriptor.type}${descriptor.offset}`;
    }
  }

  // Define Write Variables for Synchronization
  let currentOffset = 0;

  for (const sourcePlc of config.plcs) {
    const sourceOffset = sourcePlc.syncDbOffset;

    for (const [key, descriptor] of Object.entries(sourcePlc.variables)) {
      if (Array.isArray(descriptor)) {
        // Handle array of descriptors for synchronization
        descriptor.forEach((desc, index) => {
          const varName = `${sourcePlc.name}__sync__${key}_${index}`;
          plcVars[targetPlc.name][varName] = `DB${sourcePlc.syncDbNumber || config.syncDbNumber},${desc.type}${desc.offset + sourceOffset}`;
          // Update currentOffset to the maximum used
          currentOffset = Math.max(currentOffset, desc.offset + sourceOffset + getSizeOfType(desc.type));
        });
      } else if (descriptor.type === 'BOOL') {
        // Handle BOOL type variables for synchronization
        const varName = `${sourcePlc.name}__sync__${key}`;
        plcVars[targetPlc.name][varName] = `DB${sourcePlc.syncDbNumber || config.syncDbNumber},X${descriptor.byte + sourceOffset}.${descriptor.bit}`;
        // BOOL occupies 1 byte for next offset alignment
        currentOffset = Math.max(currentOffset, descriptor.byte + sourceOffset + 1);
      } else {
        // Handle other data types for synchronization
        const varName = `${sourcePlc.name}__sync__${key}`;
        plcVars[targetPlc.name][varName] = `DB${sourcePlc.syncDbNumber || config.syncDbNumber},${descriptor.type}${descriptor.offset + sourceOffset}`;
        currentOffset = Math.max(currentOffset, descriptor.offset + sourceOffset + getSizeOfType(descriptor.type));
      }
    }
  }

  // Define Server Heartbeat Variable
  const heartbeatVarName = `${targetPlc.name}__sync__server_heartbeat`;
  plcVars[targetPlc.name][heartbeatVarName] = `DB${targetPlc.syncDbNumber || config.syncDbNumber},INT${currentOffset}`;
}

// Debug: Log all variable mappings for each PLC
for (const plcName in plcVars) {
  logger.debug(`Variables for ${plcName}: ${util.inspect(plcVars[plcName], { depth: null })}`);
}

const { PlcConnection, PlcConnectionManager, errMsg } = require('./plc-connection');

const plcConnObjects = config.plcs.map((plc) => {
  const items = Object.keys(plcVars[plc.name]); // read + sync + write tags
  return new PlcConnection(plc, {
    items,
    translate: (tag) => plcVars[plc.name][tag] || tag,
    logger,
    softFailThreshold: config.softFailThreshold ?? 3,
    backoffBaseMs: config.reconnectInterval || 2000,
    backoffCapMs: config.reconnectBackoffCapMs ?? 60000,
    heartbeatStallThreshold: config.heartbeatStallThreshold ?? 3,
    heartbeatKey: `${plc.name}__sync__server_heartbeat`,
    detectHeartbeatStall: !DRY_RUN, // dry-run does not write the heartbeat
  });
});
const plcManager = new PlcConnectionManager(plcConnObjects);
const { SyncEngine } = require('./sync-engine');
const syncEngine = new SyncEngine({ plcVars, logger });

async function syncDataToPLC(conn) {
  const targetPlc = conn.plc;
  if (!conn.reachable) {
    logger.warn(`No active connection for PLC ${targetPlc.name}`);
    return;
  }

  if (Object.keys(combinedData).length === 0) {
    logger.warn(`No data available to sync for PLC ${targetPlc.name}`);
    return;
  }

  // Define a timeout for sync operations (milliseconds)
  const LOCK_TIMEOUT = 10000; // e.g., 10 seconds

  // Check if a sync is already in progress for this PLC
  if (operationLocks[targetPlc.name]) {
    // If a timestamp exists, check if the lock is stale
    if (operationLockTimestamps[targetPlc.name] &&
        (Date.now() - operationLockTimestamps[targetPlc.name] > LOCK_TIMEOUT)) {
      logger.warn(`Sync operation lock for ${targetPlc.name} is stale. Clearing it.`);
      operationLocks[targetPlc.name] = false;
      delete operationLockTimestamps[targetPlc.name];
    } else {
      logger.warn(`Sync operation already in progress for PLC ${targetPlc.name}`);
      return;
    }
  }

  // Acquire the sync lock and record the timestamp
  operationLocks[targetPlc.name] = true;
  operationLockTimestamps[targetPlc.name] = Date.now();

  try {
    // Delta-sync: build the full set (sws3-equivalent), compute only the changed
    // vars vs the last write, and write just those. The heartbeat increments each
    // cycle so it is always in the delta; (re)connect re-baselines (full write).
    const full = syncEngine.buildFullSet(targetPlc.name, combinedData, state.serverHeartbeat);
    const { keys, values, isBaseline } = syncEngine.computeDelta(targetPlc.name, conn.connectGen, full);

    if (DRY_RUN) {
      logger.info(`[DRY-RUN] ${isBaseline ? 'baseline' : 'delta'} ${keys.length}/${Object.keys(full).length} items to ${targetPlc.name}`);
      syncEngine.commit(targetPlc.name, conn.connectGen, full);
      counters.writeCounters.totalWrites += 1;
      counters.writeCounters.perPLC[targetPlc.name] += 1;
      return;
    }

    if (keys.length > 0) {
      await conn.write(keys, values);
      syncEngine.commit(targetPlc.name, conn.connectGen, full);
      counters.writeCounters.totalWrites += 1;
      counters.writeCounters.perPLC[targetPlc.name] += 1;
    }
  } catch (error) {
    syncEngine.invalidate(targetPlc.name);
    logger.error(`Error writing data to PLC ${targetPlc.name}: ${error.message || util.inspect(error)}`);
  } finally {
    // Clear the sync lock and its timestamp
    operationLocks[targetPlc.name] = false;
    delete operationLockTimestamps[targetPlc.name];
  }
}


/**
 * Updates all PLCs by reading data and synchronizing it.
 */
async function updateAllPLCs() {
  state.serverHeartbeat = (state.serverHeartbeat + 1) % 256;

  // Read all connected PLCs in parallel; kick non-blocking reconnects for the rest.
  const rawByPlc = await plcManager.tick();

  // Build combinedData (read vars only, prefix stripped) — same shape as before.
  for (const plc of config.plcs) {
    const raw = rawByPlc[plc.name];
    if (!raw) continue;
    const cleaned = {};
    for (const [fullKey, value] of Object.entries(raw)) {
      if (fullKey.includes('__read__')) {
        cleaned[fullKey.replace(`${plc.name}__read__`, '')] = value;
      }
    }
    combinedData[plc.name] = cleaned;
    counters.readCounters.totalReads += 1;
    counters.readCounters.perPLC[plc.name] += 1;
  }

  publishPLCData();

  if (!state.syncPaused) {
    for (const conn of plcManager.connections) {
      if (conn.reachable) await syncDataToPLC(conn);
    }
  }
}

// Start periodic updates immediately — the manager handles connect/backoff
// non-blocking, so we never wait on (offline) PLCs before the loop starts.
logger.info('Starting periodic PLC updates (manager handles connect/backoff).');
console.log(`[${new Date().toISOString()}] sws4 sync loop started (interval: ${config.operationInterval || 2000}ms)`);
setInterval(updateAllPLCs, config.operationInterval || 2000);

//publish synced plc data to MQTT
function publishPLCData() {
  // Aggregate the data you want to publish
  const payload = JSON.stringify({
    serverHeartbeat: state.serverHeartbeat,
    combinedData,
    mqttData
  });
  // Loop over each MQTT configuration/client
  config.mqttConfigs.forEach((mqttConfig, index) => {
    if (mqttConfig.publishTopic) {
      mqttClients[index].publish(mqttConfig.publishTopic, payload, (err) => {
        if (err) {
          logger.error(`Error publishing to ${mqttConfig.brokerUrl} on topic ${mqttConfig.publishTopic}: ${err.message}`);
        } else {
          // Reduced logging - only debug level for successful publishes
          logger.debug(`Published PLC data to ${mqttConfig.brokerUrl} on topic ${mqttConfig.publishTopic}`);
        }
      });
    }
  });
}

// HTTP API + HTTPS server (all endpoints live in web-api.js).
const createApp = require('./web-api');
const app = createApp({ config, logger, state, combinedData, counters, plcManager, plcVars, errMsg });
https.createServer(httpsOptions, app).listen(config.httpPort, () => {
  logger.info(`HTTPS Server running on port ${config.httpPort}`);
  console.log(`[${new Date().toISOString()}] PLC Sync Server started on port ${config.httpPort}`);
});

// Start the HTTP server and listen on the configured port
//app.listen(config.httpPort, () => {
//  logger.info(`Server running on ${fullBaseUrl}`); // Log server start message
//});

// Gracefully handle server shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down gracefully...');
  const closePromises = [];

  for (const c of plcManager.connections) {
    if (c.conn && typeof c.conn.dropConnection === 'function') {
      logger.debug(`Closing connection for ${c.plc.name}`);
      closePromises.push(
        new Promise((resolve) => {
          c.conn.dropConnection(() => {
            logger.info(`Closed connection to ${c.plc.name}`);
            resolve();
          });
        })
      );
    }
  }

  // Wait for all connections to close before exiting
  Promise.all(closePromises)
    .then(() => {
      logger.info('All connections closed. Exiting process.');
      process.exit(0); // Exit with success code
    })
    .catch((err) => {
      // Log any errors during shutdown
      logger.error(`Error during shutdown: ${err.message}`);
      process.exit(1); // Exit with error code
    });
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error(`Unhandled Rejection at: ${promise} reason: ${reason}`);
  process.exit(1); // Exit after logging
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception thrown: ${err.stack || err}`);
  process.exit(1); // Exit after logging
});
