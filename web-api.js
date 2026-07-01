// web-api.js — Express HTTP API for the PLC sync server. createApp(deps) returns
// the configured Express app; sws4 wraps it in the HTTPS server. All endpoint
// behaviour is moved verbatim from sws4; shared mutable state (serverHeartbeat,
// syncPaused) is read/written through deps.state.
const express = require('express');
const basicAuth = require('express-basic-auth');
const bodyParser = require('body-parser');
const favicon = require('serve-favicon');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const jsonc = require('jsonc-parser');
const readLastLines = require('read-last-lines');
const fieldManager = require('./field-manager');
const pkg = require('./package.json');

const saltRounds = 10;

function loadCredentials() {
  return JSON.parse(fs.readFileSync('credentials.json', 'utf8'));
}

function createApp(deps) {
  const { config, logger, state, combinedData, counters, plcManager, plcVars, errMsg } = deps;
  const { baseUrl, dataEndpoint, guiEndpoint, manualEndpoint } = config.apiConfig;
  const fullBaseUrl = `${baseUrl}:${config.httpPort}`;
  const credentials = loadCredentials();

  const myAuthorizer = (username, password) => {
    const storedHash = credentials[username];
    if (!storedHash) return false;
    return bcrypt.compareSync(password, storedHash);
  };

  const app = express();

  app.use(basicAuth({
    authorizer: myAuthorizer,
    authorizeAsync: false,
    challenge: true,
    unauthorizedResponse: (req) => (req.auth ? 'Credentials rejected' : 'No credentials provided'),
  }));
  app.use(bodyParser.json());

  // App version (single source: package.json) — shown in the GUI navbar.
  app.get('/version', (req, res) => res.json({ version: pkg.version }));

  // Combined data as JSON
  app.get(dataEndpoint, (req, res) => {
    res.json({
      serverHeartbeat: state.serverHeartbeat,
      combinedData,
      counters,
      guiURL: `${fullBaseUrl}${guiEndpoint}`,
    });
  });

  app.use('/static', express.static('static'));
  app.use(express.static(path.join(__dirname, 'public')));
  app.use(favicon(path.join(__dirname, 'public', 'favicon.ico')));

  app.get(manualEndpoint, (req, res) => res.sendFile(path.join(__dirname, 'manual.html')));
  app.get('/gui', (req, res) => res.sendFile(path.join(__dirname, 'gui.html')));
  app.get('/fields', (req, res) => res.sendFile(path.join(__dirname, 'field-manager.html')));

  app.post('/fields/preview', (req, res) => {
    try {
      const cfg = jsonc.parse(fs.readFileSync('config.json', 'utf8'));
      const { op, plc, name, type, fields } = req.body;
      res.json(fieldManager.generate(cfg, { op, plc, name, type, fields }));
    } catch (e) {
      res.status(400).send(e.message);
    }
  });

  app.get('/config', (req, res) => {
    fs.readFile('config.json', 'utf8', (err, data) => {
      if (err) {
        logger.error(`Error reading config file: ${err.message}`);
        res.status(500).send('Failed to load configuration.');
      } else {
        res.json(jsonc.parse(data));
      }
    });
  });

  app.post('/restart', (req, res) => {
    logger.info('Restart request received. Restarting server...');
    res.json({ success: true, message: 'Server restarting' });
    setTimeout(() => process.exit(0), 1000);
  });

  app.post('/sync/pause', (req, res) => {
    state.syncPaused = true;
    logger.warn('Sync WRITE paused via API (reads/status continue).');
    res.json({ paused: true });
  });
  app.post('/sync/resume', (req, res) => {
    state.syncPaused = false;
    logger.warn('Sync WRITE resumed via API.');
    res.json({ paused: false });
  });
  app.get('/sync/status', (req, res) => res.json({ paused: state.syncPaused }));

  app.get('/logs', (req, res) => {
    fs.readdir('./', (err, files) => {
      if (err) {
        logger.error(`Error reading logs directory: ${err.message}`);
        res.status(500).send('Error reading logs directory');
        return;
      }
      const logFiles = files
        .filter((file) => file.startsWith('plc-') && file.endsWith('.log'))
        .sort()
        .reverse();
      res.json(logFiles);
    });
  });

  app.get('/logs/:logFile', (req, res) => {
    const logFile = req.params.logFile;
    // Validate before touching the filesystem: reject path separators and
    // traversal, require the plc-<name>.log naming, then confirm the resolved
    // path stays inside the working directory (defence-in-depth vs path traversal).
    if (/[/\\]|\.\./.test(logFile) || !/^plc-[A-Za-z0-9._-]+\.log$/.test(logFile)) {
      return res.status(400).send('Invalid log file requested');
    }
    const logDir = path.resolve('./');
    const logFilePath = path.resolve(logDir, logFile);
    if (!logFilePath.startsWith(logDir + path.sep)) {
      return res.status(400).send('Invalid log file requested');
    }
    if (!fs.existsSync(logFilePath)) {
      logger.warn(`Log file ${logFile} does not exist`);
      return res.status(404).send('Log file not found');
    }
    readLastLines
      .read(logFilePath, 100)
      .then((lines) => res.send(lines))
      .catch((err) => {
        logger.error(`Error reading log file ${logFile}: ${err.message}`);
        res.status(500).send('Error reading log file');
      });
  });

  app.get('/plc/:plcName', (req, res) => {
    const plcName = req.params.plcName;
    if (combinedData[plcName]) res.json(combinedData[plcName]);
    else res.status(404).send(`PLC ${plcName} not found.`);
  });

  app.get('/status', (req, res) => {
    const plcStatus = {};
    for (const c of plcManager.connections) {
      plcStatus[c.plc.name] = {
        state: c.state,
        reachable: c.reachable,
        alive: c.alive,
        softFailCount: c.softFailCount,
        backoffMs: c.backoffMs,
      };
    }
    res.json({ serverHeartbeat: state.serverHeartbeat, plcStatus });
  });

  app.post('/plc/:plcName', (req, res) => {
    const plcName = req.params.plcName;
    const newData = req.body;
    try {
      const conn = plcManager.byName(plcName);
      if (!conn || !conn.reachable) {
        res.status(404).send(`PLC ${plcName} not found or not connected.`);
        return;
      }
      const keys = [];
      const values = [];
      for (const [key, value] of Object.entries(newData)) {
        const writeVarName = `${plcName}__write__${key}`;
        if (plcVars[plcName][writeVarName]) {
          keys.push(writeVarName);
          values.push(value);
        } else {
          logger.warn(`Variable ${writeVarName} not found in plcVars for PLC ${plcName}.`);
        }
      }
      conn.write(keys, values)
        .then(() => res.send('Data written successfully.'))
        .catch((err) => {
          logger.error(`Error writing data to PLC ${plcName}: ${errMsg(err)}`);
          res.status(500).send('Failed to write data to PLC.');
        });
    } catch (error) {
      logger.error(`Error in write endpoint: ${error.message}`);
      res.status(400).send('Invalid data format.');
    }
  });

  app.post('/config', (req, res) => {
    try {
      if (!req.body || !Array.isArray(req.body.plcs)) {
        return res.status(400).send('Invalid configuration: expected an object with a "plcs" array.');
      }
      const newConfig = JSON.stringify(req.body, null, 2);
      try {
        if (fs.existsSync('config.json')) fs.copyFileSync('config.json', 'config.json.bak');
      } catch (bErr) {
        logger.error(`Error backing up config file: ${bErr.message}`);
        return res.status(500).send('Failed to back up existing configuration; aborted (config.json unchanged).');
      }
      fs.writeFile('config.json', newConfig, 'utf8', (err) => {
        if (err) {
          logger.error(`Error saving config file: ${err.message}`);
          res.status(500).send('Failed to save configuration.');
        } else {
          res.send('Configuration saved successfully.');
        }
      });
    } catch (error) {
      logger.error(`Invalid configuration format: ${error.message}`);
      res.status(400).send('Invalid configuration format.');
    }
  });

  app.post('/update-credentials', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).send('Username and password are required.');
    }
    bcrypt.hash(password, saltRounds, (err, hash) => {
      if (err) return res.status(500).send('Error hashing password');
      const newCredentials = { [username]: hash };
      fs.writeFile('credentials.json', JSON.stringify(newCredentials, null, 2), 'utf8', (werr) => {
        if (werr) return res.status(500).send('Error writing credentials file');
        res.send('Credentials updated successfully.');
      });
    });
  });

  app.get('/logout', (req, res) => {
    res.set('WWW-Authenticate', 'Basic realm="PLC Sync Server"');
    res.status(401).send('Logged out');
  });

  app.get('/setup', (req, res) => res.sendFile(path.join(__dirname, 'config.html')));

  return app;
}

module.exports = createApp;
