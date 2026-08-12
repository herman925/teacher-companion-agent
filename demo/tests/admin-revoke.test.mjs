// admin-revoke.test.mjs — revoking an account, through the console door.
//
// The requirement in one line: there must be a way to KEEP the data that is not
// deleting the user. Revoking stops access and starts the clock; it does not
// remove anything.
//
// The console could only ever write `status: 'disabled'`, which reads as「she
// cannot log in」and is invisible to everything else: `dueForErasure` only ever
// looks at `revoked`, and it needs `revoked_at` to know when the window opened.
// So a disabled account was data kept forever with nobody having decided that,
// and the retention story had no start time. Both halves are asserted here —
// access stops, AND the data is still there afterwards. Testing only the first
// would pass just as well for `deleteUser`, which is the operation this one
// exists not to be.
//
// Hermetic: scratch DEMO_DATA_DIR, scratch port, no keys, no provider calls.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(HERE, '..');
const ADMIN_TOKEN = 'revoke-test-token';
// One port per test. Sharing one would make the suite depend on how fast the
// previous child releases the socket, which is a race, not a test.
let PORT = 8947;
let BASE = `http://127.0.0.1:${PORT}`;

async function api(pathname, { method = 'GET', body, cookie, admin = false, raw = false } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      ...(raw ? {} : { 'content-type': 'application/json' }),
      accept: raw ? '*/*' : 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(admin ? { 'x-admin-token': ADMIN_TOKEN } : {}),
    },
    body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON stays in text */ }
  return { status: res.status, json, text, setCookie: res.headers.getSetCookie?.() ?? [] };
}

async function startServer(t) {
  PORT += 1;
  BASE = `http://127.0.0.1:${PORT}`;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'cst-revoke-'));
  const child = spawn(process.execPath, [path.join(DEMO, 'serve.mjs'), '--port', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, DEMO_DATA_DIR: dataDir, DATABASE_URL: '', ADMIN_TOKEN,
      MINIMAX_API_KEY: '', GLM_API_KEY: '', ZAI_API_KEY: '', KIMI_API_KEY: '',
    },
  });
  t.after(async () => { child.kill(); await rm(dataDir, { recursive: true, force: true }); });
  const started = new Promise((resolve) => {
    child.stdout.on('data', (b) => { if (String(b).includes(String(PORT))) resolve(); });
  });
  await Promise.race([started, once(child, 'exit').then(() => { throw new Error('server exited'); })]);
}

test('revoking stops access, starts the clock, and keeps every byte of her work', async (t) => {
  await startServer(t);

  // A teacher who has done a term's work: an account, a course, an upload.
  const created = await api('/api/admin/users', { method: 'POST', body: { username: 'left_school' }, admin: true });
  assert.equal(created.status, 200, created.text);
  const uid = created.json.user.id;
  const temp = created.json.temp_password;

  const login = await api('/api/auth/login', { method: 'POST', body: { username: 'left_school', password: temp } });
  assert.equal(login.status, 200);
  const cookie = login.setCookie.find((c) => c.startsWith('cst_sid=')).split(';')[0];

  const course = (await api('/api/courses', { method: 'POST', body: { title: '醒狮' }, cookie })).json.course;
  const upload = await fetch(`${BASE}/api/courses/${course.id}/materials`, {
    method: 'POST', headers: { 'content-type': 'application/pdf', cookie }, body: Buffer.from('%PDF-1.7\n%%EOF\n'),
  });
  assert.equal(upload.status, 200);

  // MUST PASS half: while she is active, everything works.
  assert.equal((await api('/api/me', { cookie })).status, 200);

  // ---- the revocation ----
  const revoked = await api(`/api/admin/users/${uid}`, { method: 'PATCH', body: { action: 'revoke' }, admin: true });
  assert.equal(revoked.status, 200, revoked.text);
  assert.equal(revoked.json.user.status, 'revoked', '不是 disabled——保留期机器只认 revoked');
  assert.ok(revoked.json.user.revoked_at, '保留期的时钟从这里开始走；没有这个戳，这一行会永远躺着');

  // ACCESS STOPS, both ways in.
  const relogin = await api('/api/auth/login', { method: 'POST', body: { username: 'left_school', password: temp } });
  assert.equal(relogin.status, 401, '撤销之后不能再登录');
  const stale = await api('/api/me', { cookie });
  assert.equal(stale.status, 401, '已经开着的会话也要立刻失效');
  assert.equal((await api(`/api/courses/${course.id}`, { cookie })).status, 401);

  // THE DATA STAYS. This is the half that separates revoke from erase: the
  // kindergarten may still need last year's curriculum.
  const adminCourse = await api(`/api/admin/courses/${course.id}`, { admin: true });
  assert.equal(adminCourse.status, 200, '课程还在');
  assert.equal(adminCourse.json.course.title, '醒狮');
  const mats = await api(`/api/admin/courses/${course.id}/materials`, { admin: true });
  assert.equal(mats.json.materials.length, 1, '上传的文件也还在');

  // The console can see the state and the date it started.
  const users = await api('/api/admin/users', { admin: true });
  const row = users.json.users.find((u) => u.id === uid);
  assert.equal(row.status, 'revoked');
  assert.equal(row.revoked_at, revoked.json.user.revoked_at);

  // The export carries it — a revocation no export records is a retention
  // clock nobody outside this one screen can audit.
  const exported = await api('/api/admin/export', { admin: true });
  const exportedUser = exported.json.users.find((u) => u.id === uid);
  assert.equal(exportedUser.status, 'revoked');
  assert.ok(exportedUser.revoked_at);
  assert.equal(exported.json.courses.some((c) => c.id === course.id), true, '导出里她的课程一个不少');

  // And it is audited, by the store, without this endpoint writing a second row.
  const audit = await api('/api/admin/audit', { admin: true });
  const entries = audit.json.audit.filter((r) => r.action === 'revoke_user' && r.target_user === uid);
  assert.equal(entries.length, 1, '一次撤销记一行——不多不少');
  assert.ok(entries[0].detail.revoked_at);
});

test('a second revoke does not move the clock forward, and reinstating stops it', async (t) => {
  await startServer(t);
  const created = await api('/api/admin/users', { method: 'POST', body: { username: 'twice_revoked' }, admin: true });
  const uid = created.json.user.id;

  const first = await api(`/api/admin/users/${uid}`, { method: 'PATCH', body: { action: 'revoke' }, admin: true });
  const second = await api(`/api/admin/users/${uid}`, { method: 'PATCH', body: { action: 'revoke' }, admin: true });
  assert.equal(second.json.user.revoked_at, first.json.user.revoked_at,
    '第二次撤销不许把时钟往后拨——否则「已撤销」会悄悄变成「永久保留」');

  // Reinstatement stops the clock. Leaving the stamp behind would hand the
  // scheduled erasure job a live account to delete.
  const back = await api(`/api/admin/users/${uid}`, { method: 'PATCH', body: { action: 'enable' }, admin: true });
  assert.equal(back.json.user.status, 'active');
  assert.equal(back.json.user.revoked_at, null);

  // She can log in again — the account was kept, not destroyed.
  const login = await api('/api/auth/login', {
    method: 'POST', body: { username: 'twice_revoked', password: created.json.temp_password },
  });
  assert.equal(login.status, 200);
});

test('revoking needs the admin door, like every other account action', async (t) => {
  await startServer(t);
  const created = await api('/api/admin/users', { method: 'POST', body: { username: 'no_token_revoke' }, admin: true });
  const uid = created.json.user.id;
  const nope = await api(`/api/admin/users/${uid}`, { method: 'PATCH', body: { action: 'revoke' } });
  assert.equal(nope.status, 401);
  const still = await api('/api/admin/users', { admin: true });
  assert.equal(still.json.users.find((u) => u.id === uid).status, 'active', '没通过的撤销不许留下任何痕迹');
});
