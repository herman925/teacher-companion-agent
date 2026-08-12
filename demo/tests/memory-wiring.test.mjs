// memory-wiring.test.mjs — is the memory band actually ON the turn a
// logged-in teacher takes?
//
// memory-capture.test.mjs proves the policy. This proves the WIRING, which is a
// different claim and the one this repository keeps getting wrong: every rule
// in memory-scopes.mjs passed its own fixtures for weeks while nothing called
// it, so the band rendered nothing and harness rule 7 could not fire. A guard
// that is never reached is indistinguishable from a guard that never existed.
//
// So this runs a real server, seeds facts through the same store the server
// reads, takes a real turn, and looks at the prompt the server says it built
// (`prompt_debug.state_note`, dev mode).
//
// Two directions, and the second is the one that matters:
//   · a live fact REACHES the model;
//   · an archived one (child claim) DOES NOT, while still existing in storage.
//
// Hermetic: scratch DEMO_DATA_DIR, scratch port, provider 'mock' (never leaves
// the process, needs no key).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createJsonStore } from '../src/store/json-store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(HERE, '..');
const PORT = 8955;
const BASE = `http://127.0.0.1:${PORT}`;

async function api(pathname, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON stays in text */ }
  return { status: res.status, json, text, setCookie: res.headers.getSetCookie?.() ?? [] };
}

test('the memory band rides a real turn — live facts in, archived facts out', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'cst-memwire-'));
  const child = spawn(process.execPath, [path.join(DEMO, 'serve.mjs'), '--port', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DEMO_DATA_DIR: dataDir, DATABASE_URL: '', ADMIN_TOKEN: '' },
  });
  t.after(async () => { child.kill(); await rm(dataDir, { recursive: true, force: true }); });
  const started = new Promise((resolve) => {
    child.stdout.on('data', (b) => { if (String(b).includes(String(PORT))) resolve(); });
  });
  await Promise.race([started, once(child, 'exit').then(() => { throw new Error('server exited'); })]);

  const created = await api('/api/admin/users', { method: 'POST', body: { username: 'mem_wiring' } });
  const login = await api('/api/auth/login', {
    method: 'POST', body: { username: 'mem_wiring', password: created.json.temp_password },
  });
  const cookie = login.setCookie.find((c) => c.startsWith('cst_sid=')).split(';')[0];
  const course = (await api('/api/courses', { method: 'POST', body: { title: '醒狮' }, cookie })).json.course;

  // Seed through the same store the server reads. There is deliberately no
  // teacher-facing endpoint that writes a fact — memory comes from what she
  // said, never from a form (non-negotiable #2) — so the test writes where the
  // extractor writes.
  const store = createJsonStore({ baseDir: dataDir });
  await store.recordFact(created.json.user.id, {
    scope: 'course', course_id: course.id, kind: 'equipment',
    body: '班上没有鼓', quote: '我们班没有鼓', source: 'extracted',
  });
  const claim = await store.recordFact(created.json.user.id, {
    scope: 'course', course_id: course.id, kind: 'class_composition',
    body: '孩子们都学会了敲鼓的节奏', quote: '孩子们都学会了敲鼓的节奏', source: 'extracted',
  });
  await store.archiveFact(created.json.user.id, claim.id, { reason: 'child_claim' });

  const turn = await api(`/api/courses/${course.id}/chat`, {
    method: 'POST', cookie, body: { message: '接下来这周做什么好？', provider: 'mock', debug: true },
  });
  assert.equal(turn.status, 200, turn.text);
  const emitted = turn.json.events.find((e) => e.event === 'turn');
  assert.ok(emitted, turn.text);
  const note = emitted.data.prompt_debug?.state_note;
  assert.ok(note, 'dev 模式要把真正发出去的提示词给出来，否则这条断言无从做起');

  // DIRECTION ONE: the constraint is in the prompt, in the memory band.
  assert.ok(note.includes('班上没有鼓'), '记忆没有上车——band 又断了');
  assert.ok(note.includes('# 记忆'), '而且它是作为记忆band出现的，不是碰巧出现在快照里');

  // DIRECTION TWO: the archived child claim is nowhere in what the model reads.
  // Archived-and-still-injected is the failure that matters; a test that only
  // checked the archive flag in storage would pass while the sentence rode
  // every prompt under a settled-looking header.
  assert.ok(!note.includes('学会了敲鼓'), '归档的儿童断言一个字都不许进提示词');

  // …and archiving is not deleting: it is still on record for the console and
  // the export, with its reason.
  const kept = await store.listFacts(created.json.user.id, { courseId: course.id, includeArchived: true });
  const row = kept.find((f) => f.id === claim.id);
  assert.equal(row.archived, true);
  assert.equal(row.archive_reason, 'child_claim');
});
