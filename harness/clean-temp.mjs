#!/usr/bin/env node
// clean-temp.mjs — Inspect and remove local scratch/temp clutter. SAFE by default.
//
//   node harness/clean-temp.mjs            # LIST what would be removed (dry run) — default
//   node harness/clean-temp.mjs --apply    # actually delete the temp targets
//   node harness/clean-temp.mjs --json     # machine-readable target list
//
// Targets come from harness.config.json -> tempCleanup.paths (repo-relative dirs) plus
// loose *.tmp files. NEVER deletes a git-tracked path (refuses, with a warning), so it
// can only remove genuinely-ignored scratch. Always list first and confirm with the
// user before calling this with --apply.
//
// Exit: 0 normal · 2 IO error. Pure Node.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, read, walk, parseArgs, c } from './lib/util.mjs';

const args = parseArgs(process.argv.slice(2));
const apply = !!args.flags.apply;
const json = !!args.flags.json;
// --root overrides the base directory (used by tests against temp fixtures).
const BASE = args.flags.root ? path.resolve(args.flags.root) : ROOT;

let cfg = {};
for (const cand of [path.join(BASE, 'harness.config.json'), path.join(BASE, 'harness', 'harness.config.json'), path.join(ROOT, 'harness', 'harness.config.json')]) {
  try { cfg = JSON.parse(read(cand)); break; } catch { /* try next */ }
}
const configured = (cfg.tempCleanup && cfg.tempCleanup.paths) || ['tmp/', '.scratch/'];

// Collect candidate targets: configured dirs/files that exist + loose *.tmp files.
// Glob-style entries (e.g. "*.tmp") are handled by the walk below, not existsSync.
const targets = [];
for (const rel of configured) {
  if (rel.includes('*')) continue;
  const abs = path.join(BASE, rel);
  if (fs.existsSync(abs)) targets.push(abs);
}
for (const f of walk(BASE, ['.tmp'])) targets.push(f);

// De-dupe and measure.
const seen = new Set();
const items = [];
for (const abs of targets) {
  if (seen.has(abs)) continue;
  seen.add(abs);
  items.push({ path: path.relative(BASE, abs).replace(/\\/g, '/'), abs, ...measure(abs), tracked: isTracked(abs) });
}

function measure(abs) {
  let bytes = 0, files = 0;
  const st = fs.statSync(abs);
  if (st.isFile()) return { type: 'file', bytes: st.size, files: 1 };
  for (const f of walk(abs, null, [])) { try { bytes += fs.statSync(f).size; files++; } catch {} }
  return { type: 'dir', bytes, files };
}
function isTracked(abs) {
  const r = spawnSync('git', ['ls-files', '--error-unmatch', abs], { cwd: BASE, encoding: 'utf8' });
  return r.status === 0;
}
const human = b => b < 1024 ? `${b}B` : b < 1048576 ? `${(b / 1024).toFixed(1)}KB` : `${(b / 1048576).toFixed(1)}MB`;

const deletable = items.filter(i => !i.tracked);
const refused = items.filter(i => i.tracked);

if (json) {
  let removed = [];
  if (apply) removed = doApply(deletable);
  process.stdout.write(JSON.stringify({ tool: 'clean-temp', applied: apply, targets: items, refusedTracked: refused.map(i => i.path), removed }, null, 2) + '\n');
  process.exit(0);
}

console.log(c.bold('=== Temp Cleanup ==='));
if (!items.length) { console.log(c.green('✓ No temp clutter found.')); process.exit(0); }
const total = deletable.reduce((a, i) => a + i.bytes, 0);
console.log(`${deletable.length} target(s), ${human(total)}:`);
for (const i of deletable) console.log(`  ${i.type === 'dir' ? 'dir ' : '·'} ${i.path}  ${c.dim(`(${i.files} file(s), ${human(i.bytes)})`)}`);
for (const i of refused) console.log(c.yellow(`  ! ${i.path} is git-tracked — refusing to delete`));
if (!apply) {
  console.log('');
  console.log(c.dim('Dry run. Re-run with --apply to delete (confirm with the user first).'));
  process.exit(0);
}
const removed = doApply(deletable);
console.log('');
console.log(c.green(`✓ Removed ${removed.length} target(s).`));

function doApply(list) {
  const removed = [];
  for (const i of list) {
    try { fs.rmSync(i.abs, { recursive: true, force: true }); removed.push(i.path); }
    catch (e) { process.stderr.write(`failed to remove ${i.path}: ${e.message}\n`); }
  }
  return removed;
}
process.exit(0);
