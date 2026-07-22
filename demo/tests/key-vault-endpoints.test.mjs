// Server-level vault + rate-limit tests, both directions (spec 2026-07-22):
//   - keys are write-only per-account: flags for the owner, nothing for others,
//     never a value anywhere (exports string-scanned for the seeded key);
//   - login brute force trips per-username at 5 while a fresh user still works,
//     and the admin rate-limits endpoint relieves it;
//   - the vault file holds ciphertext, not the plaintext key.
//
// Hermetic: scratch DEMO_DATA_DIR + scratch port; ADMIN_TOKEN unset = admin
// API open (dev-instance semantics), which the user-provisioning here relies on.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(HERE, '..');
const PORT = 8917;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'endpoint-test-secret-0123456789abcdef';
const SEEDED_KEY = 'sk-SEEDED-VAULT-KEY-a1b2c3';

let child;
let dataDir;

async function api(pathname, { method = 'GET', body, cookie, headers = {} } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON bodies stay in text */ }
  return { status: res.status, json, text, setCookie: res.headers.getSetCookie?.() ?? [] };
}

/** Provision a user via the (open) admin API, then log in; returns a cookie. */
async function makeUser(username) {
  const created = await api('/api/admin/users', { method: 'POST', body: { username } });
  assert.equal(created.status, 200, `create ${username}: ${created.text}`);
  const login = await api('/api/auth/login', {
    method: 'POST', body: { username, password: created.json.temp_password },
  });
  assert.equal(login.status, 200, `login ${username}: ${login.text}`);
  const session = login.setCookie.find((c) => c.startsWith('cst_sid='));
  assert.ok(session, 'login sets the session cookie');
  return session.split(';')[0];
}

test.before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'cst-vault-test-'));
  child = spawn(process.execPath, [path.join(DEMO, 'serve.mjs'), '--port', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DEMO_DATA_DIR: dataDir,
      KEYS_SECRET: SECRET,
      ADMIN_TOKEN: '',
      GLM_API_KEY: '', // no env keys — flags must come from the vault alone
    },
  });
  const started = new Promise((resolve) => {
    child.stdout.on('data', (b) => { if (String(b).includes(String(PORT))) resolve(); });
  });
  await Promise.race([started, once(child, 'exit').then(() => { throw new Error('server exited'); })]);
});

test.after(async () => {
  child?.kill();
  await rm(dataDir, { recursive: true, force: true });
});

test('vault: write-only per-account — owner sees a flag, others see nothing, no value anywhere', async () => {
  const a = await makeUser('teacher-a');
  const b = await makeUser('teacher-b');

  const put = await api('/api/me/keys/glm', { method: 'PUT', cookie: a, body: { key: SEEDED_KEY } });
  assert.equal(put.status, 200, put.text);
  assert.equal(put.json.configured, true);
  assert.ok(!put.text.includes(SEEDED_KEY), 'save response must not echo the key');

  const flagsA = await api('/api/me/keys', { cookie: a });
  assert.equal(flagsA.json.keys.glm, true, 'owner sees the configured flag');
  assert.ok(!flagsA.text.includes(SEEDED_KEY), 'flags carry no value');

  const flagsB = await api('/api/me/keys', { cookie: b });
  assert.equal(flagsB.json.keys.glm, undefined, 'the other account sees nothing — the cross-account leak is closed');

  const anon = await api('/api/me/keys');
  assert.equal(anon.status, 401, 'no session, no flags');

  // At rest: ciphertext only.
  const onDisk = await readFile(path.join(dataDir, 'auth', 'keys.json'), 'utf8');
  assert.ok(!onDisk.includes(SEEDED_KEY), 'keys.json must hold ciphertext, not the key');
  assert.match(onDisk, /v1\$/, 'ciphertext rows present');

  // Deleting clears the flag.
  await api('/api/me/keys/glm', { method: 'PUT', cookie: a, body: { key: '' } });
  const cleared = await api('/api/me/keys', { cookie: a });
  assert.equal(cleared.json.keys.glm, undefined);
});

test('exports never carry a vaulted key value', async () => {
  const a = await makeUser('teacher-export');
  await api('/api/me/keys/kimi', { method: 'PUT', cookie: a, body: { key: SEEDED_KEY } });
  for (const p of ['/api/admin/export', '/api/admin/data', '/api/admin/users']) {
    const res = await api(p);
    assert.ok(!res.text.includes(SEEDED_KEY), `${p} leaked the seeded key`);
  }
});

test('login brute force: 5 failures trip the username, a fresh user still logs in, admin unlock relieves', async () => {
  const created = await api('/api/admin/users', { method: 'POST', body: { username: 'locked-out' } });
  for (let i = 0; i < 5; i += 1) {
    const bad = await api('/api/auth/login', { method: 'POST', body: { username: 'locked-out', password: 'wrong-pass' } });
    assert.equal(bad.status, 401, `failure ${i + 1} is a plain 401`);
  }
  const tripped = await api('/api/auth/login', {
    method: 'POST', body: { username: 'locked-out', password: created.json.temp_password },
  });
  assert.equal(tripped.status, 429, 'even the RIGHT password answers 429 while locked');
  assert.ok(tripped.json.retry_after > 0, '429 carries retry_after');

  // A different account is unaffected (both directions).
  const fresh = await makeUser('unaffected');
  assert.ok(fresh.startsWith('cst_sid='));

  // Admin sees the tripped entry and clears it; login works again.
  const list = await api('/api/admin/rate-limits');
  const row = list.json.limits.find((r) => r.kind === 'login_user' && r.key === 'locked-out');
  assert.ok(row?.limited, 'admin list shows the lockout');
  const clear = await api(`/api/admin/rate-limits/${encodeURIComponent(row.id)}`, { method: 'DELETE' });
  assert.equal(clear.status, 200, clear.text);
  const after = await api('/api/auth/login', {
    method: 'POST', body: { username: 'locked-out', password: created.json.temp_password },
  });
  assert.equal(after.status, 200, 'admin unlock restores login immediately');
});

test('health advertises the vault so the client can switch modes', async () => {
  const res = await api('/api/health');
  assert.equal(res.json.key_vault, true);
});
