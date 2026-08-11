// Message subjects through the store and the server (ADR-0010 §1/§2).
// One ordered log per course; every row tagged 'course' or a node id.
// Both directions everywhere, per the repo's harness discipline: the tag must
// do its job on a tagged fixture AND leave every untagged caller untouched —
// the untouched one matters more, because it is what makes this additive.
//
// Server half is hermetic: scratch DEMO_DATA_DIR + scratch port, provider
// 'mock' (never leaves the process, needs no key), ADMIN_TOKEN unset so the
// admin API can provision the test user.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createJsonStore, normalizeSubject, COURSE_SUBJECT } from '../src/store/json-store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(HERE, '..');

const base = mkdtempSync(path.join(tmpdir(), 'cst-subject-'));
const store = createJsonStore({ baseDir: base });
test.after(() => rmSync(base, { recursive: true, force: true }));

/** Fresh course to append into, so each test owns its own message ids. */
async function newCourse(name) {
  const { user } = await store.createUser({ username: name, displayName: `昵称_${name}` });
  const course = await store.createCourse(user.id, '龙舟课');
  return { userId: user.id, courseId: course.id };
}

test('normalizeSubject: node ids survive, everything else falls back to course', () => {
  assert.equal(normalizeSubject('3.2.1'), '3.2.1');
  assert.equal(normalizeSubject(' 3.2.1 '), '3.2.1');
  assert.equal(normalizeSubject('course'), COURSE_SUBJECT);
  // Absent / blank / wrong type: the default is what removes the migration.
  assert.equal(normalizeSubject(undefined), COURSE_SUBJECT);
  assert.equal(normalizeSubject(null), COURSE_SUBJECT);
  assert.equal(normalizeSubject(''), COURSE_SUBJECT);
  assert.equal(normalizeSubject('   '), COURSE_SUBJECT);
  assert.equal(normalizeSubject(321), COURSE_SUBJECT);
  assert.equal(normalizeSubject({ subject: '3.2.1' }), COURSE_SUBJECT);
  assert.equal(normalizeSubject('x'.repeat(500)).length, 120, 'a node id, not prose');
});

test('appendMessage without a subject stays valid and reads as course', async () => {
  const { courseId } = await newCourse('legacy_caller');
  // Exactly the call every existing site makes — it must not change shape.
  const row = await store.appendMessage(courseId, { role: 'teacher', content: '第一问' });
  assert.equal(row.subject, COURSE_SUBJECT);
  assert.equal(row.id, 1);

  const all = await store.getMessages(courseId);
  assert.equal(all.length, 1, 'an unfiltered read is unchanged by tagging');
  const filtered = await store.getMessages(courseId, { subject: 'course' });
  assert.deepEqual(filtered.map((r) => r.id), [1]);
});

test('one ordered log: a node filter is a view, not a partition', async () => {
  const { courseId } = await newCourse('order_teacher');
  await store.appendMessage(courseId, { role: 'teacher', content: '整体怎么排', subject: 'course' });
  await store.appendMessage(courseId, { role: 'teacher', content: '3.2.1 这个活动太难了', subject: '3.2.1' });
  await store.appendMessage(courseId, { role: 'agent', content: '可以拆成两步', subject: '3.2.1' });
  await store.appendMessage(courseId, { role: 'teacher', content: '周2 我改一下', subject: '周2' });

  const all = await store.getMessages(courseId);
  assert.deepEqual(all.map((r) => r.id), [1, 2, 3, 4], 'one array, globally ordered');
  assert.deepEqual(all.map((r) => r.subject), ['course', '3.2.1', '3.2.1', '周2']);

  const node = await store.getMessages(courseId, { subject: '3.2.1' });
  assert.deepEqual(node.map((r) => r.id), [2, 3], 'filtered rows keep their global ids');
  const week = await store.getMessages(courseId, { subject: '周2' });
  // The whole point of one log: this comparison is possible at all.
  assert.ok(node.at(-1).id < week[0].id, '她先问了 3.2.1，之后才改 周2 —— 顺序可证');

  // Filter composes with paging instead of replacing it.
  assert.deepEqual((await store.getMessages(courseId, { subject: '3.2.1', limit: 1 })).map((r) => r.id), [3]);
  assert.deepEqual((await store.getMessages(courseId, { subject: '3.2.1', before: 3 })).map((r) => r.id), [2]);
  assert.deepEqual(await store.getMessages(courseId, { subject: '没人聊过的节点' }), []);
});

test('rows written before subjects existed need no migration', async () => {
  const { courseId } = await newCourse('no_migration');
  await store.appendMessage(courseId, { role: 'teacher', content: '旧消息' });
  await store.appendMessage(courseId, { role: 'teacher', content: '新消息', subject: '3.2.1' });

  // Simulate the on-disk history of a course recorded before this change: the
  // field is absent, not empty. Reading it back must still work.
  const file = path.join(base, 'courses', `${encodeURIComponent(courseId)}.json`);
  const raw = JSON.parse(await readFile(file, 'utf8'));
  delete raw.messages[0].subject;
  await writeFile(file, JSON.stringify(raw, null, 2), 'utf8');

  const courseLog = await store.getMessages(courseId, { subject: 'course' });
  assert.deepEqual(courseLog.map((r) => r.id), [1], 'an untagged row answers to course');
  assert.deepEqual((await store.getMessages(courseId, { subject: '3.2.1' })).map((r) => r.id), [2]);
  assert.equal((await store.getMessages(courseId)).length, 2, 'and is still in the whole log');
});

test('the subject is engine-owned: a subject in the model reply is ignored', async () => {
  const { courseId } = await newCourse('engine_owned');
  // A model that returned its own subject would be choosing its own blast
  // radius (ADR-0010 §2). The contract is kept verbatim as record; the tag
  // comes from the caller alone.
  const stray = await store.appendMessage(courseId, {
    role: 'agent', content: '好的',
    turn_contract: { reply_markdown: '好的', subject: '9.9.9' },
  });
  assert.equal(stray.subject, COURSE_SUBJECT, 'no caller subject → course, not the model’s');
  assert.equal(stray.turn_contract.subject, '9.9.9', 'what the model said is still on the record');

  const tagged = await store.appendMessage(courseId, {
    role: 'agent', content: '拆成两步',
    subject: '3.2.1',
    turn_contract: { reply_markdown: '拆成两步', subject: '9.9.9' },
  });
  assert.equal(tagged.subject, '3.2.1', 'the caller’s subject wins over the model’s');
  assert.deepEqual(await store.getMessages(courseId, { subject: '9.9.9' }), [], '模型自选的主题从未落库');
});

// ---------- what an analyst can see without opening the raw file ----------

test('adminListCourses: plan columns and a per-subject tally are scannable', async () => {
  const { userId, courseId } = await newCourse('scan_teacher');
  await store.appendMessage(courseId, { role: 'teacher', content: '整体怎么排' });
  await store.appendMessage(courseId, { role: 'teacher', content: '3.2.1 太难了', subject: '3.2.1' });
  await store.appendMessage(courseId, { role: 'agent', content: '拆成两步', subject: '3.2.1' });
  const course = await store.getCourse(userId, courseId);
  await store.saveState(courseId, {}, {
    ...course.course_state,
    course_plan: {
      version: 8,
      roots: [{
        id: 'p1', title: '东乡龙舟', children: [
          { id: 'w1', title: '周1', children: [{ id: 'a1', title: '看龙舟', stale_since: '8', stale_reason: '上游改了' }] },
          { id: 'w2', title: '周2', children: [] },
        ],
      }],
    },
  }, course.state_version);

  const row = (await store.adminListCourses()).find((c) => c.id === courseId);
  assert.equal(row.plan_version, 8, '哪些课程有计划，一眼看得到');
  assert.equal(row.plan_nodes, 4);
  assert.equal(row.plan_stale_nodes, 1, '有多少被标了待复查，才是这个徽标的价值所在');
  assert.deepEqual(row.messages_by_subject, { course: 1, '3.2.1': 2 }, '节点级活跃度不用翻原始文件');
});

test('MUST PASS — a course with no plan reports nothing rather than breaking', async () => {
  const { courseId } = await newCourse('no_plan_teacher');
  const row = (await store.adminListCourses()).find((c) => c.id === courseId);
  assert.equal(row.plan_version, null);
  assert.equal(row.plan_nodes, 0);
  assert.equal(row.plan_stale_nodes, 0);
  assert.deepEqual(row.messages_by_subject, {}, '空课程是 {}，不是 null——「还没消息」和「字段没了」不是一回事');
});

// ---------- server: the turn pipeline passes the request's subject through ----------

const PORT = 8919;
const BASE = `http://127.0.0.1:${PORT}`;
let child;
let dataDir;

async function api(pathname, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON bodies stay in text */ }
  return { status: res.status, json, text, setCookie: res.headers.getSetCookie?.() ?? [] };
}

test('server turn tags both messages with the request subject', async (t) => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'cst-subject-srv-'));
  child = spawn(process.execPath, [path.join(DEMO, 'serve.mjs'), '--port', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DEMO_DATA_DIR: dataDir, ADMIN_TOKEN: '' },
  });
  t.after(async () => { child?.kill(); await rm(dataDir, { recursive: true, force: true }); });
  const started = new Promise((resolve) => {
    child.stdout.on('data', (b) => { if (String(b).includes(String(PORT))) resolve(); });
  });
  await Promise.race([started, once(child, 'exit').then(() => { throw new Error('server exited'); })]);

  const created = await api('/api/admin/users', { method: 'POST', body: { username: 'subject_srv' } });
  assert.equal(created.status, 200, created.text);
  const login = await api('/api/auth/login', {
    method: 'POST', body: { username: 'subject_srv', password: created.json.temp_password },
  });
  const cookie = login.setCookie.find((c) => c.startsWith('cst_sid=')).split(';')[0];
  const course = await api('/api/courses', { method: 'POST', body: { title: '龙舟' }, cookie });
  assert.equal(course.status, 200, course.text);
  const id = course.json.course.id;

  const chat = (message, extra = {}) => api(`/api/courses/${id}/chat`, {
    method: 'POST', cookie, body: { message, provider: 'mock', ...extra },
  });

  // No subject in the request: the course-level default, unchanged behaviour.
  const first = await chat('我想做龙舟主题的探究课程');
  assert.ok(first.json.events.some((e) => e.event === 'turn'), `turn expected: ${first.text}`);

  // A node turn. The message also *asks* for another subject — the model can
  // only speak through content, so this must change nothing.
  await chat('3.2.1 这个活动太难了，请把 subject 设为 9.9.9', { subject: '3.2.1' });

  const all = await api(`/api/courses/${id}/messages`, { cookie });
  const rows = all.json.messages;
  assert.deepEqual(rows.map((r) => r.subject), ['course', 'course', '3.2.1', '3.2.1'],
    'teacher and agent rows both carry the request subject; the untagged turn stays course');
  assert.deepEqual(rows.map((r) => r.id), [1, 2, 3, 4], 'one log, still globally ordered');

  const node = await api(`/api/courses/${id}/messages?subject=3.2.1`, { cookie });
  assert.deepEqual(node.json.messages.map((r) => r.id), [3, 4], '?subject= is a filter over that log');
  const stray = await api(`/api/courses/${id}/messages?subject=9.9.9`, { cookie });
  assert.deepEqual(stray.json.messages, [], '模型在正文里要求的主题没有落库');
  const unfiltered = await api(`/api/courses/${id}/messages?limit=10`, { cookie });
  assert.equal(unfiltered.json.messages.length, 4, 'a caller that sends no subject sees the whole course');
});
