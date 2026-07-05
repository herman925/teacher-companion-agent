#!/usr/bin/env node
// parity-check.mjs — Bilingual parity for EN/简中 document pairs.
//
// Enforces that each pair (e.g. docs/PRD.md ↔ docs/PRD.zh-CN.md) stays in sync:
//   1. Structural parity — the two files must have the same number of headings at
//      each level (a mirror structure). Divergence -> P1 (likely a missing/extra section).
//   2. Staged co-update — when committing, if one half of a pair is staged but the
//      other is not, that is a P0 (you changed the English without the Chinese, or vice
//      versa). Skipped when not inside a commit (no staged files).
//   3. One side missing -> P2 WARN (non-blocking). This repo is young: README.zh-CN.md
//      may not exist yet. Missing BOTH sides is fine (the pair simply isn't born yet).
//
// Usage:  node harness/parity-check.mjs [--json]
// Exit:   0 clean · 1 findings · 2 IO error
// Pure Node. Reads harness/harness.config.json for the pair list.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, read, parseArgs, sevTag, c } from './lib/util.mjs';

const args = parseArgs(process.argv.slice(2));
const json = !!args.flags.json;
// --root overrides the base directory (used by tests against temp fixtures).
const BASE = args.flags.root ? path.resolve(args.flags.root) : ROOT;

let config = {};
for (const cand of [path.join(BASE, 'harness.config.json'), path.join(BASE, 'harness', 'harness.config.json'), path.join(ROOT, 'harness', 'harness.config.json')]) {
  try { config = JSON.parse(read(cand)); break; } catch { /* try next */ }
}
const pairs = config.bilingualPairs || [
  { en: 'docs/PRD.md', zh: 'docs/PRD.zh-CN.md' },
  { en: 'README.md', zh: 'README.zh-CN.md' },
];

// Count headings per level, ignoring fenced code blocks.
function headingProfile(file) {
  const text = read(path.join(BASE, file));
  if (!text) return null;
  const counts = {};
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = line.match(/^(#{1,6})\s/);
    if (m) counts[m[1].length] = (counts[m[1].length] || 0) + 1;
  }
  return counts;
}

// Files staged in the current commit (empty array when not committing / not a git repo).
function stagedFiles() {
  const r = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: BASE, encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(s => s.replace(/\\/g, '/'));
}

const findings = [];
const staged = stagedFiles();
const norm = p => p.replace(/\\/g, '/');

for (const pair of pairs) {
  const enExists = fs.existsSync(path.join(BASE, pair.en));
  const zhExists = fs.existsSync(path.join(BASE, pair.zh));
  if (!enExists || !zhExists) {
    if (enExists || zhExists) {
      // WARN (P2, non-blocking): one twin exists ahead of the other. Blocking this
      // would forbid ever landing the first half of a new bilingual pair.
      findings.push({ severity: 'P2', title: `Bilingual pair incomplete: ${pair.en} / ${pair.zh} — one side is missing`, fix: 'create the missing twin so both languages exist' });
    }
    continue;
  }

  // 1. Structural parity
  const a = headingProfile(pair.en), b = headingProfile(pair.zh);
  const levels = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const lvl of levels) {
    const na = (a && a[lvl]) || 0, nb = (b && b[lvl]) || 0;
    if (na !== nb) {
      findings.push({ severity: 'P1', title: `Heading mismatch at h${lvl}: ${pair.en} has ${na}, ${pair.zh} has ${nb}`, fix: `align the section structure of ${pair.en} and ${pair.zh}` });
    }
  }

  // 2. Staged co-update
  if (staged.length) {
    const enStaged = staged.includes(norm(pair.en));
    const zhStaged = staged.includes(norm(pair.zh));
    if (enStaged !== zhStaged) {
      const changed = enStaged ? pair.en : pair.zh;
      const missing = enStaged ? pair.zh : pair.en;
      findings.push({ severity: 'P0', title: `${changed} is staged but its twin ${missing} is not`, fix: `update ${missing} in the same commit to keep EN/简中 in sync` });
    }
  }
}

if (json) {
  const pass = !findings.some(f => f.severity === 'P0' || f.severity === 'P1');
  process.stdout.write(JSON.stringify({ tool: 'parity-check', pairs: pairs.length, staged: staged.length, findings, pass }, null, 2) + '\n');
  process.exit(pass ? 0 : 1);
}

console.log(c.bold('=== Bilingual Parity ==='));
console.log(c.dim(`${pairs.length} pair(s); ${staged.length} staged file(s)`));
if (!findings.length) { console.log(c.green('✓ EN/简中 pairs are in sync.')); process.exit(0); }
for (const f of findings) {
  console.log(`${sevTag(f.severity)} ${f.title}`);
  console.log(`    fix: ${f.fix}`);
}
const blocking = findings.filter(f => f.severity === 'P0' || f.severity === 'P1').length;
console.log('');
console.log(blocking ? c.red(`✗ ${blocking} parity finding(s).`) : c.yellow(`${findings.length} non-blocking finding(s).`));
process.exit(blocking ? 1 : 0);
