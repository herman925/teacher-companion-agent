// Auth layer (SECURITY.md): password hashing, sessions, display-name rules,
// user lifecycle, and course scoping. Both directions per the repo's
// runtime-harness discipline: every guard must reject the bad case AND admit
// the good one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createJsonStore } from '../src/store/json-store.mjs';
import { hashPassword, verifyPassword, displayNameError, parseCookies, sessionCookie } from '../src/auth-util.mjs';

const base = mkdtempSync(path.join(tmpdir(), 'cst-auth-'));
const store = createJsonStore({ baseDir: base });
test.after(() => rmSync(base, { recursive: true, force: true }));

test('scrypt roundtrip: correct password verifies, wrong one does not', () => {
  const stored = hashPassword('s3cret-pw');
  assert.ok(stored.startsWith('scrypt$32768$'));
  assert.ok(verifyPassword('s3cret-pw', stored));
  assert.ok(!verifyPassword('s3cret-pW', stored));
  assert.ok(!verifyPassword('s3cret-pw', 'garbage'));
});

test('display-name rules: both directions', () => {
  assert.equal(displayNameError('番禺陈老师'), null);
  assert.equal(displayNameError('Li_Lao-Shi·8'), null);
  assert.ok(displayNameError('x'));                       // too short
  assert.ok(displayNameError('a'.repeat(21)));            // too long
  assert.ok(displayNameError('老师 张'));                  // space not allowed
  assert.ok(displayNameError('fuckteacher'));             // EN profanity
  assert.ok(displayNameError('傻逼老师'));                 // CN profanity
  const recent = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  assert.ok(displayNameError('新昵称ok', { lastChangedAt: recent }));   // 6-month lock
  const old = new Date(Date.now() - 200 * 24 * 3600 * 1000).toISOString();
  assert.equal(displayNameError('新昵称ok', { lastChangedAt: old }), null);
});

test('user lifecycle: create → login → change password → disable kills access', async () => {
  const { user, temp_password } = await store.createUser({ username: 'Teacher_A', displayName: '陈老师' });
  assert.equal(user.username, 'teacher_a', 'username lowercased');
  assert.ok(user.must_change_password);
  assert.ok(!('password' in user), 'sanitized user never carries the hash');

  // duplicates rejected
  await assert.rejects(store.createUser({ username: 'teacher_a' }), /用户名已存在/);
  await assert.rejects(store.createUser({ username: 'other-x', displayName: '陈老师' }), /昵称已被占用/);
  await assert.rejects(store.createUser({ username: 'AB' }), /用户名需为/);

  // login: temp password works, wrong password does not
  assert.equal(await store.verifyLogin('teacher_a', 'nope'), null);
  const logged = await store.verifyLogin('teacher_a', temp_password);
  assert.equal(logged.id, user.id);
  assert.ok(logged.last_login_at);

  // change password: wrong old rejected, right old accepted + flag cleared
  await assert.rejects(store.changePassword(user.id, 'wrong-old', 'newpass-123'), /旧密码不对/);
  await assert.rejects(store.changePassword(user.id, temp_password, 'short'), /至少 8 位/);
  await store.changePassword(user.id, temp_password, 'newpass-123');
  const after = await store.verifyLogin('teacher_a', 'newpass-123');
  assert.equal(after.must_change_password, false);
  assert.equal(await store.verifyLogin('teacher_a', temp_password), null, 'temp password dead after change');

  // disable: login fails AND live sessions stop resolving
  const { token } = await store.createSession(user.id, 'test-agent');
  assert.ok(await store.getSessionUser(token));
  await store.updateUser(user.id, { status: 'disabled' });
  assert.equal(await store.verifyLogin('teacher_a', 'newpass-123'), null);
  assert.equal(await store.getSessionUser(token), null);
  await store.updateUser(user.id, { status: 'active' });
});

test('sessions: bearer token resolves; sid list never leaks tokens; revoke works', async () => {
  const { user, temp_password } = await store.createUser({ username: 'teacher_b' });
  await store.verifyLogin('teacher_b', temp_password);
  const s1 = await store.createSession(user.id, 'device-1');
  const s2 = await store.createSession(user.id, 'device-2');

  const hit = await store.getSessionUser(s1.token);
  assert.equal(hit.user.id, user.id);
  assert.equal(await store.getSessionUser('not-a-token'), null);

  const list = await store.listSessions(user.id, s1.token);
  assert.equal(list.length, 2);
  assert.ok(list.every((s) => !('token' in s)), 'device list carries sids only');
  assert.equal(list.find((s) => s.current).user_agent, 'device-1');

  // revoke device 2 by sid; device 1 unaffected
  assert.ok(await store.revokeSession(user.id, s2.sid));
  assert.equal(await store.getSessionUser(s2.token), null);
  assert.ok(await store.getSessionUser(s1.token));
  // logout by token
  assert.ok(await store.revokeByToken(s1.token));
  assert.equal(await store.getSessionUser(s1.token), null);
});

test('display-name change: store enforces uniqueness; profile persists per user', async () => {
  const a = await store.createUser({ username: 'teacher_c', displayName: '林老师' });
  const b = await store.createUser({ username: 'teacher_d', displayName: '黄老师' });
  await assert.rejects(store.setDisplayName(b.user.id, '林老师'), /昵称已被占用/);
  const renamed = await store.setDisplayName(b.user.id, '黄大老师');
  assert.equal(renamed.display_name, '黄大老师');
  assert.ok(renamed.display_name_changed_at);

  await store.saveUserProfile(a.user.id, { province: '广东省', region: '广州市番禺区' });
  assert.equal((await store.getUser(a.user.id)).profile.region, '广州市番禺区');
  assert.equal((await store.getUser(b.user.id)).profile, null, 'profiles do not bleed across users');
});

test('course scoping: users only see their own; cross-user reads miss', async () => {
  const a = await store.createUser({ username: 'owner_a' });
  const b = await store.createUser({ username: 'owner_b' });
  const courseA = await store.createCourse(a.user.id, 'A 的醒狮');
  await store.createCourse(b.user.id, 'B 的龙舟');

  const listA = await store.listCourses(a.user.id);
  assert.equal(listA.length, 1);
  assert.equal(listA[0].title, 'A 的醒狮');
  assert.equal(await store.getCourse(b.user.id, courseA.id), null, 'cross-user read misses');
  assert.equal(await store.deleteCourse(b.user.id, courseA.id), false, 'cross-user delete refused');
  assert.ok(await store.deleteCourse(a.user.id, courseA.id));
});

test('audit: admin actions leave rows, newest first', async () => {
  await store.audit('console', 'create_user', 'u-1', { username: 'x' });
  await store.audit('console', 'reset_password', 'u-1', null);
  const rows = await store.listAudit({ limit: 10 });
  assert.ok(rows.length >= 2);
  assert.equal(rows[0].action, 'reset_password');
  assert.ok(rows[0].created_at);
});

test('cookie helpers: parse + httpOnly attributes', () => {
  const jar = parseCookies({ headers: { cookie: 'a=1; cst_sid=tok%2Fx; b=2' } });
  assert.equal(jar.cst_sid, 'tok/x');
  const set = sessionCookie('abc');
  assert.ok(set.includes('HttpOnly') && set.includes('SameSite=Lax') && set.includes('Max-Age='));
});
