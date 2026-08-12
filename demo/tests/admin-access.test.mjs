// admin-access.test.mjs — the admin door, and the record of who walked through.
//
// Three server-level properties, each asserted in BOTH directions because each
// one is a rule that can be satisfied by doing nothing:
//
//   1. ADR-0013 §8. A missing ADMIN_TOKEN means 「open」 on the tunnel-only dev
//      instance and 「this instance is not configured」 (503) on the public one.
//      Fail-open on a public deploy publishes /api/admin/export — every course,
//      every message, every teacher — to anyone who asks.
//   2. ADR-0013 §7. Full admin read is accepted ONLY because every content read
//      is recorded. So an admin read appends exactly one row, and a teacher
//      reading her OWN course appends none — the log is about reach across
//      teachers, and a log that also records ordinary use is a log nobody can
//      scan.
//   3. /api/models is a caller-named fetch. It needs a session, and even with
//      one it may not be aimed at an internal address.
//
// Hermetic: scratch DEMO_DATA_DIR, scratch port, no keys, provider never used.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(HERE, '..');

/**
 * Start one server on its own port with its own data directory.
 * @param {number} port @param {Record<string,string>} env
 */
async function startServer(port, env) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'cst-admin-'));
  const child = spawn(process.execPath, [path.join(DEMO, 'serve.mjs'), '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    // The keys are cleared explicitly: a developer's own .env must not decide
    // whether this suite passes.
    env: {
      ...process.env, DEMO_DATA_DIR: dataDir, DATABASE_URL: '',
      MINIMAX_API_KEY: '', GLM_API_KEY: '', ZAI_API_KEY: '', KIMI_API_KEY: '',
      ...env,
    },
  });
  const started = new Promise((resolve) => {
    child.stdout.on('data', (b) => { if (String(b).includes(String(port))) resolve(); });
  });
  await Promise.race([started, once(child, 'exit').then(() => { throw new Error('server exited'); })]);
  const call = async (pathname, { method = 'GET', body, cookie, headers = {} } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON bodies stay in text */ }
    return { status: res.status, json, text, setCookie: res.headers.getSetCookie?.() ?? [] };
  };
  return {
    call,
    dataDir,
    async accessRows() {
      const dir = path.join(dataDir, 'auth', 'access-log');
      let names;
      try { names = await readdir(dir); } catch { return []; }
      const rows = [];
      for (const n of names.sort()) {
        const text = await readFile(path.join(dir, n), 'utf8');
        for (const line of text.split('\n')) if (line.trim()) rows.push(JSON.parse(line));
      }
      return rows;
    },
    async stop() { child.kill(); await rm(dataDir, { recursive: true, force: true }); },
  };
}

// ------------------------------------------------------- 1. the admin door

test('a public deploy with no ADMIN_TOKEN REFUSES the admin API instead of opening it', async (t) => {
  const s = await startServer(8931, { CHANNEL: 'public', ADMIN_TOKEN: '' });
  t.after(() => s.stop());

  for (const p of ['/api/admin/data', '/api/admin/export', '/api/admin/users', '/api/admin/courses/anything']) {
    const r = await s.call(p);
    assert.equal(r.status, 503, `${p} must refuse, got ${r.status}: ${r.text}`);
    assert.ok(!r.text.includes('courses'), 'nothing may leak in the refusal body');
  }
  // The console PAGE stays servable — it holds only the token prompt, and a
  // 404 there would look like a broken deploy rather than a missing setting.
  const page = await s.call('/admin');
  assert.equal(page.status, 200);
});

test('MUST PASS — the dev instance with no ADMIN_TOKEN is still open (the tunnel is the authentication)', async (t) => {
  const s = await startServer(8932, { CHANNEL: 'dev', ADMIN_TOKEN: '' });
  t.after(() => s.stop());

  const r = await s.call('/api/admin/data');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.token_required, false);
});

test('a public deploy WITH a token behaves normally, wrong password and right', async (t) => {
  const s = await startServer(8933, { CHANNEL: 'public', ADMIN_TOKEN: 'let-me-in' });
  t.after(() => s.stop());

  const wrong = await s.call('/api/admin/data', { headers: { 'x-admin-token': 'nope' } });
  assert.equal(wrong.status, 401, 'a wrong password is 401, not 503 — there IS a lock here');

  const right = await s.call('/api/admin/data', { headers: { 'x-admin-token': 'let-me-in' } });
  assert.equal(right.status, 200, right.text);
  assert.equal(right.json.token_required, true);
});

// ------------------------------------------------- 2. the access log itself

test('an admin content read appends exactly one row; a teacher reading her own course appends none', async (t) => {
  const s = await startServer(8934, { CHANNEL: 'dev', ADMIN_TOKEN: '' });
  t.after(() => s.stop());

  assert.deepEqual(await s.accessRows(), [], 'nothing logged before anyone looks');

  // A teacher, her session, and one course of her own.
  const created = await s.call('/api/admin/users', { method: 'POST', body: { username: 'log_teacher' } });
  assert.equal(created.status, 200, created.text);
  const login = await s.call('/api/auth/login', {
    method: 'POST', body: { username: 'log_teacher', password: created.json.temp_password },
  });
  assert.equal(login.status, 200, login.text);
  const cookie = login.setCookie.map((c) => c.split(';')[0]).join('; ');
  const course = await s.call('/api/courses', { method: 'POST', body: { title: '龙舟课' }, cookie });
  assert.equal(course.status, 200, course.text);
  const courseId = course.json.course.id;

  // Provisioning and login are admin ACTIONS, not content reads — they belong
  // in admin_audit, and none of them may appear here.
  assert.deepEqual(await s.accessRows(), [], 'provisioning a user is not a content read');

  // Her own course, read by her. This is the direction that must stay silent.
  const hers = await s.call(`/api/courses/${courseId}`, { cookie });
  assert.equal(hers.status, 200, hers.text);
  const herMessages = await s.call(`/api/courses/${courseId}/messages`, { cookie });
  assert.equal(herMessages.status, 200);
  assert.deepEqual(await s.accessRows(), [], 'a teacher reading her own course is not an admin read');

  // The console opening the same course. One row, naming what was opened.
  const adminRead = await s.call(`/api/admin/courses/${courseId}`);
  assert.equal(adminRead.status, 200, adminRead.text);
  const afterRead = await s.accessRows();
  assert.equal(afterRead.length, 1, 'exactly one row per read');
  assert.equal(afterRead[0].action, 'read_course');
  assert.equal(afterRead[0].course_id, courseId);
  assert.equal(afterRead[0].admin_id, 'console', 'ADR-0013 §8: a shared token resolves no user');
  assert.ok(afterRead[0].at, 'every row is timestamped');

  // The whole-instance export is the broadest read there is.
  const exported = await s.call('/api/admin/export');
  assert.equal(exported.status, 200);
  const afterExport = await s.accessRows();
  assert.equal(afterExport.length, 2);
  assert.equal(afterExport[1].action, 'export_course');

  // A log nobody can read is not an audit trail.
  const readBack = await s.call('/api/admin/access-log');
  assert.equal(readBack.status, 200, readBack.text);
  assert.equal(readBack.json.rows.length, 2);
  assert.equal(readBack.json.retention_days, 90);
  // Reading the log is deliberately NOT logged — an audit trail that audits
  // its own reads grows without bound and says nothing new.
  assert.equal((await s.accessRows()).length, 2);
});

// -------------------------------------------- 3. the caller-named fetch

test('/api/models needs a session, and cannot be aimed at an internal address', async (t) => {
  const s = await startServer(8935, { CHANNEL: 'dev', ADMIN_TOKEN: '' });
  t.after(() => s.stop());

  const anon = await s.call('/api/models', { method: 'POST', body: { provider: 'glm' } });
  assert.equal(anon.status, 401, anon.text);
  assert.equal(anon.json.need_login, true);

  const created = await s.call('/api/admin/users', { method: 'POST', body: { username: 'models_teacher' } });
  const login = await s.call('/api/auth/login', {
    method: 'POST', body: { username: 'models_teacher', password: created.json.temp_password },
  });
  const cookie = login.setCookie.map((c) => c.split(';')[0]).join('; ');

  // Signed in, but pointed at the metadata service / at localhost. The refusal
  // must arrive WITHOUT any upstream body attached to it.
  for (const baseURL of [
    'http://metadata.tencentyun.com/latest/meta-data',
    'https://169.254.169.254/',
    'https://127.0.0.1:5432/v1',
  ]) {
    const r = await s.call('/api/models', {
      method: 'POST', cookie,
      body: { provider: 'custom', key: 'sk-test', custom: { baseURL, model: 'x' } },
    });
    assert.equal(r.status, 200, r.text);         // the endpoint answers ok:false
    assert.equal(r.json.ok, false, `${baseURL} must be refused`);
    assert.match(r.json.message, /接口地址|不被允许/, r.json.message);
  }

  // MUST PASS — an ordinary provider with no key still gets the ordinary
  // 「fill a key first」 answer, so the guard has not broken the real path.
  const noKey = await s.call('/api/models', { method: 'POST', cookie, body: { provider: 'glm' } });
  assert.equal(noKey.json.ok, false);
  assert.match(noKey.json.message, /密钥/);
});

// ------------------------------- 4. what may be written into users.settings

test('PATCH /api/me refuses a profile carrying a key, and saves an ordinary one', async (t) => {
  const s = await startServer(8936, { CHANNEL: 'dev', ADMIN_TOKEN: '' });
  t.after(() => s.stop());

  const created = await s.call('/api/admin/users', { method: 'POST', body: { username: 'profile_teacher' } });
  const login = await s.call('/api/auth/login', {
    method: 'POST', body: { username: 'profile_teacher', password: created.json.temp_password },
  });
  const cookie = login.setCookie.map((c) => c.split(';')[0]).join('; ');

  // MUST PASS — an ordinary 教师档案 saves unchanged.
  const ok = await s.call('/api/me', {
    method: 'PATCH', cookie,
    body: { profile: { school: '番禺一幼', ageBand: '中班', stylePref: '提问引导' } },
  });
  assert.equal(ok.status, 200, ok.text);
  const me = await s.call('/api/me', { cookie });
  assert.equal(me.json.user.profile.school, '番禺一幼');

  // DATABASE.md 「What we deliberately do NOT store」: no key-shaped value in
  // users.settings. Refused, not masked — she has to know it did not save.
  const bad = await s.call('/api/me', {
    method: 'PATCH', cookie,
    body: { profile: { school: '番禺一幼', note: '我的钥匙 sk-BAIT-KEY-must-never-travel' } },
  });
  assert.equal(bad.status, 400, bad.text);
  assert.match(bad.json.message, /密钥/);

  // And the earlier profile is untouched by the refusal.
  const after = await s.call('/api/me', { cookie });
  assert.equal(after.json.user.profile.note, undefined);
  assert.equal(after.json.user.profile.school, '番禺一幼');

  // A profile bigger than the cap is refused too.
  const huge = await s.call('/api/me', {
    method: 'PATCH', cookie, body: { profile: { note: '长'.repeat(5000) } },
  });
  assert.equal(huge.status, 400, huge.text);
});
