// memory-routes.test.mjs — the teacher plane for memory and classes, at the
// HTTP boundary.
//
// serve.mjs names this file in the comment above those routes, as the thing
// that pins 「there is no create route for a fact, and there must never be one」.
// The comment was there before the file was, which is the same defect it warns
// about: a rule nobody executes.
//
// What is proved here and nowhere else:
//   · a fact CANNOT be created through the API — memory comes from what she
//     said, never from a form (non-negotiable #2). A `POST /api/memory` would
//     skip the taxonomy, the citation floors, the child-claim belt and the scope
//     clamp in one call;
//   · a foreign id and a missing id answer the SAME 404 with the same body, so
//     the route is not an oracle for what another teacher remembers;
//   · the archive reason is ENGINE-SET: 「老师说不用记了」 must not be able to wear
//     「这是关于孩子的断言」's explanation, or 「为什么它不记得了」 has no true answer;
//   · widening checks that the class is HERS before it moves anything, because
//     foreign keys bypass row-level security and no policy checks that column;
//   · the admin export carries the classes those facts point at.
//
// Hermetic: scratch DEMO_DATA_DIR, scratch port, no keys, no provider calls.
// Facts are seeded through the same store the server reads, because there is
// deliberately no endpoint that writes one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createJsonStore } from '../src/store/json-store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(HERE, '..');
const ADMIN_TOKEN = 'memory-routes-token';

/** One server, one scratch data dir, plus the store the server reads. */
async function startServer(t, port) {
  const dataDir = await mkdtemp(path.join(tmpdir(), `cst-memroutes-${port}-`));
  const child = spawn(process.execPath, [path.join(DEMO, 'serve.mjs'), '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, DEMO_DATA_DIR: dataDir, DATABASE_URL: '', ADMIN_TOKEN,
      MINIMAX_API_KEY: '', GLM_API_KEY: '', ZAI_API_KEY: '', KIMI_API_KEY: '',
    },
  });
  t.after(async () => { child.kill(); await rm(dataDir, { recursive: true, force: true }); });
  const started = new Promise((resolve) => {
    child.stdout.on('data', (b) => { if (String(b).includes(String(port))) resolve(); });
  });
  await Promise.race([started, once(child, 'exit').then(() => { throw new Error('server exited'); })]);

  const base = `http://127.0.0.1:${port}`;
  const call = async (pathname, { method = 'GET', body, cookie, headers = {} } = {}) => {
    const res = await fetch(base + pathname, {
      method,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON stays in text */ }
    return { status: res.status, json, text, setCookie: res.headers.getSetCookie?.() ?? [] };
  };
  const admin = (pathname, opts = {}) => call(pathname, {
    ...opts, headers: { ...(opts.headers ?? {}), 'x-admin-token': ADMIN_TOKEN },
  });
  const teacher = async (username) => {
    const created = await admin('/api/admin/users', { method: 'POST', body: { username } });
    assert.equal(created.status, 200, created.text);
    const login = await call('/api/auth/login', {
      method: 'POST', body: { username, password: created.json.temp_password },
    });
    const cookie = login.setCookie.find((c) => c.startsWith('cst_sid=')).split(';')[0];
    return { id: created.json.user.id, cookie };
  };
  return { call, admin, teacher, store: createJsonStore({ baseDir: dataDir }) };
}

const seedFact = (store, userId, courseId, over = {}) => store.recordFact(userId, {
  scope: 'course', course_id: courseId, kind: 'equipment',
  body: '班上没有鼓', quote: '我们班没有鼓', source: 'extracted', ...over,
});

test('the memory page reads; nothing on it can bring a fact into being', async (t) => {
  const s = await startServer(t, 8961);
  const a = await s.teacher('mem_routes_a');
  const b = await s.teacher('mem_routes_b');
  const courseA = (await s.call('/api/courses', { method: 'POST', body: { title: '醒狮' }, cookie: a.cookie })).json.course;
  const courseB = (await s.call('/api/courses', { method: 'POST', body: { title: '龙舟' }, cookie: b.cookie })).json.course;
  const mine = await seedFact(s.store, a.id, courseA.id);
  const hers = await seedFact(s.store, b.id, courseB.id, { body: '她班上没有鼓' });

  // No session, no memory. It is teacher content.
  assert.equal((await s.call(`/api/memory?course_id=${courseA.id}`)).status, 401);

  const read = await s.call(`/api/memory?course_id=${courseA.id}`, { cookie: a.cookie });
  assert.equal(read.status, 200);
  assert.deepEqual(read.json.facts.map((f) => f.id), [mine.id]);
  assert.deepEqual(read.json.classes, [], '还没有班级就是空数组，不是缺字段');
  // The other teacher's fact is not in her page even though it exists.
  assert.equal(read.json.facts.some((f) => f.id === hers.id), false);

  // THE ABSENCE THAT MATTERS. A create route would skip the closed taxonomy,
  // the citation floors, the child-claim belt and the scope clamp in one call,
  // and it would turn the memory page into a form.
  for (const [method, pathname] of [
    ['POST', '/api/memory'],
    ['PUT', '/api/memory'],
    ['POST', `/api/memory/${mine.id}`],
  ]) {
    const r = await s.call(pathname, {
      method, cookie: a.cookie, body: { kind: 'equipment', text: '我编的', quote: '我编的' },
    });
    assert.equal(r.status, 405, `${method} ${pathname} 必须没有这条路`);
  }
  assert.deepEqual(
    (await s.call(`/api/memory?course_id=${courseA.id}`, { cookie: a.cookie })).json.facts.map((f) => f.id),
    [mine.id],
    '试着写进去的那条一行都没有落库',
  );
});

test('忘掉: the reason is set by the engine, and a foreign id answers exactly like a missing one', async (t) => {
  const s = await startServer(t, 8962);
  const a = await s.teacher('mem_arch_a');
  const b = await s.teacher('mem_arch_b');
  const courseA = (await s.call('/api/courses', { method: 'POST', body: { title: '醒狮' }, cookie: a.cookie })).json.course;
  const courseB = (await s.call('/api/courses', { method: 'POST', body: { title: '龙舟' }, cookie: b.cookie })).json.course;
  const mine = await seedFact(s.store, a.id, courseA.id);
  const hers = await seedFact(s.store, b.id, courseB.id);

  // A body-supplied reason would let one event wear another's explanation:
  // 「老师说不用记了」 and 「这句讲的是孩子已经做到的事」 are different answers to
  // 「为什么它不记得了」 and she is owed the true one.
  const done = await s.call(`/api/memory/${mine.id}/archive`, {
    method: 'POST', cookie: a.cookie, body: { reason: 'child_claim' },
  });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.fact.archive_reason, 'teacher_removed', '原因由引擎写，不听请求的');
  assert.equal(done.json.fact.archived, true);

  // Archiving is not deleting: gone from the prompt, still on the page.
  const live = await s.call(`/api/memory?course_id=${courseA.id}`, { cookie: a.cookie });
  assert.deepEqual(live.json.facts.map((f) => f.id), [], '归档的不再默认读出来');
  const withArchived = await s.call(`/api/memory?course_id=${courseA.id}&include_archived=1`, { cookie: a.cookie });
  assert.deepEqual(withArchived.json.facts.map((f) => f.id), [mine.id], '已归档区看得到，连原因一起');
  assert.equal(withArchived.json.facts[0].archive_reason, 'teacher_removed');

  // 「不是你的」 and 「不存在」 must be indistinguishable, or the route reports on
  // what another teacher remembers.
  const foreign = await s.call(`/api/memory/${hers.id}/archive`, { method: 'POST', cookie: a.cookie });
  const missing = await s.call('/api/memory/00000000-0000-4000-8000-000000000000/archive', { method: 'POST', cookie: a.cookie });
  assert.equal(foreign.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual(foreign.json, missing.json, '两种情况必须是同一个回答');
  // And the other teacher's row is untouched.
  const stillHers = await s.store.listFacts(b.id, { courseId: courseB.id });
  assert.deepEqual(stillHers.map((f) => f.id), [hers.id]);
});

test('扩大范围: one rung, and only into a class that is hers', async (t) => {
  const s = await startServer(t, 8963);
  const a = await s.teacher('mem_widen_a');
  const b = await s.teacher('mem_widen_b');
  const courseA = (await s.call('/api/courses', { method: 'POST', body: { title: '醒狮' }, cookie: a.cookie })).json.course;
  const fact = await seedFact(s.store, a.id, courseA.id);

  const hers = (await s.call('/api/classes', {
    method: 'POST', cookie: b.cookie, body: { name: '别人的班' },
  })).json.class;
  const mine = (await s.call('/api/classes', {
    method: 'POST', cookie: a.cookie, body: { name: '中三班', age_band: '中班', class_size: 30 },
  })).json.class;
  assert.ok(mine.id && hers.id);
  assert.deepEqual((await s.call('/api/classes', { cookie: a.cookie })).json.classes.map((k) => k.name), ['中三班']);

  // A class that is not hers. No policy checks this column — foreign keys
  // bypass row-level security — so binding a stranger's class would pull HER
  // class memory into another teacher's course, on every turn, forever.
  const stolen = await s.call(`/api/memory/${fact.id}/widen`, {
    method: 'POST', cookie: a.cookie, body: { to_scope: 'class', class_id: hers.id },
  });
  assert.equal(stolen.status, 404);
  assert.match(stolen.json.message, /班级/);

  // Skipping a rung: 「这对我带的每个班都成立」 is a much bigger claim than
  // 「这个班就是这样」, and one tap must not assert both.
  const skipped = await s.call(`/api/memory/${fact.id}/widen`, {
    method: 'POST', cookie: a.cookie, body: { to_scope: 'teacher' },
  });
  assert.equal(skipped.status, 400);

  // Neither refusal moved anything.
  assert.equal((await s.store.listFacts(a.id, { courseId: courseA.id }))[0].scope, 'course');

  // MUST PASS: her own class, one rung. Provenance is engine-set — the body
  // says WHERE TO and nothing else.
  const ok = await s.call(`/api/memory/${fact.id}/widen`, {
    method: 'POST', cookie: a.cookie, body: { to_scope: 'class', class_id: mine.id, source: 'auto' },
  });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.fact.scope, 'class');
  assert.equal(ok.json.fact.class_id, mine.id);
  assert.equal(ok.json.fact.source, 'teacher', '她点的，就记成她说的');
  assert.equal(ok.json.fact.widened_from, 'course');

  // And a course bound to that class now reads the widened fact.
  const bound = await s.call(`/api/courses/${courseA.id}/class`, {
    method: 'PUT', cookie: a.cookie, body: { class_id: mine.id },
  });
  assert.equal(bound.status, 200, bound.text);
  const seen = await s.call(`/api/memory?course_id=${courseA.id}`, { cookie: a.cookie });
  assert.deepEqual(seen.json.facts.map((f) => f.scope), ['class'], '绑了班，班级记忆才读得到');

  // Binding a course to a stranger's class is refused at the route as well.
  const badBind = await s.call(`/api/courses/${courseA.id}/class`, {
    method: 'PUT', cookie: a.cookie, body: { class_id: hers.id },
  });
  assert.equal(badBind.status, 404);
});

test('moving a handle leaves a row saying which one moved, and how far', async (t) => {
  const s = await startServer(t, 8965);
  const a = await s.teacher('axes_signal_a');
  const b = await s.teacher('axes_signal_b');

  // Nothing has been observed yet, and that reads as an empty list rather than
  // as a missing feature.
  const empty = await s.call('/api/signals', { cookie: a.cookie });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json.signals, []);
  assert.equal((await s.call('/api/signals')).status, 401, '这是关于她的观察，不给没登录的人看');

  const vector = (depth, pinned) => ({
    version: 'v1',
    flavor: '',
    axes: { depth: { value: depth, confidence: 1, source: 'explicit', pinned } },
  });
  // The save that carries no vector at all — a legacy client patching only
  // 回应风格 — must not read as six axes snapping to their defaults.
  assert.equal((await s.call('/api/me', {
    method: 'PATCH', cookie: a.cookie, body: { profile: { stylePref: '蓝图共创（先给完整方案再一起改）' } },
  })).status, 200);
  assert.deepEqual((await s.call('/api/signals', { cookie: a.cookie })).json.signals, [],
    '没动把手就没有观察');

  assert.equal((await s.call('/api/me', {
    method: 'PATCH', cookie: a.cookie, body: { profile: { interaction_vector: vector(5, true) } },
  })).status, 200);
  const moved = await s.call('/api/signals', { cookie: a.cookie });
  assert.equal(moved.json.signals.length, 1, '一根把手动了就一行');
  assert.equal(moved.json.signals[0].axis, 'depth');
  assert.ok(moved.json.signals[0].delta > 0, '往哪个方向动的要看得出来');
  assert.equal(moved.json.signals[0].user_id, a.id);

  // Saving the same vector again is a save, not an observation.
  await s.call('/api/me', {
    method: 'PATCH', cookie: a.cookie, body: { profile: { interaction_vector: vector(5, true) } },
  });
  assert.equal((await s.call('/api/signals', { cookie: a.cookie })).json.signals.length, 1);

  // Scoped: another teacher's observations are not hers to read.
  assert.deepEqual((await s.call('/api/signals', { cookie: b.cookie })).json.signals, []);
  // And there is no way to post one: the rows are what the agent observed, not
  // what a client says it observed.
  assert.equal((await s.call('/api/signals', {
    method: 'POST', cookie: a.cookie, body: { axis: 'depth', signal: 'x', delta: 1 },
  })).status, 405);

  // The export duty: state this instance holds rides the export.
  const payload = JSON.parse((await s.admin('/api/admin/export')).text);
  assert.ok(Array.isArray(payload.interaction_signals));
  assert.equal(payload.interaction_signals.some((r) => r.user_id === a.id && r.axis === 'depth'), true);
});

test('the admin export carries the classes its facts and courses point at', async (t) => {
  const s = await startServer(t, 8964);
  const a = await s.teacher('mem_export_a');
  const course = (await s.call('/api/courses', { method: 'POST', body: { title: '醒狮' }, cookie: a.cookie })).json.course;
  const klass = (await s.call('/api/classes', {
    method: 'POST', cookie: a.cookie, body: { name: '中三班', age_band: '中班', class_size: 30 },
  })).json.class;
  await s.call(`/api/courses/${course.id}/class`, { method: 'PUT', cookie: a.cookie, body: { class_id: klass.id } });
  const fact = await seedFact(s.store, a.id, course.id);
  await s.call(`/api/memory/${fact.id}/widen`, {
    method: 'POST', cookie: a.cookie, body: { to_scope: 'class', class_id: klass.id },
  });

  const exported = await s.admin('/api/admin/export');
  assert.equal(exported.status, 200);
  const payload = JSON.parse(exported.text);
  // The failure this covers: `facts.class_id` ships, `courses.class_id` ships,
  // and without the class rows both are uuids that resolve to nothing in the
  // file — the audit can see a constraint belongs to some class and never say
  // which.
  assert.ok(Array.isArray(payload.classes), '导出里要有 classes');
  const byId = new Map(payload.classes.map((k) => [k.id, k]));
  assert.equal(byId.get(klass.id)?.name, '中三班');
  assert.equal(byId.get(klass.id)?.user_id, a.id, '谁的班也要写清楚');
  const exportedFact = payload.facts.find((f) => f.id === fact.id);
  assert.equal(exportedFact.class_id, klass.id);
  assert.ok(byId.has(exportedFact.class_id), '记忆指向的班级在同一个文件里查得到');

  // The console can resolve the same uuid, and the cross-teacher read is logged.
  const listed = await s.admin('/api/admin/classes');
  assert.equal(listed.status, 200);
  assert.equal(listed.json.classes.find((k) => k.id === klass.id)?.name, '中三班');
  const log = await s.admin('/api/admin/access-log');
  assert.equal(log.status, 200, log.text);
  assert.ok(
    (log.json.rows ?? []).some((r) => r.action === 'read_classes'),
    '跨老师读班级也要留下一行日志',
  );
});
