import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { redact } from './redact.js';

/**
 * Outgoing privacy guard (SPEC §28.6, ADR-0011). Every response that leaves the machine on the
 * remote endpoint passes through here:
 *   1. values from the workspace's .env files are masked wherever they appear;
 *   2. content that looks like a whole .env file is blocked outright;
 *   3. personal data (email, phone, national ID, card numbers) is masked;
 *   4. the generic secret patterns (API keys, tokens, private keys, …) are masked.
 * All detection is deterministic and local. It is a safety net, not a guarantee.
 */

export type PiiKind = 'email' | 'phone' | 'tw_id' | 'credit_card';
export const ALL_PII: PiiKind[] = ['email', 'phone', 'tw_id', 'credit_card'];

export type PrivacyOptions = {
  envFiles: boolean;
  pii: PiiKind[];
  /** Email domains that are never personal data (documentation examples, bots). */
  allowEmailDomains: string[];
  /** Block the whole response when it carries at least this many distinct .env entries. */
  blockEnvThreshold: number;
};

export const DEFAULT_PRIVACY: PrivacyOptions = {
  envFiles: true,
  pii: ALL_PII,
  allowEmailDomains: ['example.com', 'example.org', 'example.net', 'test', 'localhost', 'invalid', 'users.noreply.github.com'],
  blockEnvThreshold: 3,
};

export type PrivacyReport = {
  masked: Record<string, number>;
  blocked: { reason: string } | null;
};

type EnvEntry = { file: string; key: string; value: string };

// ------------------------------------------------------------------ .env discovery

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'vendor', '.venv', 'venv', '__pycache__', '.next', 'target']);
const ENV_FILE = /^\.env(\..+)?$/;
/** Values this short or this common are not secrets and would cause noise if masked. */
const NOT_SECRET = new Set(['true', 'false', 'yes', 'no', 'on', 'off', 'null', 'none', 'development', 'production', 'staging', 'test', 'localhost', 'debug', 'info', 'warn', 'error']);

export function parseEnv(text: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    const q = value[0];
    if ((q === '"' || q === "'" || q === '`') && value.endsWith(q) && value.length >= 2) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    out.push({ key: m[1]!, value });
  }
  return out;
}

const isSecretLike = (value: string) => value.length >= 6 && !NOT_SECRET.has(value.toLowerCase()) && !/^\d{1,6}$/.test(value);

/** Finds `.env` / `.env.*` files under the workspace (bounded walk, skipping dependency and build dirs). */
export function findEnvFiles(root: string, maxDepth = 6, maxEntries = 50_000): string[] {
  const found: string[] = [];
  let seen = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth || seen > maxEntries) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++seen > maxEntries) return;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), depth + 1);
      } else if (e.isFile() && ENV_FILE.test(e.name) && !/\.(example|sample|template|dist)$/i.test(e.name)) {
        found.push(join(dir, e.name));
      }
    }
  };
  walk(root, 0);
  return found;
}

// ------------------------------------------------------------------ PII detectors

/** Taiwan national ID / resident certificate checksum (letter + 9 digits). */
export function validTwId(id: string): boolean {
  if (!/^[A-Z][1289]\d{8}$/.test(id)) return false;
  const letters = 'ABCDEFGHJKLMNPQRSTUVXYWZIO';
  const n = letters.indexOf(id[0]!) + 10;
  const digits = [Math.floor(n / 10), n % 10, ...id.slice(1).split('').map(Number)];
  const weights = [1, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1];
  const sum = digits.reduce((acc, d, i) => acc + d * weights[i]!, 0);
  return sum % 10 === 0;
}

export function luhn(num: string): boolean {
  const digits = num.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const PII: Record<PiiKind, { re: RegExp; accept?: (m: string, opts: PrivacyOptions) => boolean }> = {
  email: {
    // TLD must be letters, so `pkg@1.2.3` and `@scope/pkg@4.5.6` are not emails.
    re: /\b[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})\b/g,
    accept: (m, o) => {
      const domain = m.split('@')[1]!.toLowerCase();
      return !o.allowEmailDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
    },
  },
  // Taiwan mobile (09xx…), +886, and other E.164 numbers written with a leading +.
  phone: { re: /(?<![\w+])(?:09\d{2}[-\s]?\d{3}[-\s]?\d{3}|\+886[-\s]?9\d{2}[-\s]?\d{3}[-\s]?\d{3}|\+\d{1,3}[-\s]\d{2,4}[-\s]\d{3,4}[-\s]?\d{3,4})(?!\w)/g },
  tw_id: { re: /\b[A-Z][1289]\d{8}\b/g, accept: (m) => validTwId(m) },
  credit_card: { re: /\b(?:[3-6]\d{3})(?:[ -]?\d{4}){2}[ -]?\d{1,7}\b/g, accept: (m) => luhn(m) },
};

// ------------------------------------------------------------------ guard

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class PrivacyGuard {
  private entries: EnvEntry[] = [];
  private envRe: RegExp | null = null;
  private loadedAt = 0;
  private stamp = '';

  constructor(
    private readonly root: string,
    readonly options: PrivacyOptions = DEFAULT_PRIVACY,
    private readonly refreshMs = 10_000,
  ) {}

  /** Re-reads the .env files when they may have changed (cheap mtime check, at most every refreshMs). */
  private refresh() {
    if (!this.options.envFiles) return;
    const now = Date.now();
    if (now - this.loadedAt < this.refreshMs && this.loadedAt !== 0) return;
    this.loadedAt = now;
    const files = findEnvFiles(this.root);
    const stamp = files.map((f) => `${f}:${statSync(f).mtimeMs}`).join('|');
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    const entries: EnvEntry[] = [];
    for (const f of files) {
      let text: string;
      try {
        text = readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      const rel = relative(this.root, f).split(sep).join('/');
      for (const { key, value } of parseEnv(text)) if (isSecretLike(value)) entries.push({ file: rel, key, value });
    }
    // Longest first so a value containing another is masked whole.
    entries.sort((a, b) => b.value.length - a.value.length);
    this.entries = entries;
    this.envRe = entries.length ? new RegExp(entries.map((e) => escapeRe(e.value)).join('|'), 'g') : null;
  }

  /** Keys (not values) the guard currently protects, for diagnostics. */
  protectedKeys(): { file: string; key: string }[] {
    this.refresh();
    return this.entries.map(({ file, key }) => ({ file, key }));
  }

  private filterString(s: string, report: PrivacyReport, valueHits: Set<string>, keyHits: Set<string>): string {
    let text = s;
    if (this.envRe) {
      const byValue = new Map(this.entries.map((e) => [e.value, e]));
      text = text.replace(this.envRe, (m) => {
        const e = byValue.get(m)!;
        valueHits.add(`${e.file}:${e.key}`);
        report.masked.env_value = (report.masked.env_value ?? 0) + 1;
        return `[REDACTED:env:${e.key}]`;
      });
      // Assignment lines for protected keys reveal the file's structure even with changed values.
      for (const e of this.entries) {
        if (new RegExp(`(^|\\n)[+\\s]*(export\\s+)?${escapeRe(e.key)}\\s*=`).test(text)) keyHits.add(`${e.file}:${e.key}`);
      }
    }
    for (const kind of this.options.pii) {
      const d = PII[kind];
      text = text.replace(d.re, (m) => {
        if (d.accept && !d.accept(m, this.options)) return m;
        report.masked[kind] = (report.masked[kind] ?? 0) + 1;
        return `[REDACTED:${kind}]`;
      });
    }
    const r = redact(text);
    for (const [k, n] of Object.entries(r.redactions)) report.masked[k] = (report.masked[k] ?? 0) + n;
    return r.text;
  }

  /** Filters every string in a JSON-like value. Keys are left alone. */
  filter<T>(value: T): { value: T; report: PrivacyReport } {
    this.refresh();
    const report: PrivacyReport = { masked: {}, blocked: null };
    const valueHits = new Set<string>();
    const keyHits = new Set<string>();
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') return this.filterString(v, report, valueHits, keyHits);
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      return v;
    };
    const out = walk(value) as T;
    // Real values are what matter; key names alone (e.g. a .env.example in a diff) only count once
    // at least one real value is present too.
    const hits = valueHits.size ? new Set([...valueHits, ...keyHits]) : valueHits;
    if (hits.size >= this.options.blockEnvThreshold) {
      report.blocked = { reason: `the response contained ${hits.size} entries from .env files; it looks like a whole .env file and was withheld` };
    }
    return { value: out, report };
  }
}

// ------------------------------------------------------------------ prompt-injection heuristics

const INJECTION: { name: string; re: RegExp }[] = [
  { name: 'override_instructions', re: /\b(ignore|disregard|forget)\b.{0,30}\b(previous|prior|above|earlier|all)\b.{0,20}\b(instructions?|prompts?|rules?)\b/i },
  { name: 'role_hijack', re: /\b(you are now|act as|new instructions?:|system prompt)\b/i },
  { name: 'tool_command', re: /\b(call|invoke|use|run|execute)\s+(the\s+)?`?(accept_task|cancel_task|create_task|submit_review|record_decision|request_context)`?\b/i },
  { name: 'override_instructions_zh', re: /(忽略|無視|忘記).{0,10}(之前|先前|以上|前面|所有).{0,10}(指示|指令|規則|提示)/ },
  { name: 'tool_command_zh', re: /(請|立即|直接)?(呼叫|調用|執行|使用)\s*`?(accept_task|cancel_task|create_task|submit_review|record_decision|request_context)`?/ },
];

/**
 * Flags text that looks like instructions aimed at the AI inside repository content. Advisory only:
 * the hub warns ChatGPT and the developer, it does not block (legitimate code can match).
 */
export function detectInjection(value: unknown): string[] {
  const hits = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      for (const p of INJECTION) if (p.re.test(v)) hits.add(p.name);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(value);
  return [...hits];
}
