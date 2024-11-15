const fs = require('fs');
const nodes7 = require('nodes7'); // Use nodes7 as the library
const express = require('express');
const jsonc = require('jsonc-parser');
const winston = require('winston');
require('winston-daily-rotate-file');

const app = express();

// Read and parse the configuration file
const jsonData = fs.readFileSync('config.json', 'utf8');
const config = jsonc.parse(jsonData);

// Configure Winston Logger
const logger = winston.createLogger({
  level: 'info', // Default log level
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level.toUpperCase()}]: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console({ level: 'warn' }), // Console shows warnings and errors
    new winston.transports.DailyRotateFile({
      filename: 'plc-app-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      level: 'info', // File logs info and above
      maxSize: '20m',
      maxFiles: '14d'
    }),
    new winston.transports.DailyRotateFile({
      filename: 'plc-errors-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      level: 'error', // Separate file for errors
      maxSize: '20m',
      maxFiles: '14d'
    })
  ]
});

// Extract API configuration from config file
const { baseUrl, dataEndpoint, manualEndpoint } = config.apiConfig;
const fullBaseUrl = `${baseUrl}:${config.httpPort}`;

// Global variables and configuration
let combinedData = {};
let serverHeartbeat = 0;
const plcConnections = {};
const plcVars = {};

// Initialize read and write counters
const counters = {
  readCounters: {
    totalReads: 0,
    perPLC: {}
  },
  writeCounters: {
    totalWrites: 0,
    perPLC: {}
  }
};

// Operation locks to prevent overlapping operations
const operationLocks = {};

// Define the PLC variables with separate read and write mappings
for (const targetPlc of config.plcs) {
  plcVars[targetPlc.name] = {};
  counters.readCounters.perPLC[targetPlc.name] = 0;
  counters.writeCounters.perPLC[targetPlc.name] = 0;
  operationLocks[targetPlc.name] = false;

  // Read Variables
  for (const [key, descriptor] of Object.entries(targetPlc.variables)) {
    if (Array.isArray(descriptor)) {
      descriptor.forEach((desc, index) => {
        const varName = `${targetPlc.name}__read__${key}_${index}`;
        plcVars[targetPlc.name][varName] = `DB${targetPlc.dbNumber},${desc.type}${desc.offset}`;
      });
    } else if (descriptor.type === "BOOL") {
      const varName = `${targetPlc.name}__read__${key}`;
      plcVars[targetPlc.name][varName] = `DB${targetPlc.dbNumber},X${descriptor.byte}.${descriptor.bit}`;
    } else {
      const varName = `${targetPlc.name}__read__${key}`;
      plcVars[targetPlc.name][varName] = `DB${targetPlc.dbNumber},${descriptor.type}${descriptor.offset}`;
    }
  }

  // Write Variables for All PLCs (including server heartbeat)

  let currentOffset = 0;

  for (const sourcePlc of config.plcs) {
    const sourceOffset = sourcePlc.syncDbOffset;

    for (const [key, descriptor] of Object.entries(sourcePlc.variables)) {
      if (Array.isArray(descriptor)) {
        descriptor.forEach((desc, index) => {
          const varName = `${sourcePlc.name}__write__${key}_${index}`;
          plcVars[targetPlc.name][varName] = `DB${targetPlc.syncDbNumber || config.syncDbNumber},${desc.type}${desc.offset + sourceOffset}`;
          currentOffset = Math.max(currentOffset, desc.offset + sourceOffset + getSizeOfType(desc.type));
        });
      } else if (descriptor.type === "BOOL") {
        const varName = `${sourcePlc.name}__write__${key}`;
        plcVars[targetPlc.name][varName] = `DB${targetPlc.syncDbNumber || config.syncDbNumber},X${descriptor.byte + sourceOffset}.${descriptor.bit}`;
        currentOffset = Math.max(currentOffset, descriptor.byte + sourceOffset + 1); // BOOLs are 1 bit, increment accordingly
      } else {
        const varName = `${sourcePlc.name}__write__${key}`;
        plcVars[targetPlc.name][varName] = `DB${targetPlc.syncDbNumber || config.syncDbNumber},${descriptor.type}${descriptor.offset + sourceOffset}`;
        currentOffset = Math.max(currentOffset, descriptor.offset + sourceOffset + getSizeOfType(descriptor.type));
      }
    }
  }

  // Server Heartbeat Variable - place after all PLC variables
  const heartbeatVarName = `${targetPlc.name}__write__server_heartbeat`;
  plcVars[targetPlc.name][heartbeatVarName] = `DB${targetPlc.syncDbNumber || config.syncDbNumber},INT${currentOffset}`;
}

// Helper function to determine the size of each data type
function getSizeOfType(type) {
    switch (type) {
      case 'BOOL':
        return 1; // 1 bit
      case 'INT':
        return 2; // 2 bytes
      case 'REAL':
        return 4; // 4 bytes
      default:
        throw new Error(`Unknown data type: ${type}`);
    }
  }

// Debug: Log all variable mappings
for (const plcName in plcVars) {
  logger.debug(`Variables for ${plcName}: ${JSON.stringify(plcVars[plcName])}`);
}
// Function to establish a persistent connection to each PLC with reconnection logic
async function connectToPLC(plc) {
    const conn = new nodes7();
    plcConnections[plc.name] = conn;
  
    let attempts = 0;
  
    const tryConnect = () => {
      return new Promise((resolve, reject) => {
        conn.initiateConnection({
          port: 102,
          host: plc.ip,
          rack: plc.rack,
          slot: plc.slot,
          debug: false // Ensure debug is set to false to reduce nodes7 debug output
        }, (err) => {
          if (err) {
            attempts += 1;
            logger.error(`Connection error to ${plc.name} (${plc.ip}): ${err.message}. Attempt ${attempts}/${config.maxReconnectAttempts}`);
            if (attempts < config.maxReconnectAttempts) {
              setTimeout(() => resolve(tryConnect()), config.reconnectInterval);
            } else {
              logger.error(`Max reconnection attempts reached for ${plc.name}`);
              reject(err);
            }
          } else {
            logger.info(`Connected to ${plc.name} (${plc.ip})`);
            attempts = 0;
            // Optionally disable optimization if needed
            conn.globalOptions = {
              doNotOptimize: false,
              optimizeRead: true,
              optimizeWrite: true
            };
  
            // Set the translation callback **before** adding items
            conn.setTranslationCB(tag => plcVars[plc.name][tag] || null);
  
            // Add read items once during connection initialization
            const readVars = Object.keys(plcVars[plc.name]).filter(key => key.includes('__read__'));
            conn.addItems(readVars);
  
            resolve(conn);
          }
        });
      });
    };
  
    return tryConnect();
  }
  
  // Establish connections to all PLCs at startup
  async function initializeConnections() {
    for (const plc of config.plcs) {
      await connectToPLC(plc).catch(err => logger.error(`Failed to connect to ${plc.name}: ${err.message}`));
    }
  }
  
  // Read data from a PLC
  async function readPLCData(plc) {
    const conn = plcConnections[plc.name];
    if (!conn) {
      logger.warn(`No active connection for PLC ${plc.name}`);
      return;
    }
  
    return new Promise((resolve, reject) => {
      conn.readAllItems((err, values) => {
        if (err) {
          logger.error(`Error reading data from PLC ${plc.name}: ${err.message}`);
          return reject(err);
        } else {
          const cleanedValues = {};
          for (const [fullKey, value] of Object.entries(values)) {
            const key = fullKey.replace(`${plc.name}__read__`, '');
            cleanedValues[key] = value;
          }
          combinedData[plc.name] = cleanedValues;
          counters.readCounters.totalReads += 1;
          counters.readCounters.perPLC[plc.name] += 1;
          logger.debug(`Values read for PLC ${plc.name}: ${JSON.stringify(cleanedValues)}`);
          resolve();
        }
      });
    });
  }
  
  // Function to sync data to PLC
  async function syncDataToPLC(targetPlc) {
    const conn = plcConnections[targetPlc.name];
    if (!conn) {
      logger.warn(`No active connection for PLC ${targetPlc.name}`);
      return;
    }
  
    if (Object.keys(combinedData).length === 0) {
      logger.warn(`No data available to sync for PLC ${targetPlc.name}`);
      return;
    }
  
    // Prevent overlapping operations
    if (operationLocks[targetPlc.name]) {
      logger.warn(`Sync operation already in progress for PLC ${targetPlc.name}`);
      return;
    }
  
    operationLocks[targetPlc.name] = true;
  
    try {
      const dataToWrite = {};
  
      // Loop over all PLCs to get their data
      for (const sourcePlcName in combinedData) {
        const plcData = combinedData[sourcePlcName];
  
        for (const [key, value] of Object.entries(plcData)) {
          const writeVarName = `${sourcePlcName}__write__${key}`;
          if (plcVars[targetPlc.name][writeVarName]) {
            dataToWrite[writeVarName] = value !== undefined ? value : 0;
          } else {
            logger.warn(`Variable ${writeVarName} for PLC ${targetPlc.name} not found or improperly configured.`);
          }
        }
      }
  
      // Include the server's heartbeat
      const heartbeatVarName = `${targetPlc.name}__write__server_heartbeat`;
      if (plcVars[targetPlc.name][heartbeatVarName] !== undefined) {
        dataToWrite[heartbeatVarName] = serverHeartbeat;
      } else {
        logger.warn(`Heartbeat variable ${heartbeatVarName} not defined for PLC ${targetPlc.name}.`);
      }
  
      const keys = Object.keys(dataToWrite);
      const values = Object.values(dataToWrite);
  
      // Perform the write operation
      await new Promise((resolve, reject) => {
        conn.writeItems(keys, values, (err) => {
          if (err) {
            logger.error(`Error writing data to PLC ${targetPlc.name}: ${err.message}`);
            return reject(err);
          } else {
            // Increment counters
            counters.writeCounters.totalWrites += 1;
            counters.writeCounters.perPLC[targetPlc.name] += 1;
  
            // Log the updated counters
            logger.info(`Sync DB write #${counters.writeCounters.totalWrites} for PLC ${targetPlc.name}. Total writes: ${counters.writeCounters.totalWrites}, PLC Writes: ${counters.writeCounters.perPLC[targetPlc.name]}`);
  
            resolve();
          }
        });
      });
    } catch (error) {
      logger.error(`Error writing data to PLC ${targetPlc.name}: ${error.message}`);
    } finally {
      // Release the lock regardless of success or failure
      operationLocks[targetPlc.name] = false;
    }
  }
  // Function to update all PLCs
async function updateAllPLCs() {
    serverHeartbeat = (serverHeartbeat + 1) % 256;
  
    // Read data from all PLCs sequentially
    for (const plc of config.plcs) {
      try {
        await readPLCData(plc);
      } catch (error) {
        logger.error(`Failed to read data from PLC ${plc.name}: ${error.message}`);
      }
    }
  
    // Sync data to all PLCs sequentially
    for (const plc of config.plcs) {
      await syncDataToPLC(plc);
    }
  }
  
  // Start periodic updates after establishing connections
  initializeConnections()
    .then(() => {
      logger.info("All PLC connections established, starting periodic updates.");
      setInterval(updateAllPLCs, config.operationInterval || 5000);
    })
    .catch(err => logger.error("Initialization failed:", err));
  
  // Serve combined data via HTTP
app.get(dataEndpoint, (req, res) => {
  res.json({
    serverHeartbeat,
    combinedData,
    counters,
    manualURL: `${fullBaseUrl}${manualEndpoint}` // Construct the full URL using baseUrl and manualEndpoint
  });
});

// Serve the manual via HTTP
app.get(manualEndpoint, (req, res) => {
  res.sendFile(__dirname + '/manual.html');
});

// Start the HTTP server
app.listen(config.httpPort, () => {
  logger.info(`Server running on ${fullBaseUrl}`);
});
  
  // Graceful Shutdown
  process.on('SIGINT', () => {
    logger.info('Shutting down gracefully...');
    for (const plcName in plcConnections) {
      logger.debug(`Closing connection for ${plcName}: ${JSON.stringify(plcConnections[plcName])}`);
      if (typeof plcConnections[plcName].closeConnection === 'function') {
        plcConnections[plcName].closeConnection();
        logger.info(`Closed connection to ${plcName}`);
      } else {
        logger.error(`closeConnection is not a function for ${plcName}`);
      }
    }
    process.exit();
  });
  
  // Error handlers
  process.on('unhandledRejection', (reason, promise) => {
    logger.error(`Unhandled Rejection at: ${promise} reason: ${reason}`);
  });
  
  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught Exception thrown: ${err}`);
  });
  