import { homedir } from 'node:os';
import { isAbsolute, relative, sep } from 'node:path';

/**
 * Best-effort masking of common secret shapes. This is NOT complete protection;
 * reports and docs must not claim otherwise.
 */
const PATTERNS: { name: string; re: RegExp; replace?: (m: string, ...g: string[]) => string }[] = [
  { name: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'aws_access_key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'github_token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { name: 'slack_token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'api_key', re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/g },
  { name: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    name: 'bearer',
    re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g,
    replace: (_m, scheme) => `${scheme} [REDACTED:bearer]`,
  },
  {
    name: 'url_credentials',
    re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi,
    replace: (_m, scheme) => `${scheme}[REDACTED:credentials]@`,
  },
  {
    // `DB_PASSWORD=hunter2`, `apiKey: "abc…"`, `secret = 'x…'`. The name must END in a secret word
    // (so `max_tokens`, `token_count` do not match) and the value must be a literal: quoted, or an
    // unquoted run without code punctuation (so `token = localToken(cfg)` / `row.secret` do not match).
    name: 'assignment',
    // Unquoted values must contain a digit or symbol, so type annotations (`token: string`) do not match;
    // letter-only secrets that live in .env files are still masked by the privacy guard's .env matching.
    re: /\b([A-Za-z0-9_]*(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?))\b(\s*[:=]\s*)(?:(["'])([^"'\s]{4,})\3|(?=[^\s"'().,;[\]{}<>$`]*[\d\-+/=!@#%^&*])([^\s"'().,;[\]{}<>$`]{6,})(?![\w(.]))/gi,
    replace: (_m, key, sepr, q) => `${key}${sepr}${q ?? ''}[REDACTED:assignment]${q ?? ''}`,
  },
];

export interface RedactionResult {
  text: string;
  redactions: Record<string, number>;
}

export function redact(input: string): RedactionResult {
  let text = input;
  const redactions: Record<string, number> = {};
  for (const p of PATTERNS) {
    text = text.replace(p.re, (...args: unknown[]) => {
      redactions[p.name] = (redactions[p.name] ?? 0) + 1;
      const groups = args.slice(1, -2) as string[];
      return p.replace ? p.replace(args[0] as string, ...groups) : `[REDACTED:${p.name}]`;
    });
  }
  return { text, redactions };
}

export const redactText = (s: string) => redact(s).text;

/** Relative to `root` when inside it; otherwise home replaced by ~; never resolves symlinks. */
export function displayPath(p: string, root?: string): string {
  if (root && isAbsolute(p)) {
    const rel = relative(root, p);
    if (rel === '') return '.';
    if (!rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/');
  }
  const home = homedir();
  if (home && (p === home || p.startsWith(home + sep))) return `~${p.slice(home.length)}`;
  return p;
}

/** Escapes untrusted text for inline Markdown: no HTML, links, images or table breaks. */
export function mdInline(s: string, maxLen = 200): string {
  const oneLine = s.replace(/[\r\n]+/g, ' ⏎ ');
  const clipped = oneLine.length > maxLen ? `${oneLine.slice(0, maxLen)}…` : oneLine;
  return clipped
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_{}[\]()#+!|~])/g, '\\$1');
}

/** Wraps untrusted text in a fence longer than any backtick run it contains. */
export function mdCodeBlock(s: string, info = 'text'): string {
  const longest = Math.max(2, ...[...s.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${info}\n${s}\n${fence}`;
}

/**
 * Redacts every string inside a JSON-like value (keys are left alone). Used on everything the
 * hub sends out on the remote endpoint, so a secret pasted into a summary or a review never
 * leaves the machine unmasked (SPEC §28.4).
 */
export function redactDeep<T>(value: T): { value: T; redactions: number } {
  let count = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = redact(v);
      for (const n of Object.values(r.redactions)) count += n;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const out = walk(value) as T;
  return { value: out, redactions: count };
}
