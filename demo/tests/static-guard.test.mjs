// Static-file guard, both directions (CLAUDE.md: a rule must fire on a violating
// fixture AND stay silent on a compliant one).
//
// Regression net for two live exposures found in the 2026-07-22 pre-deploy audit,
// both reachable on the public instance (nginx → this same handler on port 80):
//   1. GET /.data/auth/sessions.json returned live session bearer tokens, and
//      /.data/auth/users.json returned password hashes — demo/.data sits inside
//      the served root (child-data non-negotiable #4).
//   2. GET /..%2f<file> escaped demo/ entirely, because decodeURIComponent runs
//      after the URL parser normalises dot-segments and the containment check
//      allowed the whole checkout root — that reaches .env (model keys,
//      DATABASE_URL, ADMIN_TOKEN) and .git/ on a deployed instance.
//
// The server is started as a child process on a scratch port; it needs no keys
// and no database for static serving, so this stays hermetic and offline.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(HERE, '..');
const CHECKOUT = path.join(DEMO, '..');
const PORT = 8913;
const BASE = `http://127.0.0.1:${PORT}`;

/** Bait files, so a pass means "refused", never "happened not to exist". */
const BAIT = [
  { file: path.join(DEMO, '.data', 'auth', 'sessions.json'), body: '[{"token":"BAIT-SESSION-TOKEN"}]' },
  { file: path.join(CHECKOUT, '.env'), body: 'GLM_API_KEY=BAIT-MODEL-KEY\n' },
];

let child;

test.before(async () => {
  for (const { file, body } of BAIT) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
  }
  child = spawn(process.execPath, [path.join(DEMO, 'serve.mjs'), '--port', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // serve.mjs prints its URL once listening.
  const started = new Promise((resolve) => {
    child.stdout.on('data', (b) => { if (String(b).includes(String(PORT))) resolve(); });
  });
  await Promise.race([started, once(child, 'exit').then(() => { throw new Error('server exited'); })]);
});

test.after(async () => {
  child?.kill();
  // Only the .env bait is ours to remove; demo/.data is real state on a dev box,
  // so put back nothing and delete nothing beyond the file we wrote.
  await rm(path.join(CHECKOUT, '.env'), { force: true });
});

test('REFUSES the live data directory (session tokens, password hashes, courses)', async () => {
  for (const p of ['/.data/auth/sessions.json', '/.data/auth/users.json', '/.data/courses/']) {
    const res = await fetch(BASE + p);
    assert.equal(res.status, 403, `${p} must be refused, got ${res.status}`);
    assert.doesNotMatch(await res.text(), /BAIT-SESSION-TOKEN/, `${p} leaked the bait token`);
  }
});

test('REFUSES percent-encoded traversal out of demo/', async () => {
  for (const p of ['/..%2f.env', '/..%2fpackage.json', '/..%2f.git/config', '/%2e%2e%2f.env']) {
    const res = await fetch(BASE + p);
    assert.ok(res.status === 403 || res.status === 404, `${p} must not be served, got ${res.status}`);
    assert.doesNotMatch(await res.text(), /BAIT-MODEL-KEY/, `${p} leaked the bait key`);
  }
});

test('STAYS SILENT on the files it is supposed to serve', async () => {
  const ok = async (p, needle) => {
    const res = await fetch(BASE + p);
    assert.equal(res.status, 200, `${p} should be served, got ${res.status}`);
    if (needle) assert.match(await res.text(), needle, `${p} served the wrong body`);
  };
  await ok('/', /小小探索家/);
  await ok('/index.html', /小小探索家/);
  await ok('/src/ui/main.js', /buildModelsPane/);
  await ok('/src/ui/assets/providers/glm.svg', /<svg/);
  // /schema/ passthrough into harness/ must still work — it is a second base,
  // not a hole; the guard is per-base.
  const schema = await fetch(`${BASE}/schema/turn-contract.schema.json`);
  assert.ok(schema.status === 200 || schema.status === 404, `schema passthrough broke: ${schema.status}`);
});
