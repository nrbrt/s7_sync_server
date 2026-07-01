'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { assignOffsets, computeSyncDbOffsets } = require('./layout');
const { orderedFields } = require('./verify');
const { renderShareThisData, renderSyncedData } = require('./render-db');

const VALID_TYPES = new Set(['BOOL', 'INT', 'REAL']);
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

function descriptorFor(field) {
  return field.type === 'BOOL'
    ? { type: 'BOOL', byte: field.byte, bit: field.bit }
    : { type: field.type, offset: field.offset };
}

// Pure: validate + recompute offsets + render. Mutates the passed-in `config` (caller deep-copies
// if it needs the original). Returns artifact strings + preview. No I/O, no verify (config is the
// canonical source of names; the offset engine is proven against the live export).
// op is one of:
//   { op:'add', plc, name, type }            single add
//   { op:'add', plc, fields:[{name,type},…] } batch add (same PLC, multiple fields)
//   { op:'remove', plc, name }               single remove
// Validation is ATOMIC: all fields are checked before any mutation (no partial result).
function generate(config, { op, plc, name, type, fields }) {
  const target = config.plcs.find(p => p.name === plc);
  if (!target) throw new Error(`unknown PLC: ${plc}`);

  const oldOrdered = orderedFields(target);
  let newOrdered;

  if (op === 'add') {
    // Normalize single or batch into a list of {name,type}.
    const list = Array.isArray(fields) ? fields : [{ name, type }];
    if (list.length === 0) throw new Error('no fields provided');
    const seen = new Set();
    for (const f of list) {
      if (typeof f.name !== 'string' || !NAME_RE.test(f.name)) throw new Error(`invalid or missing field name: ${f.name}`);
      if (!VALID_TYPES.has(f.type)) throw new Error(`unsupported type: ${f.type} (allowed: BOOL, INT, REAL)`);
      if (Object.prototype.hasOwnProperty.call(target.variables, f.name)) throw new Error(`field already exists on ${plc}: ${f.name}`);
      if (seen.has(f.name)) throw new Error(`duplicate field in batch: ${f.name}`);
      seen.add(f.name);
    }
    newOrdered = [...oldOrdered, ...list.map(f => ({ name: f.name, type: f.type }))];
  } else if (op === 'remove') {
    if (Array.isArray(fields)) throw new Error('remove is single-field only (no batch)');
    if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error(`invalid or missing field name: ${name}`);
    if (!Object.prototype.hasOwnProperty.call(target.variables, name)) throw new Error(`field not found on ${plc}: ${name}`);
    newOrdered = oldOrdered.filter(f => f.name !== name);
  } else {
    throw new Error(`unknown op: ${op}`);
  }

  const assigned = assignOffsets(newOrdered);
  target.variables = {};
  for (const f of assigned) target.variables[f.name] = descriptorFor(f);
  computeSyncDbOffsets(config.plcs);

  const reimportPlcs = config.plcs.map(p => p.name);
  const addedFields = op === 'add' ? (Array.isArray(fields) ? fields.map(f => ({ name: f.name, type: f.type })) : [{ name, type }]) : undefined;

  // Hot-safe ONLY when appending to the LAST PLC in config order: then nothing shifts in DB200.
  // Any add to a non-last PLC shifts every downstream PLC's base offset in DB200 (computeSyncDbOffsets
  // bases each PLC at the cumulative size of all preceding PLCs). Any remove repacks the PLC's own
  // block AND shifts downstream PLCs, and can make the running server (old, larger config) write past
  // the end of the now-smaller DB200. Both move live, in-use data -> NOT hot-safe.
  const plcIndex = config.plcs.findIndex(p => p.name === plc);
  const isLastPlc = plcIndex === config.plcs.length - 1;
  const hotSafe = op === 'add' && isLastPlc;

  let rollout;
  if (hotSafe) {
    rollout = `Hot-safe: ${plc} is the last PLC in config order, so nothing shifts in DB200. `
      + `Import the new DBs at convenience; apply config + restart after ${plc} has the new share_this_data.`;
  } else if (op === 'add') {
    rollout = `NOT hot-safe: ${plc} is not the last PLC, so every PLC after it shifts to a higher base offset in DB200. `
      + `Import the new synced_data into ALL PLCs and the new share_this_data into ${plc}, THEN apply config.json + restart `
      + `— as one tight sequence, preferably with the process stopped.`;
  } else { // remove
    rollout = `NOT hot-safe: removing repacks ${plc} and shifts every PLC after it in DB200; the running server may also `
      + `write past the end of the smaller DB200. Import the new synced_data into ALL PLCs and the new share_this_data into ${plc} FIRST, `
      + `THEN apply config.json + restart — as one tight sequence, with the process stopped. `
      + `Also confirm no PLC program still references the removed field.`;
  }

  const preview = {
    op, plc,
    name: op === 'remove' ? name : (Array.isArray(fields) ? undefined : name),
    fields: addedFields,
    hotSafe,
    reimport: { share_this_data: [plc], synced_data: reimportPlcs },
    rollout,
  };

  return { newConfig: config, shareDb: renderShareThisData(target), syncedDb: renderSyncedData(config), preview };
}

function applyOp({ op, plc, name, type, configPath, outDir }) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const { newConfig, shareDb, syncedDb, preview } = generate(config, { op, plc, name, type });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `share_this_data.${plc}.db`), shareDb);
  fs.writeFileSync(path.join(outDir, 'synced_data.db'), syncedDb);
  fs.writeFileSync(path.join(outDir, 'config.json'), JSON.stringify(newConfig, null, 2) + '\n');
  return { preview, files: ['config.json', `share_this_data.${plc}.db`, 'synced_data.db'] };
}

module.exports = { applyOp, generate };

if (require.main === module) {
  const args = Object.fromEntries(process.argv.slice(2).map(a => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.join('=')];
  }));
  try {
    const res = applyOp({
      op: args.op, plc: args.plc, name: args.name, type: args.type,
      configPath: args.config || 'fixtures/config.json',
      outDir: args.out || './out',
    });
    console.log(JSON.stringify(res.preview, null, 2));
    console.log('\nFiles written to ' + (args.out || './out') + ': ' + res.files.join(', '));
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exit(1);
  }
}
