'use strict';
const { TYPE_TO_TIA } = require('./tia-scl');
const { orderedFields, structNameFor } = require('./verify');

const BOM = '﻿';
const EOL = '\r\n';

function memberLines(fields, indent) {
  return fields.map(f => {
    const t = TYPE_TO_TIA[f.type];
    if (!t) throw new Error(`Unsupported type: ${f.type}`);
    return `${indent}${f.name} : ${t};`;
  });
}

function wrapDb(name, bodyLines) {
  const lines = [
    `DATA_BLOCK "${name}"`,
    `{ S7_Optimized_Access := 'FALSE' }`,
    `VERSION : 0.1`,
    `NON_RETAIN`,
    `   STRUCT `,
    ...bodyLines,
    `   END_STRUCT;`,
    ``,
    `BEGIN`,
    `END_DATA_BLOCK`,
    ``,
  ];
  return BOM + lines.join(EOL);
}

function renderShareThisData(plc) {
  return wrapDb('share_this_data', memberLines(orderedFields(plc), '      '));
}

function renderSyncedData(config) {
  const body = [];
  for (const plc of config.plcs) {
    body.push(`      ${structNameFor(plc.name)} : Struct`);
    body.push(...memberLines(orderedFields(plc), '         '));
    body.push(`      END_STRUCT;`);
  }
  // Top-level trailing INT that sws3.js writes per target PLC at currentOffset
  // (the cross-PLC sync-server liveness signal). NOT a config field, so orderedFields
  // doesn't include it — must be appended here or the rendered DB200 is 2 bytes too
  // short and sws3.js's heartbeat write lands past the struct (2026-06-08 fix).
  body.push(`      server_heartbeat : Int;   // server heartbeat`);
  return wrapDb('synced_data', body);
}

module.exports = { renderShareThisData, renderSyncedData };
