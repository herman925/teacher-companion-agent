// tests/unit/harness.test.mjs
//
// Exercises the Node harness CLIs as black boxes: spawn the real scripts from the
// repo root, parse their --json output, and assert exit codes. This guards the
// project guarantees that (a) forbidden terminology is caught, (b) the canonical
// masking logic does not false-positive AND still fires when a forbidden variant
// contains a canonical term, (c) CJK house-style punctuation is enforced and
// auto-fixable, and (d) the doc scaffolder emits the bilingual ADR shape.
// Pure node:test + node:assert, no dependencies, Windows-safe.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const FIX = path.join(ROOT, 'tests', 'fixtures');
const TMP = path.join(ROOT, 'tests', '.tmp');

/** Run `node <args...>` from the repo root and return { code, stdout, stderr }. */
function runNode(args) {
  const res = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    // Force a non-TTY pipe so the tools emit clean (non-colored) output.
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  if (res.error) throw res.error;
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

const GLOSSARY = path.join('harness', 'glossary-check.mjs');
const TYPEWRITER = path.join('harness', 'typewriter.mjs');

// ---------------------------------------------------------------- glossary-check

test('glossary-check passes on a CLEAN fixture (only canonical terms)', () => {
  const r = runNode([GLOSSARY, path.join('tests', 'fixtures', 'clean.md'), '--json']);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}\n${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.pass, true);
  assert.equal(out.findings.length, 0);
});

test('glossary-check FAILS on a forbidden variant (聊天机器人) with a P1 finding', () => {
  const r = runNode([GLOSSARY, path.join('tests', 'fixtures', 'glossary-bad.md'), '--json']);
  assert.equal(r.code, 1, `expected exit 1, got ${r.code}\n${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.pass, false);
  const p1 = out.findings.find(f => f.severity === 'P1' && f.term === '聊天机器人');
  assert.ok(p1, 'expected a P1 finding for the forbidden variant 聊天机器人');
  // The fix should steer toward the canonical form.
  assert.match(p1.title + ' ' + p1.fix, /陪跑智能体/);
});

test('glossary-check does NOT false-positive on canonical terms (masking)', () => {
  // 输出闭环 / 核心驱动问题 / 儿童问题池 are canonical and lexically close to
  // forbidden variants (输出闭环四件套 / 驱动性问题 / 问题库). The masking logic
  // must keep canonical-only prose clean.
  const r = runNode([GLOSSARY, path.join('tests', 'fixtures', 'glossary-canonical-mask.md'), '--json']);
  assert.equal(r.code, 0, `expected exit 0 (masking), got ${r.code}\n${JSON.stringify(JSON.parse(r.stdout || '{}'), null, 2)}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.pass, true);
  assert.equal(out.findings.length, 0);
});

test('glossary-check still FIRES when a forbidden variant CONTAINS a canonical term (输出闭环四件套)', () => {
  // 输出闭环 (canonical) is a prefix of 输出闭环四件套 (forbidden). Naive masking
  // of the canonical term would blank the variant before the search; the
  // per-variant mask must leave it intact so the longer forbidden form fires.
  fs.mkdirSync(TMP, { recursive: true });
  const tmp = path.join(TMP, `variant-super-${process.pid}.md`);
  fs.writeFileSync(tmp, '# 收尾 / Closure\n\n每轮都要给出输出闭环四件套。\n', 'utf8');
  try {
    const r = runNode([GLOSSARY, path.relative(ROOT, tmp), '--json']);
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}\n${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.ok(out.findings.some(f => f.severity === 'P1' && f.term === '输出闭环四件套'),
      'expected a P1 finding for 输出闭环四件套');
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

// ------------------------------------------------------------------- typewriter

test('typewriter lint FLAGS half-width CJK punctuation as P2', () => {
  const r = runNode([TYPEWRITER, 'lint', path.join('tests', 'fixtures', 'typewriter-bad.md'), '--json']);
  assert.equal(r.code, 1, `expected exit 1, got ${r.code}\n${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.pass, false);
  const p2 = out.findings.filter(f => f.severity === 'P2');
  assert.ok(p2.length > 0, 'expected at least one P2 for half-width CJK punctuation');
  assert.ok(p2.some(f => /half-width/.test(f.title)), 'expected a half-width punctuation finding');
});

test('typewriter lint --fix rewrites a temp copy so a re-lint is clean', () => {
  fs.mkdirSync(TMP, { recursive: true });
  const tmp = path.join(TMP, `fix-${process.pid}.md`);
  fs.copyFileSync(path.join(FIX, 'typewriter-bad.md'), tmp);
  try {
    const rel = path.relative(ROOT, tmp);
    const fixRun = runNode([TYPEWRITER, 'lint', rel, '--fix', '--json']);
    // --fix run still reports the findings it corrected (exit 1 is expected here).
    assert.ok(fixRun.code === 0 || fixRun.code === 1, `unexpected exit ${fixRun.code}`);
    const reRun = runNode([TYPEWRITER, 'lint', rel, '--json']);
    assert.equal(reRun.code, 0, `re-lint after --fix should be clean, got ${reRun.code}\n${reRun.stdout}`);
    const out = JSON.parse(reRun.stdout);
    assert.equal(out.pass, true);
    assert.equal(out.findings.length, 0);
    // Sanity: the fixed file now contains full-width punctuation.
    const fixed = fs.readFileSync(tmp, 'utf8');
    assert.match(fixed, /（教研员）/);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('typewriter lint passes on a clean fixture', () => {
  const r = runNode([TYPEWRITER, 'lint', path.join('tests', 'fixtures', 'typewriter-clean.md'), '--json']);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}\n${r.stdout}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.pass, true);
  assert.equal(out.findings.length, 0);
});

test('typewriter new adr "X" prints a bilingual ADR scaffold', () => {
  const r = runNode([TYPEWRITER, 'new', 'adr', 'Pick the runtime']);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}\n${r.stderr}`);
  assert.match(r.stdout, /# ADR-NNNN: Pick the runtime/);
  // Bilingual markers from the house-style template.
  assert.match(r.stdout, /Context \/ 背景/);
  assert.match(r.stdout, /Decision \/ 决策/);
  assert.match(r.stdout, /中文：/);
});
