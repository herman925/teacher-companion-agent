// tests/unit/judges.test.mjs
//
// Exercises the two Python judges (design_judge.py, wording_judge.py) as black
// boxes. These are standard-library-only Python 3 scripts; this suite confirms
// their self-tests pass and that --json emits the documented schema with a sane
// overall score. If no python interpreter is on PATH, every case skips with a
// message so CI without python still goes green. Pure node:test + node:assert.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const DESIGN = path.join('harness', 'judges', 'design_judge.py');
const WORDING = path.join('harness', 'judges', 'wording_judge.py');

/** Find a usable python interpreter, or null if none works. */
function findPython() {
  for (const cmd of ['python', 'python3', 'py']) {
    const probe = spawnSync(cmd, ['--version'], { cwd: ROOT, encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return cmd;
  }
  return null;
}

const PY = findPython();
const SKIP = PY ? false : 'python/python3 not found on PATH — skipping Python judge tests';

/** Run `<python> <args...>` from the repo root. */
function runPy(args) {
  const res = spawnSync(PY, args, { cwd: ROOT, encoding: 'utf8' });
  if (res.error) throw res.error;
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

test('design_judge.py --self-test exits 0', { skip: SKIP }, () => {
  const r = runPy([DESIGN, '--self-test']);
  assert.equal(r.code, 0, `self-test should pass, got ${r.code}\n${r.stderr}`);
  assert.match(r.stdout, /OK/);
});

test('wording_judge.py --self-test exits 0', { skip: SKIP }, () => {
  const r = runPy([WORDING, '--self-test']);
  assert.equal(r.code, 0, `self-test should pass, got ${r.code}\n${r.stderr}`);
  assert.match(r.stdout, /OK/);
});

test('design_judge.py --json returns the documented schema', { skip: SKIP }, () => {
  const r = runPy([DESIGN, path.join('tests', 'fixtures', 'sample.html'), '--json']);
  // exit 0 (pass) or 1 (fail) are both valid judge verdicts; 2 means usage/IO error.
  assert.ok(r.code === 0 || r.code === 1, `unexpected exit ${r.code}\n${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.judge, 'design');
  for (const key of ['overall', 'band', 'dimensions', 'findings', 'pass']) {
    assert.ok(key in out, `missing key "${key}" in judge JSON`);
  }
  assert.equal(typeof out.overall, 'number');
  assert.ok(out.overall >= 0 && out.overall <= 10, `overall ${out.overall} out of [0,10]`);
  assert.ok(Array.isArray(out.dimensions) && out.dimensions.length > 0);
  assert.ok(Array.isArray(out.findings));
  assert.equal(typeof out.pass, 'boolean');
});

test('wording_judge.py --json returns the documented schema', { skip: SKIP }, () => {
  const r = runPy([WORDING, path.join('tests', 'fixtures', 'wording-sample.md'), '--json']);
  assert.ok(r.code === 0 || r.code === 1, `unexpected exit ${r.code}\n${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.judge, 'wording');
  for (const key of ['overall', 'band', 'dimensions', 'findings', 'pass']) {
    assert.ok(key in out, `missing key "${key}" in judge JSON`);
  }
  assert.ok(out.overall >= 0 && out.overall <= 10, `overall ${out.overall} out of [0,10]`);
  // Each dimension carries name + numeric score.
  for (const d of out.dimensions) {
    assert.equal(typeof d.name, 'string');
    assert.equal(typeof d.score, 'number');
  }
});
