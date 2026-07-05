// Shared utilities for the 教师资源发展平台 (China Teacher Resources Development
// Platform) dev harness (pure Node ESM, no deps).
// Used by glossary-check.mjs, typewriter.mjs, parity-check.mjs, and gate.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Recursively collect files under a path, filtered by extension list. */
export function walk(target, exts, ignore = ['node_modules', '.git', 'dist', '.planning']) {
  const out = [];
  const abs = path.resolve(target);
  let stat;
  try { stat = fs.statSync(abs); } catch { return out; }
  if (stat.isFile()) {
    if (!exts || exts.includes(path.extname(abs).toLowerCase())) out.push(abs);
    return out;
  }
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (ignore.includes(entry.name)) continue;
    const p = path.join(abs, entry.name);
    if (entry.isDirectory()) out.push(...walk(p, exts, ignore));
    else if (!exts || exts.includes(path.extname(entry.name).toLowerCase())) out.push(p);
  }
  return out;
}

/** Read a UTF-8 file, returning '' on error. */
export function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

/** Split text into lines, stripping fenced and inline code so linters skip code. */
export function proseLines(text) {
  const lines = text.split(/\r?\n/);
  let inFence = false;
  return lines.map((line, i) => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return { n: i + 1, text: '', raw: line, code: true }; }
    if (inFence) return { n: i + 1, text: '', raw: line, code: true };
    return { n: i + 1, text: line.replace(/`[^`]*`/g, ''), raw: line, code: false };
  });
}

/** Minimal arg parser: returns { _: [positionals], flags: {name: value|true} }. */
export function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out.flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out.flags[k] = argv[++i];
      else out.flags[k] = true;
    } else out._.push(a);
  }
  return out;
}

/** Load the canonical glossary; returns { terms, rules } or null. */
export function loadGlossary(file) {
  const p = file || path.join(ROOT, 'docs', 'glossary.json');
  try { return JSON.parse(read(p)); } catch { return null; }
}

export const SEV = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** ANSI colors that degrade gracefully when not a TTY. */
const tty = process.stdout.isTTY;
export const c = {
  red: s => tty ? `\x1b[31m${s}\x1b[0m` : s,
  yellow: s => tty ? `\x1b[33m${s}\x1b[0m` : s,
  green: s => tty ? `\x1b[32m${s}\x1b[0m` : s,
  dim: s => tty ? `\x1b[2m${s}\x1b[0m` : s,
  bold: s => tty ? `\x1b[1m${s}\x1b[0m` : s,
};

export function sevTag(sev) {
  const map = { P0: c.red('[P0]'), P1: c.yellow('[P1]'), P2: '[P2]', P3: c.dim('[P3]') };
  return map[sev] || `[${sev}]`;
}
