// turn-salvage.test.mjs — L2 stray-field recovery and the orphan-op block.
//
// Fixed after a live MiniMax turn on 2026-08-17 that described a nine-node
// two-week plan in its prose, opened `plan_delta`, closed the array one element
// in, and wrote the rest as top-level siblings. Nothing failed: the turn parsed,
// the gate reported clean, the engine stripped the orphan exactly as designed,
// and the teacher read about two weeks of activities while looking at one node.
//
// Both directions for every rule. The silent half is the one that keeps this
// honest — a parser that folds anything it finds into the plan tree is a second
// write channel nobody reviewed, and a validator that calls every delta an
// orphan blocks every legitimate turn.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTurn, salvageStrayFields, topLevelPairs, validateTurn } from '../src/harness.mjs';

const node = (kind, title) => ({ kind, title, body: '正文', status: 'ai_suggestion', work_status: 'draft' });

/** A turn shaped exactly like the contract. Nothing here may be moved or flagged. */
const CLEAN = () => JSON.stringify({
  reply_markdown: '骨架长这样，请看右侧。',
  questions: [],
  plan_delta: [
    { op: 'set', id: 'p1', node: node('phase', '中秋') },
    { op: 'set', id: 'w1', parent_id: 'p1', node: node('week', '第一周') },
    { op: 'set', id: 'w1-a1', parent_id: 'w1', node: node('activity', '看月亮') },
  ],
  blueprint_delta: [],
  artifacts: [],
  state_delta: { theme_resource: { name: '中秋' } },
  evidence_refs: [],
  closure_loop: null,
  round_complete: false,
});

test('topLevelPairs keeps repeated keys that JSON.parse would collapse', () => {
  const raw = '{"a":1,"item":{"id":"x"},"item":{"id":"y"},"item":{"id":"z"}}';
  assert.equal(JSON.parse(raw).item.id, 'z', '前提：JSON.parse 只留最后一个');
  const pairs = topLevelPairs(raw);
  assert.deepEqual(pairs.map((p) => p.key), ['a', 'item', 'item', 'item']);
  assert.deepEqual(pairs.filter((p) => p.key === 'item').map((p) => p.value.id), ['x', 'y', 'z']);
});

test('topLevelPairs walks past strings, nesting and escapes without losing its place', () => {
  const raw = JSON.stringify({
    reply_markdown: 'a "quoted" }brace{ and a \\ backslash',
    plan_delta: [{ op: 'set', id: 'p1', node: { title: '带 } 的标题' } }],
    round_complete: true,
  });
  const pairs = topLevelPairs(raw);
  assert.deepEqual(pairs.map((p) => p.key), ['reply_markdown', 'plan_delta', 'round_complete']);
  assert.equal(pairs[1].value[0].id, 'p1');
  assert.equal(pairs[2].value, true);
});

test('a plan op written as a top-level sibling is folded back into plan_delta', () => {
  const raw = '{"reply_markdown":"两周的骨架","plan_delta":[{"op":"set","id":"p1","node":'
    + JSON.stringify(node('phase', '中秋'))
    + '}],"reason":"两周需要收束点","item":{"op":"set","id":"w1","parent_id":"p1","node":'
    + JSON.stringify(node('week', '第一周'))
    + '},"item":{"op":"set","id":"w2","parent_id":"p1","node":'
    + JSON.stringify(node('week', '第二周'))
    + '},"state_delta":{},"round_complete":false}';
  const { turn, violations } = parseTurn(raw);
  assert.deepEqual(turn.plan_delta.map((o) => o.id), ['p1', 'w1', 'w2'],
    '两个同名 item 都要救回来，不能只剩最后一个');
  const moved = violations.find((v) => v.kind === 'contract_stray_field');
  assert.ok(moved, '归位必须留痕，静默搬运等于第二条写入通道');
  assert.equal(moved.action, 'warn');
  assert.ok(violations.find((v) => v.kind === 'contract_unknown_field').detail.includes('reason'));
});

test('a state field written at the top level is folded into state_delta', () => {
  const raw = JSON.stringify({
    reply_markdown: '记下了',
    state_delta: { class_profile: { age_band: '大班' } },
    teacher_resource_intent: { hoped_feeling: '愿意自己动手' },
    round_complete: false,
  });
  const { turn, violations } = parseTurn(raw);
  assert.deepEqual(Object.keys(turn.state_delta).sort(), ['class_profile', 'teacher_resource_intent']);
  assert.ok(violations.some((v) => v.kind === 'contract_stray_field'));
});

test('state_delta wins over a stray copy of the same field', () => {
  const raw = '{"reply_markdown":"x","state_delta":{"theme_resource":{"name":"中秋"}},'
    + '"theme_resource":{"name":"端午"},"round_complete":false}';
  const { turn, violations } = parseTurn(raw);
  assert.equal(turn.state_delta.theme_resource.name, '中秋', '写对位置的那份才是模型的定稿');
  assert.ok(violations.some((v) => v.kind === 'contract_unknown_field'));
});

test('salvage declines fragments that are not whole nodes', () => {
  const { ops, dropped } = salvageStrayFields(
    '{"reply_markdown":"x","note":{"id":"w9"},"count":3,"round_complete":false}',
    { reply_markdown: 'x', round_complete: false },
  );
  assert.equal(ops.length, 0, 'id 但没有 node 的东西不是节点，不猜');
  assert.deepEqual(dropped.sort(), ['count', 'note']);
});

test('a contract-shaped turn is neither moved nor flagged', () => {
  const { turn, violations } = parseTurn(CLEAN());
  assert.equal(turn.plan_delta.length, 3);
  assert.equal(violations.length, 0, '合规的一轮必须完全安静');
});

test('an op whose parent was never created blocks the turn', () => {
  const { turn } = parseTurn(JSON.stringify({
    reply_markdown: '第二周有三个活动',
    plan_delta: [{ op: 'set', id: 'w2-a3', parent_id: 'w2', node: node('activity', '中秋小灯会') }],
    state_delta: {},
    round_complete: false,
  }));
  const violations = validateTurn(turn, {}, {});
  const orphan = violations.find((v) => v.kind === 'plan_orphan');
  assert.ok(orphan, '父节点不存在时必须挡下并重试，否则整棵树只剩一个节点');
  assert.equal(orphan.action, 'block');
  assert.ok(orphan.detail.includes('w2'));
});

test('a parent created earlier in the same delta is not an orphan', () => {
  const { turn } = parseTurn(CLEAN());
  const violations = validateTurn(turn, {}, {});
  assert.equal(violations.filter((v) => v.kind === 'plan_orphan').length, 0,
    '先父后子的完整树是正常交付，不能被当成孤儿');
});

test('a parent already in the course plan is not an orphan', () => {
  const { turn } = parseTurn(JSON.stringify({
    reply_markdown: '给第一周加一个活动',
    plan_delta: [{ op: 'set', id: 'w1-a2', parent_id: 'w1', node: node('activity', '做灯笼') }],
    state_delta: {},
    round_complete: false,
  }));
  const state = { course_plan: { version: 1, roots: [{ id: 'p1', children: [{ id: 'w1', children: [] }] }] } };
  const violations = validateTurn(turn, state, {});
  assert.equal(violations.filter((v) => v.kind === 'plan_orphan').length, 0,
    '增量编辑的父节点在树上，不在本轮 delta 里');
});
