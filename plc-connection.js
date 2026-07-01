// plc-connection.js — sws5 variant on @st-one-io/nodes7 (S7Endpoint + S7ItemGroup).
// SAME public interface as the nodes7 version (state machine fields, ensureConnecting,
// read, write, reachable, connectGen, alive) so sync-engine / manager / sws5.js are
// UNCHANGED. The fork self-manages the connection (auto-connect + fixed-interval
// autoReconnect) and is event-driven, so this wrapper delegates connection lifecycle
// to S7Endpoint and tracks state via its 'connect'/'disconnect'/'error' events.
//
// EXPERIMENT NOTE (v1): the custom exponential backoff + soft/hard split of the nodes7
// version is replaced here by the fork's built-in fixed-interval reconnect. Heartbeat-
// stall detection still sets `alive`, but does not force a reconnect in v1 (the fork
// owns reconnection). These behavioural differences are what we are evaluating.

const s7 = require('@st-one-io/nodes7');
const DefaultS7Endpoint = s7.S7Endpoint;
const DefaultS7ItemGroup = s7.S7ItemGroup;

const State = Object.freeze({
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
});

function errMsg(err) {
  if (err === true) return 'partial read (some variables unreadable)';
  if (err && typeof err === 'object') return err.message || JSON.stringify(err);
  return String(err);
}

// Kept for interface compatibility with the nodes7 version (unused internally here).
function isHardError(err) { return err !== true && !!err; }
function nextBackoff(currentMs, capMs) { return Math.min(currentMs * 2, capMs); }

class PlcConnection {
  constructor(plc, opts = {}) {
    this.plc = plc; // { name, ip, rack, slot }
    this.items = opts.items || [];
    this.translate = opts.translate || ((t) => t);
    this.S7Endpoint = opts.S7Endpoint || DefaultS7Endpoint;
    this.S7ItemGroup = opts.S7ItemGroup || DefaultS7ItemGroup;
    this.logger = opts.logger || console;
    this.now = opts.now || (() => Date.now());
    this.softFailThreshold = opts.softFailThreshold ?? 3;
    this.backoffBaseMs = opts.backoffBaseMs ?? 2000;
    this.backoffCapMs = opts.backoffCapMs ?? 60000;
    this.reconnectMs = opts.reconnectMs ?? Math.max(this.backoffBaseMs, 5000); // fork fixed interval
    this.heartbeatStallThreshold = opts.heartbeatStallThreshold ?? 3;
    this.heartbeatKey = opts.heartbeatKey || null;
    this.detectHeartbeatStall = opts.detectHeartbeatStall !== false;

    this.endpoint = null;
    this.itemGroup = null;
    this.state = State.DISCONNECTED;
    this.connectGen = 0;
    this.softFailCount = 0;
    this.backoffMs = this.backoffBaseMs; // informational (fork owns reconnect timing)
    this.alive = false;
    this.heartbeat = { current: null, previous: null, identicalCount: 0 };
  }

  get reachable() { return this.state === State.CONNECTED; }

  // Lazily create the S7Endpoint once; the fork then auto-connects + auto-reconnects.
  ensureConnecting() {
    if (this.endpoint) return;
    this._create();
  }

  _create() {
    this.state = State.CONNECTING;
    const ep = new this.S7Endpoint({
      host: this.plc.ip,
      rack: this.plc.rack,
      slot: this.plc.slot,
      autoReconnect: this.reconnectMs, // fork reconnects on its own at this interval
    });
    this.endpoint = ep;

    ep.on('connect', () => {
      this.state = State.CONNECTED;
      this.connectGen += 1;
      this.softFailCount = 0;
      this.alive = false;
      this.heartbeat = { current: null, previous: null, identicalCount: 0 };
      const g = new this.S7ItemGroup(ep);
      g.setTranslationCB((tag) => this.translate(tag));
      g.addItems(this.items);
      this.itemGroup = g;
      this.logger.info(`Connected to ${this.plc.name} (${this.plc.ip})`);
    });

    ep.on('disconnect', () => {
      this.state = State.DISCONNECTED;
      this.alive = false;
      this.itemGroup = null;
      this.logger.warn(`Disconnected ${this.plc.name} (${this.plc.ip})`);
    });

    ep.on('error', (e) => {
      // Connection-level errors are surfaced; the fork's autoReconnect recovers.
      this.logger.error(`S7 error ${this.plc.name}: ${errMsg(e)}`);
    });
  }

  async read() {
    if (this.state !== State.CONNECTED || !this.itemGroup) return { ok: false, values: null };
    try {
      const values = await this.itemGroup.readAllItems();
      this.softFailCount = 0;
      if (this.detectHeartbeatStall && this.heartbeatKey) this._checkHeartbeat(values);
      return { ok: true, values };
    } catch (e) {
      this.softFailCount += 1;
      this.logger.warn(`Read fail ${this.plc.name} (${this.softFailCount}/${this.softFailThreshold}): ${errMsg(e)}`);
      return { ok: false, values: null };
    }
  }

  _checkHeartbeat(values) {
    if (!(this.heartbeatKey in values)) return;
    const hb = values[this.heartbeatKey];
    this.heartbeat.previous = this.heartbeat.current;
    this.heartbeat.current = hb;
    if (this.heartbeat.previous === null) {
      this.alive = true;
      this.heartbeat.identicalCount = 0;
    } else if (this.heartbeat.previous === hb) {
      this.heartbeat.identicalCount += 1;
      if (this.heartbeat.identicalCount >= this.heartbeatStallThreshold) {
        // v1: log only; the fork owns reconnection. (Evaluate whether a forced
        // reconnect on stall is needed once we see real behaviour.)
        this.alive = false;
        this.logger.warn(`Heartbeat stalled for ${this.plc.name} (fork owns reconnect in v1)`);
      }
    } else {
      this.alive = true;
      this.heartbeat.identicalCount = 0;
    }
  }

  async write(keys, values) {
    if (this.state !== State.CONNECTED || !this.itemGroup) throw new Error(`not connected: ${this.plc.name}`);
    // S7-1200 caps a multi-variable WRITE request at 12 items; @st-one-io/nodes7
    // splits packets by byte size and can pack 13+ items/packet -> PLC rejects with
    // 0x8500 "Wrong frames" + ECONNRESET. Chunk to <=10 items/call (margin) and write
    // sequentially. Delta-sync keeps steady-state writes tiny, so this only matters
    // for the (one-time) baseline after each (re)connect.
    const CHUNK = 10;
    for (let i = 0; i < keys.length; i += CHUNK) {
      await this.itemGroup.writeItems(keys.slice(i, i + CHUNK), values.slice(i, i + CHUNK));
    }
  }
}

class PlcConnectionManager {
  constructor(connections) {
    this.connections = connections;
  }

  async tick() {
    for (const c of this.connections) c.ensureConnecting();
    const settled = await Promise.allSettled(
      this.connections.map((c) => c.read().then((r) => ({ name: c.plc.name, r })))
    );
    const data = {};
    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value.r.ok) data[s.value.name] = s.value.r.values;
    }
    return data;
  }

  byName(name) {
    return this.connections.find((c) => c.plc.name === name);
  }
}

module.exports = { State, errMsg, isHardError, nextBackoff, PlcConnection, PlcConnectionManager };
