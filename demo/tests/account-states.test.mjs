// The three account states (ADR-0013 §11, DATABASE.md §5b): active, revoked,
// erased — three operations for three situations, not points on a scale.
//
// Both directions everywhere, per the repo's harness discipline: revoke must
// kill login AND leave the courses standing; erase must remove every row of
// the erased user AND leave every row of the teacher next to her untouched;
// the retention window must catch the account past it AND spare the one inside
// it. A test that only proves the destructive half proves nothing about a
// kindergarten that still needs last year's curriculum.
//
// No database is involved: this is the JSON tier. The pg-store will implement
// the same interface and inherit these expectations.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createJsonStore, isDueForErasure, DEFAULT_ERASURE_WINDOW_DAYS, USER_SCOPED_FILES,
} from '../src/store/json-store.mjs';

const base = mkdtempSync(path.join(tmpdir(), 'cst-states-'));
const store = createJsonStore({ baseDir: base });
test.after(() => rmSync(base, { recursive: true, force: true }));

const DAY = 24 * 60 * 60 * 1000;
const at = (...parts) => path.join(base, ...parts);
const coursePath = (id) => at('courses', `${encodeURIComponent(id)}.json`);
const readFile = (file) => JSON.parse(readFileSync(file, 'utf8'));
const writeSeed = (file, rows) => writeFileSync(file, JSON.stringify(rows, null, 2), 'utf8');

/** Every JSON file the store keeps, recursively — the erase test reads them all. */
function allStoreFiles(dir = base) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allStoreFiles(p));
    else if (entry.name.endsWith('.json')) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- revoke

test('revoke: login and sessions die, the courses stay, the next teacher is untouched', async () => {
  const { user: admin } = await store.createUser({ username: 'admin_one', displayName: '管理员甲', role: 'admin' });
  const { user: left, temp_password: leftPw } = await store.createUser({ username: 'left_school', displayName: '离职老师' });
  const { user: stays, temp_password: staysPw } = await store.createUser({ username: 'still_here', displayName: '在职老师' });

  const course = await store.createCourse(left.id, '去年的醒狮');
  await store.appendMessage(course.id, { role: 'teacher', content: '孩子们上周看了狮头' });
  await store.setUserKey(left.id, 'glm', 'cipher-left');
  const leftSession = await store.createSession(left.id, 'left-device');
  const staysCourse = await store.createCourse(stays.id, '今年的龙舟');
  const staysSession = await store.createSession(stays.id, 'stays-device');

  const revoked = await store.revokeUser(admin.id, left.id);
  assert.equal(revoked.status, 'revoked');
  assert.ok(revoked.revoked_at, 'the retention clock starts here, or the row sits forever');

  // Access is gone.
  assert.equal(await store.verifyLogin('left_school', leftPw), null, 'revoked login refused');
  assert.equal(await store.getSessionUser(leftSession.token), null, 'live session stops resolving');

  // The data is not.
  const kept = await store.getCourse(left.id, course.id);
  assert.ok(kept, 'her course survives revocation');
  assert.equal(kept.title, '去年的醒狮');
  assert.equal((await store.listCourses(left.id)).length, 1, 'and still lists');
  assert.equal((await store.getMessages(course.id)).length, 1, 'messages survive too');
  assert.equal((await store.getUserKeys(left.id)).glm, 'cipher-left', 'the vault entry is not a deletion');
  assert.ok(await store.getUser(left.id), 'the user row is still there — revocation is not deletion');

  // The teacher next to her notices nothing.
  assert.ok(await store.verifyLogin('still_here', staysPw), 'the active account still logs in');
  assert.ok(await store.getSessionUser(staysSession.token), 'and its session still resolves');
  assert.ok(await store.getCourse(stays.id, staysCourse.id));

  // The action left a trail naming who did it.
  const row = (await store.listAudit({ limit: 20 })).find((r) => r.action === 'revoke_user');
  assert.equal(row.admin_id, admin.id);
  assert.equal(row.target_user, left.id);
  assert.ok(row.detail.revoked_at);
  assert.equal(row.detail.sessions_revoked, 1);
});

test('revoke twice does not restart the retention clock; reinstatement stops it', async () => {
  const { user: admin } = await store.createUser({ username: 'admin_two', displayName: '管理员乙', role: 'admin' });
  const { user: u, temp_password } = await store.createUser({ username: 'twice_rev', displayName: '两次老师' });

  const first = await store.revokeUser(admin.id, u.id);
  const second = await store.revokeUser(admin.id, u.id);
  assert.equal(second.revoked_at, first.revoked_at,
    'a second click must not move the stamp forward, or revoked quietly means kept forever');

  // Reinstate: login works again and the clock is cleared, so the scheduled
  // erasure job cannot come for a teacher who came back.
  const back = await store.updateUser(u.id, { status: 'active' });
  assert.equal(back.status, 'active');
  assert.equal(back.revoked_at, null);
  assert.ok(await store.verifyLogin('twice_rev', temp_password), 'reinstated login works');
  assert.ok(!(await store.dueForErasure(Date.now() + 10 * 365 * DAY)).includes(u.id),
    'a reinstated account is never due, however long it has been');
});

// ---------------------------------------------------------------- erase

test('erase: objects before rows, nothing left referencing the user, the neighbour untouched', async () => {
  const { user: admin } = await store.createUser({ username: 'admin_era', displayName: '管理员丙', role: 'admin' });
  const { user: doomed, temp_password: doomedPw } = await store.createUser({ username: 'erase_me', displayName: '要清除的老师' });
  const { user: keeper } = await store.createUser({ username: 'keep_me', displayName: '保留的老师' });

  // A full account: two courses with messages and snapshots, workbench scratch,
  // a vault key, two sessions, uploads, memory rows, and log rows.
  const c1 = await store.createCourse(doomed.id, '醒狮');
  const c2 = await store.createCourse(doomed.id, '龙舟');
  await store.appendMessage(c1.id, { role: 'teacher', content: '我们班没有鼓' });
  await store.appendMessage(c1.id, { role: 'agent', content: '好的', subject: '3.2.1' });
  await store.saveState(c1.id, { stage: 1 }, { stage: 1 }, 0);
  await store.setWorkbench(doomed.id, c1.id, { blueprint_comments: [{ id: 'theme_judgment', text: '更贴近镇里的龙舟基地' }] });
  await store.setUserKey(doomed.id, 'glm', 'cipher-doomed');
  const s1 = await store.createSession(doomed.id, 'phone');
  await store.createSession(doomed.id, 'laptop');
  await store.logScope({ rule: 'weather', enforced: false, refused: false, excerpt: '明天下雨吗', userId: doomed.id });
  await store.audit(admin.id, 'reset_password', doomed.id, null);

  const keeperCourse = await store.createCourse(keeper.id, '保留的课');
  await store.setUserKey(keeper.id, 'glm', 'cipher-keeper');
  await store.logScope({ rule: 'markets', enforced: false, refused: false, excerpt: '股票怎么样', userId: keeper.id });

  // Uploads: one row in the registry, one key recorded on the course record —
  // both shapes exist in the wild, and a key swept from only one of them is the
  // orphaned child photo ADR-0013 §6 designs against.
  const mat = await store.recordMaterial(doomed.id, c1.id, {
    kind: 'photo', mime_type: 'image/jpeg', cos_key: 'courses/c1/aaa.jpg',
    size_bytes: 2_400_000, exif_stripped: true, contains_children: true,
  });
  await store.recordMaterial(keeper.id, keeperCourse.id, {
    kind: 'document', mime_type: 'application/pdf', cos_key: 'courses/kk/keep.pdf', size_bytes: 1000,
  });
  const raw = readFile(coursePath(c1.id));
  raw.materials = [{ cos_key: 'courses/c1/embedded.jpg' }];
  writeSeed(coursePath(c1.id), raw);

  // Memory rows in the user-scoped collections (the files USER_SCOPED_FILES
  // names). Seeded directly because the JSON tier has no writer for them yet —
  // the sweep is defined over these paths, and that is the contract.
  writeSeed(at('facts.json'), [
    { id: 'f1', user_id: doomed.id, scope: 'class', kind: 'equipment', body: '班上没有鼓' },
    { id: 'f2', user_id: keeper.id, scope: 'course', kind: 'space', body: '多功能室有投影仪' },
  ]);
  writeSeed(at('classes.json'), [
    { id: 'cl1', user_id: doomed.id, name: '中三班' },
    { id: 'cl2', user_id: keeper.id, name: '大一班' },
  ]);
  writeSeed(at('interaction-signals.json'), [
    { id: 1, user_id: doomed.id, axis: 'detail', signal: '要求更细', delta: 1 },
    { id: 2, user_id: keeper.id, axis: 'detail', signal: '要求更简', delta: -1 },
  ]);

  // Objects before rows: the deleter runs while every row is still on disk.
  const deletedKeys = [];
  const receipt = await store.eraseUser(admin.id, doomed.id, {
    deleteObject: (key) => {
      deletedKeys.push(key);
      // Read the files directly — calling back into the store here would wait
      // on the lock this erase is holding.
      assert.ok(existsSync(coursePath(c1.id)), 'the course file is still there when the object goes');
      assert.ok(readFile(at('auth', 'users.json')).some((u) => u.id === doomed.id), 'and so is the user row');
    },
  });

  assert.deepEqual(deletedKeys.sort(), ['courses/c1/aaa.jpg', 'courses/c1/embedded.jpg'],
    'both the registry key and the course-recorded key are deleted');
  assert.equal(receipt.username, 'erase_me');
  assert.equal(receipt.objects_deleted, true);
  assert.equal(receipt.deleted.courses, 2);
  assert.equal(receipt.deleted.messages, 2);
  assert.ok(receipt.deleted.snapshots >= 1);
  assert.equal(receipt.deleted.materials, 1);
  assert.equal(receipt.deleted.facts, 1);
  assert.equal(receipt.deleted.classes, 1);
  assert.equal(receipt.deleted.interaction_signals, 1);
  assert.equal(receipt.deleted.key_providers, 1);

  // Nothing of hers survives.
  assert.equal(await store.getUser(doomed.id), null);
  assert.equal(await store.verifyLogin('erase_me', doomedPw), null);
  assert.equal(await store.getSessionUser(s1.token), null);
  assert.equal(await store.adminGetCourse(c1.id), null);
  assert.equal(await store.adminGetCourse(c2.id), null);
  assert.deepEqual(await store.getUserKeys(doomed.id), {});
  assert.deepEqual(await store.listMaterials(doomed.id), []);
  assert.ok(!readFile(at('facts.json')).some((r) => r.id === 'f1'));
  assert.ok(!readFile(at('classes.json')).some((r) => r.id === 'cl1'));

  // The strong form: no row anywhere in the store still names her.
  const offenders = allStoreFiles()
    .filter((f) => readFileSync(f, 'utf8').includes(doomed.id))
    .map((f) => path.relative(base, f));
  assert.deepEqual(offenders, [], 'no file in the store references the erased user');
  assert.ok(!allStoreFiles().some((f) => readFileSync(f, 'utf8').includes(mat.cos_key)),
    'and no dangling object key is left behind either');

  // Operational history survives the person.
  const scope = await store.listScope({ limit: 50 });
  const hers = scope.rows.find((r) => r.excerpt === '明天下雨吗');
  assert.ok(hers, 'the scope-log row is KEPT — the ops signal is not hers to take away');
  assert.equal(hers.user_id, null, 'with the subject dropped');
  assert.equal(scope.rows.find((r) => r.excerpt === '股票怎么样').user_id, keeper.id,
    'and the other teacher stays attributed');

  const audit = await store.listAudit({ limit: 50 });
  const reset = audit.find((r) => r.action === 'reset_password' && r.admin_id === admin.id);
  assert.ok(reset, 'the admin action stays visible');
  assert.equal(reset.target_user, null, 'its subject does not');
  const eraseRow = audit.find((r) => r.action === 'erase_user');
  assert.equal(eraseRow.target_user, null, 'the erase row names no one — recording her here would defeat it');
  assert.equal(eraseRow.detail.courses, 2, 'counts are what an operator needs');
  assert.equal(eraseRow.detail.objects, 2);

  // The neighbour is untouched, top to bottom.
  assert.ok(await store.getUser(keeper.id));
  assert.ok(await store.adminGetCourse(keeperCourse.id));
  assert.equal((await store.getUserKeys(keeper.id)).glm, 'cipher-keeper');
  assert.equal((await store.listMaterials(keeper.id)).length, 1);
  assert.ok(readFile(at('facts.json')).some((r) => r.id === 'f2'));
  assert.ok(readFile(at('classes.json')).some((r) => r.id === 'cl2'));
  assert.ok(readFile(at('interaction-signals.json')).some((r) => r.id === 2));

  await assert.rejects(store.eraseUser(admin.id, doomed.id), /用户不存在/, 'a second erase 404s');
});

test('erase aborts when an object cannot be deleted: every row survives', async () => {
  const { user: admin } = await store.createUser({ username: 'admin_ab', displayName: '管理员丁', role: 'admin' });
  const { user: u, temp_password } = await store.createUser({ username: 'bucket_down', displayName: '桶挂了老师' });
  const course = await store.createCourse(u.id, '半途而废');
  await store.recordMaterial(u.id, course.id, {
    kind: 'photo', mime_type: 'image/png', cos_key: 'courses/bd/xxx.png', size_bytes: 500,
  });

  await assert.rejects(
    store.eraseUser(admin.id, u.id, { deleteObject: () => { throw new Error('COS 503'); } }),
    /COS 503/,
  );

  // A half-run erase can be repeated; an orphaned object cannot be found again.
  assert.ok(await store.getUser(u.id), 'user row intact');
  assert.ok(await store.verifyLogin('bucket_down', temp_password), 'login still works');
  assert.ok(await store.adminGetCourse(course.id), 'course intact');
  assert.equal((await store.listMaterials(u.id)).length, 1, 'material row intact — the key is not lost');

  // And with a working deleter the same account erases cleanly.
  const receipt = await store.eraseUser(admin.id, u.id, { deleteObject: () => {} });
  assert.deepEqual(receipt.cos_keys, ['courses/bd/xxx.png']);
  assert.equal(await store.getUser(u.id), null);
});

test('erase without a deleter hands the keys back: the caller owns the bucket', async () => {
  const { user: u } = await store.createUser({ username: 'no_deleter', displayName: '无删除器老师' });
  const course = await store.createCourse(u.id, '待删');
  await store.recordMaterial(u.id, course.id, {
    kind: 'observation', mime_type: 'image/jpeg', cos_key: 'courses/nd/yyy.jpg', size_bytes: 900,
  });

  const receipt = await store.eraseUser(null, u.id);
  assert.deepEqual(receipt.cos_keys, ['courses/nd/yyy.jpg'], 'the keys ride back so they can still be deleted');
  assert.equal(receipt.objects_deleted, false, 'and the receipt says plainly that they were not');
  assert.equal(await store.getUser(u.id), null);
});

test('recordMaterial rejects by default: kind, MIME and key allowlists', async () => {
  const { user: u } = await store.createUser({ username: 'uploader_x', displayName: '上传老师' });
  const course = await store.createCourse(u.id, '素材课');
  const ok = { kind: 'photo', mime_type: 'image/jpeg', cos_key: 'courses/ux/ok.jpg', size_bytes: 10 };

  const row = await store.recordMaterial(u.id, course.id, ok);
  assert.equal(row.cos_key, 'courses/ux/ok.jpg');
  assert.equal(row.contains_children, false, 'absent flag reads false, never undefined');

  await assert.rejects(store.recordMaterial(u.id, course.id, { ...ok, kind: 'video' }), /素材类型/);
  await assert.rejects(store.recordMaterial(u.id, course.id, { ...ok, mime_type: 'image/heic' }), /文件类型/);
  await assert.rejects(store.recordMaterial(u.id, course.id, { ...ok, cos_key: '  ' }), /对象键/);
  assert.equal((await store.listMaterials(u.id)).length, 1, 'nothing rejected was recorded');
});

// ---------------------------------------------------------------- window

test('isDueForErasure is pure and answers both directions', () => {
  const revokedAt = '2026-01-01T00:00:00.000Z';
  const t0 = Date.parse(revokedAt);
  const revoked = { status: 'revoked', revoked_at: revokedAt };

  assert.equal(isDueForErasure(revoked, t0 + 364 * DAY), false, 'inside the default window');
  assert.equal(isDueForErasure(revoked, t0 + 366 * DAY), true, 'past it');
  assert.equal(DEFAULT_ERASURE_WINDOW_DAYS, 365);
  assert.equal(isDueForErasure(revoked, t0 + 31 * DAY, 30), true, 'the window is an argument');
  assert.equal(isDueForErasure(revoked, t0 + 29 * DAY, 30), false);
  assert.equal(isDueForErasure({ status: 'active', revoked_at: revokedAt }, t0 + 10 * 365 * DAY), false,
    'an active account is never due, whatever stamp it carries');
  assert.equal(isDueForErasure({ status: 'revoked', revoked_at: null }, t0 + 10 * 365 * DAY), false,
    'no stamp means no clock — guessing a date would erase early, and erasure is irreversible');
  assert.equal(isDueForErasure(null, t0), false);
  assert.throws(() => isDueForErasure(revoked, 'not-a-time'), /now must be/);
});

test('dueForErasure: past the window is returned, inside it is not, and nothing is erased', async () => {
  const { user: admin } = await store.createUser({ username: 'admin_win', displayName: '管理员戊', role: 'admin' });
  const { user: old } = await store.createUser({ username: 'old_leaver', displayName: '早走的老师' });
  const { user: recent } = await store.createUser({ username: 'new_leaver', displayName: '刚走的老师' });
  const { user: working } = await store.createUser({ username: 'still_teaching', displayName: '还在教的老师' });
  const course = await store.createCourse(old.id, '去年的课');

  await store.revokeUser(admin.id, old.id);
  await store.revokeUser(admin.id, recent.id);
  const t = Date.now();

  // Both were revoked now, so the clock is moved by asking about a later time.
  const inside = await store.dueForErasure(t + 300 * DAY);
  assert.ok(!inside.includes(old.id), 'inside the window nothing is due');
  assert.ok(!inside.includes(recent.id));

  const past = await store.dueForErasure(t + 366 * DAY);
  assert.ok(past.includes(old.id), 'past the window the revoked account is returned');
  assert.ok(!past.includes(working.id), 'and an active account never is');

  // Configuration, not a constant.
  assert.ok((await store.dueForErasure(t + 31 * DAY, 30)).includes(recent.id));
  assert.ok(!(await store.dueForErasure(t + 29 * DAY, 30)).includes(recent.id));

  // It reports; it does not act. The caller decides, because erasure is
  // irreversible and a job that both finds and deletes has no step where a
  // human can look.
  assert.ok(await store.getUser(old.id), 'the account is still there after the call');
  assert.ok(await store.adminGetCourse(course.id), 'and so is her course');

  await assert.rejects(store.dueForErasure(t, Number.NaN), /保留期/,
    'a NaN window would silently return nothing due — a retention job that stops without saying so');
  await assert.rejects(store.dueForErasure(t, -1), /保留期/);
});

test('dueForErasure skips a revoked row whose clock never started', async () => {
  const { user: u } = await store.createUser({ username: 'no_stamp_t', displayName: '没盖章老师' });
  // A hand-edited or half-migrated row: revoked, but never stamped.
  const users = readFile(at('auth', 'users.json'));
  users.find((x) => x.id === u.id).status = 'revoked';
  writeSeed(at('auth', 'users.json'), users);

  assert.ok(!(await store.dueForErasure(Date.now() + 10 * 365 * DAY)).includes(u.id),
    'never due, because we do not know when the window opened');
  const listed = (await store.listUsers()).find((x) => x.id === u.id);
  assert.equal(listed.status, 'revoked');
  assert.equal(listed.revoked_at, null, 'and it stays visible as revoked-without-a-date rather than silently fine');
});

test('the sweep list is the contract for whoever builds these collections', () => {
  assert.deepEqual([...USER_SCOPED_FILES].sort(),
    ['classes.json', 'facts.json', 'interaction-signals.json', 'materials.json']);
});
