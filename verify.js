'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parseDb } = require('./tia-scl');
const { assignOffsets } = require('./layout');

// Map each config PLC name to its TIA export station directory name.
// Only needed for the optional verify-against-export safety check; adjust
// these to match your own TIA project export layout.
const PLC_STATION = {
  PLC_1: 'S7-1200 station_1_PLC_1',
  PLC_2: 'S7-1200 station_2_PLC_2',
};

// config variables{} -> ordered [{name, type}]
function orderedFields(plc) {
  return Object.entries(plc.variables).map(([name, d]) => ({ name, type: d.type }));
}

function structNameFor(plcName) {
  return 'plc_' + plcName.replace(/^PLC_/, '').toLowerCase();
}

function dbXml(exportDir, station, db) {
  return fs.readFileSync(path.join(exportDir, station, 'Blocks', '_source', `${db}.db`), 'utf8');
}

// Verify that our engine reproduces the live system's LAYOUT (the safety property).
//
// config.json is the CANONICAL source of names (Norbert's decision: tool is master).
// Therefore name differences between config and the existing export are NOT failures —
// they are pre-existing drift that generation will CORRECT (the generated DBs carry config
// names). We collect them in `nameDrift` for visibility. What MUST match is the byte layout:
// member ORDER, member TYPES (at each position), and the engine-computed OFFSETS == config
// offsets. A type/order/offset mismatch is a real problem (would corrupt the sync) -> `problems`.
function verifyAgainstExport(config, exportDir) {
  const problems = [];
  const nameDrift = [];

  // Compare a canonical config field list against an export member list, positionally.
  function compareLayout(label, cfg, exp) {
    if (cfg.length !== exp.length) {
      problems.push(`${label}: member count differs (config ${cfg.length} vs export ${exp.length})`);
      return;
    }
    for (let i = 0; i < cfg.length; i++) {
      if (cfg[i].type !== exp[i].type) {
        problems.push(`${label}[${i}] type differs: config ${cfg[i].name}:${cfg[i].type} vs export ${exp[i].name}:${exp[i].type}`);
      }
      if (cfg[i].name !== exp[i].name) {
        nameDrift.push({ where: label, pos: i, config: cfg[i].name, export: exp[i].name });
      }
    }
  }

  // 1) per-PLC share_this_data: layout matches config; engine offsets == config offsets.
  for (const plc of config.plcs) {
    const station = PLC_STATION[plc.name];
    if (!station) { problems.push(`no station mapping: ${plc.name}`); continue; }
    let sdb;
    try { sdb = parseDb(dbXml(exportDir, station, 'share_this_data')); }
    catch (e) { problems.push(`cannot read share_this_data for ${plc.name}: ${e.message}`); continue; }

    const cfg = orderedFields(plc);
    compareLayout(`${plc.name}.share_this_data`, cfg, sdb.members.map(m => ({ name: m.name, type: m.type })));

    const assigned = assignOffsets(cfg);
    for (const a of assigned) {
      const stored = plc.variables[a.name];
      if (a.type === 'BOOL') {
        if (stored.byte !== a.byte || stored.bit !== a.bit)
          problems.push(`${plc.name}.${a.name} BOOL offset mismatch: config byte${stored.byte}.${stored.bit} vs engine byte${a.byte}.${a.bit}`);
      } else {
        if (stored.offset !== a.offset)
          problems.push(`${plc.name}.${a.name} ${a.type} offset mismatch: config ${stored.offset} vs engine ${a.offset}`);
      }
    }
  }

  // 2) synced_data DB200 (from first PLC's copy): struct order == config order; each struct's
  //    members match config by order+type (names may drift).
  const firstStation = PLC_STATION[config.plcs[0].name];
  let ddb;
  try { ddb = parseDb(dbXml(exportDir, firstStation, 'synced_data')); }
  catch (e) { problems.push(`cannot read synced_data: ${e.message}`); return { ok: problems.length === 0, problems, nameDrift }; }

  const structs = ddb.members.filter(m => m.type === 'STRUCT');
  const structOrder = structs.map(s => s.name);
  const expectStructOrder = config.plcs.map(p => structNameFor(p.name));
  if (JSON.stringify(structOrder) !== JSON.stringify(expectStructOrder)) {
    problems.push(`DB200 struct order differs:\n  expect: ${JSON.stringify(expectStructOrder)}\n  export: ${JSON.stringify(structOrder)}`);
  }

  for (const plc of config.plcs) {
    const structName = structNameFor(plc.name);
    const struct = structs.find(s => s.name === structName);
    if (!struct) { problems.push(`DB200 missing struct ${structName}`); continue; }
    compareLayout(`DB200.${structName}`, orderedFields(plc), struct.members.map(m => ({ name: m.name, type: m.type })));
  }

  return { ok: problems.length === 0, problems, nameDrift };
}

module.exports = { verifyAgainstExport, PLC_STATION, orderedFields, structNameFor };
