// sync-engine.js — pure delta-sync engine. Owns per-target lastWritten state,
// builds the full sync write-set (sws3-equivalent), computes the delta vs the
// last write, and self-checks a delta-equivalence invariant. No I/O.

function deepEqualValues(a, b) {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) { if (!(k in b) || a[k] !== b[k]) return false; }
  return true;
}

class SyncEngine {
  constructor(opts = {}) {
    this.plcVars = opts.plcVars;        // { targetName: { syncVar: addr } }
    this.logger = opts.logger || console;
    this.strict = opts.strict === true; // throw on invariant violation (tests)
    this.lastWritten = {};              // targetName -> { gen, values }
  }

  // Full sync set for a target = every source PLC's sync vars (mapped onto this
  // target) + the server heartbeat. Mirrors sws3's syncDataToPLC build step.
  buildFullSet(targetName, combinedData, serverHeartbeat) {
    const out = {};
    const vars = this.plcVars[targetName] || {};
    for (const sourceName in combinedData) {
      for (const [key, value] of Object.entries(combinedData[sourceName])) {
        const syncVar = `${sourceName}__sync__${key}`;
        if (vars[syncVar]) out[syncVar] = (value !== undefined) ? value : 0;
      }
    }
    const hbVar = `${targetName}__sync__server_heartbeat`;
    if (vars[hbVar] !== undefined) out[hbVar] = serverHeartbeat;
    return out;
  }

  // Delta vs lastWritten. Re-baselines (full write) when there is no prior write
  // for this target or the connection generation changed (reconnect). Runs the
  // invariant: base + delta must reproduce fullSet exactly.
  computeDelta(targetName, gen, fullSet) {
    const prev = this.lastWritten[targetName];
    const isBaseline = !prev || prev.gen !== gen;
    const base = isBaseline ? {} : prev.values;
    const keys = [], values = [];
    for (const [k, v] of Object.entries(fullSet)) {
      if (isBaseline || !(k in base) || base[k] !== v) { keys.push(k); values.push(v); }
    }
    const reconstructed = { ...base };
    for (let i = 0; i < keys.length; i++) reconstructed[keys[i]] = values[i];
    if (!deepEqualValues(reconstructed, fullSet)) {
      const msg = `[DELTA-INVARIANT] mismatch for ${targetName}: base+delta != full`;
      this.logger.error(msg);
      if (this.strict) throw new Error(msg);
    }
    return { keys, values, isBaseline };
  }

  // Record a successful (or dry-run) write: lastWritten becomes fullSet@gen.
  commit(targetName, gen, fullSet) {
    this.lastWritten[targetName] = { gen, values: { ...fullSet } };
  }

  // After a write failure: drop lastWritten so the next cycle re-baselines.
  invalidate(targetName) {
    delete this.lastWritten[targetName];
  }
}

module.exports = { SyncEngine, deepEqualValues };
