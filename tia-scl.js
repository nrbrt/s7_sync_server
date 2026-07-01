'use strict';
// Parse + mutate TIA "external source" DB files (.db SCL declaration format).
// This is what Norbert imports into TIA Portal (External source files) — NOT Openness XML.
//
// Format (note: files are UTF-8 BOM-prefixed with CRLF line endings):
//   DATA_BLOCK "share_this_data"
//   { S7_Optimized_Access := 'FALSE' }
//   VERSION : 0.1
//   NON_RETAIN
//      STRUCT
//         heartbeat : Int;
//         buffer_filling_active : Bool;   // optional comment
//      END_STRUCT;
//   BEGIN
//      heartbeat := 0;
//   END_DATA_BLOCK
//
// synced_data has nested struct-per-PLC members:
//      plc_1 : Struct   // comment
//         machine_running : Bool;
//      END_STRUCT;
//
// Mutations are LINE-BASED (preserve comments, init values, formatting, BOM, CRLF). Member
// names are reconciled to config canonical names positionally (callers verify order+type first).

const TYPE_FROM_TIA = { Bool: 'BOOL', Int: 'INT', Real: 'REAL', Struct: 'STRUCT' };
const TYPE_TO_TIA = { BOOL: 'Bool', INT: 'Int', REAL: 'Real' };
const BOM = '﻿';

const OUTER_STRUCT_RE = /^\s*STRUCT\s*$/;
const STRUCT_OPEN_RE = /^(\s*)([A-Za-z_]\w*)\s*:\s*Struct\b/;   // name : Struct  (no semicolon)
const MEMBER_RE = /^(\s*)([A-Za-z_]\w*)\s*:\s*([A-Za-z]\w*)\s*;/; // name : Type;  (leaf member)
const END_STRUCT_RE = /^\s*END_STRUCT\s*;/;

function hasBom(text) { return text.charCodeAt(0) === 0xFEFF; }
function stripBom(text) { return hasBom(text) ? text.slice(1) : text; }
function detectEol(text) { return text.includes('\r\n') ? '\r\n' : '\n'; }
function splitLines(text) { return stripBom(text).split(/\r?\n/); }
function joinLines(lines, eol, bom) { return (bom ? BOM : '') + lines.join(eol); }

function blockName(lines) {
  for (const l of lines) {
    const m = l.match(/^\s*DATA_BLOCK\s+"([^"]+)"/);
    if (m) return m[1];
  }
  return null;
}

// Parse into { name, number, members }. number is null (the DB number lives in TIA, not in
// the source file). members: [{name,type}] or {name,type:'STRUCT',members:[...]} for structs.
function parseDb(text) {
  const lines = splitLines(text);
  const name = blockName(lines);
  const top = [];
  const stack = [top];
  let i = lines.findIndex(l => OUTER_STRUCT_RE.test(l));
  if (i >= 0) {
    for (i = i + 1; i < lines.length && stack.length; i++) {
      const l = lines[i];
      if (END_STRUCT_RE.test(l)) { stack.pop(); continue; }
      const so = l.match(STRUCT_OPEN_RE);
      if (so) {
        const s = { name: so[2], type: 'STRUCT', members: [] };
        stack[stack.length - 1].push(s);
        stack.push(s.members);
        continue;
      }
      const mm = l.match(MEMBER_RE);
      if (mm) stack[stack.length - 1].push({ name: mm[2], type: TYPE_FROM_TIA[mm[3]] || mm[3] });
    }
  }
  return { name, number: null, members: top };
}

// Find the line-index region for a scope's body. structName === null -> the outer DB STRUCT;
// otherwise the named nested Struct. Returns { open, close } (close = index of its END_STRUCT;).
function scopeRegion(lines, structName) {
  let open;
  if (structName === null) {
    open = lines.findIndex(l => OUTER_STRUCT_RE.test(l));
    if (open < 0) throw new Error('outer STRUCT not found');
  } else {
    open = lines.findIndex(l => { const m = l.match(STRUCT_OPEN_RE); return m && m[2] === structName; });
    if (open < 0) throw new Error(`struct not found: ${structName}`);
  }
  let depth = 1;
  for (let i = open + 1; i < lines.length; i++) {
    if (STRUCT_OPEN_RE.test(lines[i])) depth++;
    else if (END_STRUCT_RE.test(lines[i])) { depth--; if (depth === 0) return { open, close: i }; }
  }
  throw new Error('matching END_STRUCT not found');
}

// Indices of DIRECT leaf-member lines within a scope (depth 0 relative to the scope body),
// in order. Excludes lines inside deeper nested structs.
function directMemberIndices(lines, region) {
  const out = [];
  let depth = 0;
  for (let i = region.open + 1; i < region.close; i++) {
    if (STRUCT_OPEN_RE.test(lines[i])) { depth++; continue; }
    if (END_STRUCT_RE.test(lines[i])) { depth--; continue; }
    if (depth === 0 && MEMBER_RE.test(lines[i])) out.push(i);
  }
  return out;
}

function addMember(text, { structName }, field) {
  const tiaType = TYPE_TO_TIA[field.type];
  if (!tiaType) throw new Error(`Unsupported type: ${field.type}`);
  const eol = detectEol(text);
  const bom = hasBom(text);
  const lines = splitLines(text);
  const region = scopeRegion(lines, structName);
  const indent = structName === null ? '      ' : '         '; // 6 spaces flat, 9 nested
  lines.splice(region.close, 0, `${indent}${field.name} : ${tiaType};`);
  return joinLines(lines, eol, bom);
}

function removeMember(text, { structName }, name) {
  const eol = detectEol(text);
  const bom = hasBom(text);
  const lines = splitLines(text);
  const region = scopeRegion(lines, structName);
  const idxs = directMemberIndices(lines, region);
  const target = idxs.find(i => lines[i].match(MEMBER_RE)[2] === name);
  if (target === undefined) throw new Error(`member not found: ${name}`);
  lines.splice(target, 1);
  return joinLines(lines, eol, bom);
}

// Rename direct leaf members positionally to names[i], preserving indent/type/semicolon/comment.
function reconcileMemberNames(text, { structName }, names) {
  const eol = detectEol(text);
  const bom = hasBom(text);
  const lines = splitLines(text);
  const region = scopeRegion(lines, structName);
  const idxs = directMemberIndices(lines, region);
  if (idxs.length !== names.length) {
    throw new Error(`reconcile length mismatch: ${idxs.length} members vs ${names.length} names`);
  }
  idxs.forEach((li, k) => {
    lines[li] = lines[li].replace(/^(\s*)([A-Za-z_]\w*)(\s*:.*)$/, `$1${names[k]}$3`);
  });
  return joinLines(lines, eol, bom);
}

module.exports = {
  parseDb, addMember, removeMember, reconcileMemberNames,
  TYPE_FROM_TIA, TYPE_TO_TIA, scopeRegion, directMemberIndices, detectEol, hasBom,
};
