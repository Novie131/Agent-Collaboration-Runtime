#!/usr/bin/env node
// Turns a real Claude Code transcript into a structure-only fixture:
//  - every text/thinking/tool-result body is replaced by a short hash placeholder
//  - ids (uuid, session, request, message, tool_use) are remapped to sequential ids
//  - file paths are kept only when inside --project-root (made relative), otherwise hashed
//  - shell commands are hashed; "Exit code N" / "command not found" markers are kept
//  - usage numbers, entry types, flags and tool names are kept as-is
// Usage: node scripts/deidentify-claude-transcript.mjs <transcript.jsonl> <out.jsonl> --project-root <dir> [--max-lines N]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const [, , input, output, ...rest] = process.argv;
const opt = (name, def) => {
  const i = rest.indexOf(name);
  return i === -1 ? def : rest[i + 1];
};
if (!input || !output) {
  console.error('usage: deidentify-claude-transcript.mjs <in.jsonl> <out.jsonl> --project-root <dir> [--max-lines N]');
  process.exit(2);
}
const root = resolve(opt('--project-root', process.cwd()));
const maxLines = Number(opt('--max-lines', '400'));

const h = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
const maps = new Map();
const remap = (kind, v) => {
  if (v === undefined || v === null) return v;
  const m = maps.get(kind) ?? new Map();
  maps.set(kind, m);
  if (!m.has(v)) m.set(v, `${kind}_${m.size + 1}`);
  return m.get(v);
};
const path = (p) => {
  if (typeof p !== 'string') return p;
  const r = relative(root, p);
  return r && !r.startsWith('..') ? `/PROJECT/${r.split(sep).join('/')}` : `/EXTERNAL/${h(p)}`;
};
const text = (s) => {
  const str = typeof s === 'string' ? s : JSON.stringify(s ?? '');
  const markers = [];
  const exit = /^Exit code (\d+)/m.exec(str);
  if (exit) markers.push(`Exit code ${exit[1]}`);
  if (/command not found/i.test(str)) markers.push('(eval):1: command not found: <redacted>');
  return [...markers, `<text:${h(str)}:${str.length}>`].join('\n');
};
const toolInput = (name, input) => {
  const out = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    if (k === 'file_path' || k === 'notebook_path' || k === 'path') out[k] = path(v);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else out[k] = `<${k}:${h(JSON.stringify(v))}>`;
  }
  return out;
};
const block = (b) => {
  if (!b || typeof b !== 'object') return b;
  switch (b.type) {
    case 'text':
      return { type: 'text', text: text(b.text) };
    case 'thinking':
      return { type: 'thinking', thinking: text(b.thinking) };
    case 'tool_use':
      return { type: 'tool_use', id: remap('toolu', b.id), name: b.name, input: toolInput(b.name, b.input) };
    case 'tool_result':
      return { type: 'tool_result', tool_use_id: remap('toolu', b.tool_use_id), ...(b.is_error ? { is_error: true } : {}), content: text(b.content) };
    default:
      return { type: b.type };
  }
};
const KEEP_USAGE = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];

const lines = readFileSync(input, 'utf8').split('\n').filter(Boolean).slice(0, maxLines);
const out = [];
let t0;
for (const line of lines) {
  const e = JSON.parse(line);
  const ts = e.timestamp ? Date.parse(e.timestamp) : undefined;
  t0 ??= ts;
  const d = {
    type: e.type,
    ...(e.subtype ? { subtype: e.subtype } : {}),
    ...(e.uuid ? { uuid: remap('uuid', e.uuid) } : {}),
    ...(e.parentUuid ? { parentUuid: remap('uuid', e.parentUuid) } : {}),
    ...(e.sessionId ? { sessionId: remap('session', e.sessionId) } : {}),
    ...(ts !== undefined && t0 !== undefined ? { timestamp: new Date(Date.UTC(2026, 0, 1) + (ts - t0)).toISOString() } : {}),
    ...(e.isSidechain !== undefined ? { isSidechain: e.isSidechain } : {}),
    ...(e.agentId ? { agentId: remap('agent', e.agentId) } : {}),
    ...(e.isMeta ? { isMeta: true } : {}),
    ...(e.isCompactSummary ? { isCompactSummary: true } : {}),
    ...(e.requestId ? { requestId: remap('req', e.requestId) } : {}),
    ...(e.serverClassifierRequest !== undefined ? { serverClassifierRequest: '<redacted>' } : {}),
    ...(e.version ? { version: e.version } : {}),
  };
  if (e.message && typeof e.message === 'object') {
    const m = e.message;
    d.message = {
      ...(m.id ? { id: remap('msg', m.id) } : {}),
      ...(m.role ? { role: m.role } : {}),
      content: Array.isArray(m.content) ? m.content.map(block) : text(m.content),
      ...(m.usage ? { usage: Object.fromEntries(KEEP_USAGE.filter((k) => k in m.usage).map((k) => [k, m.usage[k]])) } : {}),
    };
  }
  out.push(JSON.stringify(d));
}
writeFileSync(output, `${out.join('\n')}\n`);
console.log(`wrote ${out.length} de-identified lines to ${output}`);
