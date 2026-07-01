'use strict';

const TYPE_SIZE = { BOOL: 1, INT: 2, REAL: 4 };

function alignEven(n) {
  return n % 2 === 0 ? n : n + 1;
}

// Highest byte index used by a field (mirrors sws3.js determineVariableEndByte).
function endByte(field) {
  switch (field.type) {
    case 'BOOL': return field.byte;
    case 'INT': return field.offset + 1;
    case 'REAL': return field.offset + 3;
    default: throw new Error(`Unknown data type: ${field.type}`);
  }
}

function assignOffsets(orderedFields) {
  let byte = 0;
  let bit = 0;            // next free bit within the current BOOL byte
  let inBoolByte = false; // true while bit-packing into `byte`
  const out = [];

  for (const f of orderedFields) {
    if (f.type === 'BOOL') {
      if (!inBoolByte) { bit = 0; inBoolByte = true; }
      out.push({ name: f.name, type: 'BOOL', byte, bit });
      bit += 1;
      if (bit > 7) { byte += 1; bit = 0; inBoolByte = false; } // byte full -> next BOOL opens a new byte
    } else { // INT or REAL
      if (inBoolByte) { byte += 1; inBoolByte = false; bit = 0; } // close partial BOOL byte
      byte = alignEven(byte);
      out.push({ name: f.name, type: f.type, offset: byte });
      byte += TYPE_SIZE[f.type];
      bit = 0;
    }
  }
  return out;
}

function computeSyncDbOffsets(plcs) {
  const result = {};
  let current = 0;
  for (const plc of plcs) {
    let highest = -1;
    for (const desc of Object.values(plc.variables)) {
      const descs = Array.isArray(desc) ? desc : [desc];
      for (const d of descs) {
        const eb = endByte(d);
        if (eb > highest) highest = eb;
      }
    }
    result[plc.name] = current;
    plc.syncDbOffset = current;   // in-place: drop-in for sws3.js calculateSyncDbOffsets
    current += highest + 1;
    current = alignEven(current);
  }
  return result;
}

module.exports = { TYPE_SIZE, alignEven, endByte, assignOffsets, computeSyncDbOffsets };
