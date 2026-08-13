// The fact WRITE path, end to end: a mock turn → the real capture → a real store.
//
// Everything under memory had unit tests and no walkthrough. captureMemoryFacts
// was proven against a store, and mock.mjs emitted no `memory_facts` at all — so
// nothing exercised the join between them, and a key-less demo never wrote a
// fact. That gap is precisely where a guard rots: each half passes its own
// tests while the seam between them is dead.
//
// These tests use the JSON store rather than a fake. A fake would agree with
// whatever capture does, including the taxonomy CHECK that is a SAFETY control
// on the real tier (demo/migrations/001_schema.sql), and agreeing is the one
// thing a fake must not do here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { mockTurn } from '../src/mock.mjs';
import { createInitialState } from '../src/engine.mjs';
import { captureMemoryFacts, rawMemoryFacts } from '../src/memory-capture.mjs';
import { createJsonStore } from '../src/store/json-store.mjs';

/** A store on a scratch directory, torn down with the test. */
async function fixture(t) {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'mock-mem-'));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const store = createJsonStore({ baseDir });
  const { user } = await store.createUser({ username: `mem_${Math.random().toString(36).slice(2, 8)}` });
  const course = await store.createCourse(user.id, '醒狮');
  return { store, user, course };
}

/**
 * Drive one mock turn exactly the way serve.mjs does.
 *
 * NOTE the payload, not a parsed turn: `parseTurn` builds a whitelisted object
 * and `memory_facts` is deliberately not on it, so serve.mjs reads the field off
 * the RAW payload via rawMemoryFacts (serve.mjs:619). A test that read it from
 * the parsed turn would find undefined and prove nothing — which is how it
 * failed the first time this file ran.
 */
async function runTurn(f, message, state = createInitialState('mem-e2e')) {
  const payload = mockTurn(state, [], message);
  const candidates = rawMemoryFacts(payload);
  const captured = await captureMemoryFacts(f.store, {
    userId: f.user.id,
    courseId: f.course.id,
    teacherText: message,
    candidates,
    facts: await f.store.listFacts(f.user.id, { courseId: f.course.id }),
  });
  return { turn: { memory_facts: candidates }, captured };
}

// A state past WF01 so the mock runs a flow rather than entry recognition; the
// constraint sentence is what matters, not which branch reads it.
const started = () => {
  const s = createInitialState('mem-e2e');
  s.completed_nodes = ['WF01'];
  s.teacher_mode = 'from_zero';
  return s;
};

test('the mock now emits memory_facts, and they survive the real capture into the store', async (t) => {
  const f = await fixture(t);
  const msg = '我们班没有鼓，得想别的办法。';
  const { turn, captured } = await runTurn(f, msg, started());

  assert.equal(turn.memory_facts.length, 1,
    '这一轮应该正好提出一条约束');
  assert.equal(turn.memory_facts[0].kind, 'equipment');
  assert.equal(captured.recorded.length, 1, '应该真的写进去了');
  assert.equal(captured.refused.length, 0);

  const stored = await f.store.listFacts(f.user.id, { courseId: f.course.id });
  assert.equal(stored.length, 1, '存储里查得到');
  assert.equal(stored[0].kind, 'equipment');
  assert.ok(!stored[0].archived, '这是一条正常约束，不该被归档');
  // TWO VOCABULARIES, on purpose. The column stores 'extracted'|'teacher'|
  // 'widened' (the DB CHECK); listFacts hands back memory-scopes' 'auto'|
  // 'teacher' because its result goes straight to buildPromptParts({facts}).
  // Both tiers do the same round trip (json-store.mjs:142 out, :168 back), so
  // asserting the READ vocabulary here is what keeps them honest — a tier that
  // returned 'extracted' would break the prompt band, and one that STORED
  // 'auto' would violate the CHECK the day it ran on PostgreSQL.
  assert.equal(stored[0].source, 'auto', '读回来的是 memory-scopes 的说法');
  assert.ok(!['extracted', 'widened'].includes(stored[0].source),
    '存储层的写法不该漏到读接口上');
});

test('MUST REFUSE — a child claim is well-formed, named a real kind, and is still archived on arrival', async (t) => {
  const f = await fixture(t);
  const msg = '孩子们特别喜欢打鼓，每次都抢着来。';
  const { turn, captured } = await runTurn(f, msg, started());

  assert.ok(turn.memory_facts?.length, '模型确实提出了这一条——问题不在它提没提');
  assert.equal(captured.recorded.length, 0, '它不能进入记忆');
  const archivedOrRefused = captured.archived.length + captured.refused.length;
  assert.ok(archivedOrRefused >= 1, '要么归档、要么拒绝，不能默默收下');

  const live = (await f.store.listFacts(f.user.id, { courseId: f.course.id }))
    .filter((row) => !row.archived);
  assert.deepEqual(live, [], '「孩子已经喜欢上什么」不是约束：它每一轮都会被送进提示词，一旦记住就再也纠不回来');
});

test('a quote the teacher did not type is dropped — the same discipline as confirmed_by_quote', async (t) => {
  const f = await fixture(t);
  const captured = await captureMemoryFacts(f.store, {
    userId: f.user.id,
    courseId: f.course.id,
    teacherText: '今天先聊聊场地。',
    // Well-formed, correct kind, plausible text — and she never said it.
    candidates: [{ kind: 'equipment', text: '班上没有鼓', quote: '我们班没有鼓' }],
    facts: [],
  });
  assert.equal(captured.recorded.length, 0, '引不到原话就整条丢掉');
  assert.deepEqual(await f.store.listFacts(f.user.id, { courseId: f.course.id }), []);
});

test('MUST PASS — an ordinary turn writes no memory, so nothing accumulates by accident', async (t) => {
  const f = await fixture(t);
  const { turn, captured } = await runTurn(f, '我想带中班孩子做醒狮', started());

  assert.deepEqual(turn.memory_facts, [], '没有约束的一轮不该凭空长出记忆');
  assert.equal(captured.recorded.length, 0);
  assert.deepEqual(await f.store.listFacts(f.user.id, { courseId: f.course.id }), []);
});

test('the per-turn cap holds when she states several constraints at once', async (t) => {
  const f = await fixture(t);
  const msg = '我们班没有鼓，没有多余的场地，周三下午要午睡，班上二十八个孩子。';
  const { turn, captured } = await runTurn(f, msg, started());

  assert.ok(turn.memory_facts.length <= 3, '一轮最多 3 条——模型侧就该收住');
  assert.ok(captured.recorded.length <= 3);
  const kinds = captured.recorded.map((r) => r.kind);
  assert.equal(new Set(kinds).size, kinds.length, '同一轮不该记下重复类别的同一件事');
});
