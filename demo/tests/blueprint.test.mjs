// Blueprint Tier-0 tests (ADR-0003): client-side numbering is deterministic,
// the mock planning fast path passes the real harness in both rounds, and —
// pollution guard — non-planning entries never see the blueprint machinery.

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeBlueprint, numberBlueprint, blueprintIndex } from '../src/blueprint-util.mjs';
import { parseTurn, validateTurn } from '../src/harness.mjs';
import { createInitialState, applyDelta } from '../src/engine.mjs';
import { mockTurn } from '../src/mock.mjs';

const blocking = (violations) => violations.filter((v) => v.action === 'block');

// ---------- numbering util (pure, client-side) ----------

test('numberBlueprint: display numbers derive from tree position, never from the model', () => {
  const { modules } = normalizeBlueprint({
    version: 'v0.1',
    modules: [
      { id: 'a', title: 'A', children: [{ id: 'a1', title: 'A1' }, { id: 'a2', title: 'A2', children: [{ id: 'a2x', title: 'A2X' }] }] },
      { id: 'b', title: 'B' },
    ],
  });
  const numbered = numberBlueprint(modules);
  const index = blueprintIndex(numbered);
  assert.deepEqual(index.map((r) => [r.number, r.id]), [
    ['1', 'a'], ['1.1', 'a1'], ['1.2', 'a2'], ['1.2.1', 'a2x'], ['2', 'b'],
  ]);
});

test('normalizeBlueprint: missing ids get stable path ids, unknown status defaults, junk tolerated', () => {
  const { version, modules } = normalizeBlueprint({
    modules: [{ title: '无id', status: 'nonsense', children: [{ title: '子节点' }] }],
  });
  assert.equal(version, 'v0.1');
  assert.equal(modules[0].id, 'm1');
  assert.equal(modules[0].status, 'ai_suggestion');
  assert.equal(modules[0].children[0].id, 'm1.1');
});

test('numberBlueprint: rollup counts include the node itself and all descendants', () => {
  const { modules } = normalizeBlueprint({
    modules: [{ id: 'm', title: 'M', status: 'ai_suggestion', children: [
      { id: 'h1', title: 'H1', status: 'hypothesis' },
      { id: 'c1', title: 'C1', status: 'confirmed' },
    ] }],
  });
  const [m] = numberBlueprint(modules);
  assert.equal(m.rollup.hypothesis, 1);
  assert.equal(m.rollup.confirmed, 1);
  assert.equal(m.rollup.ai_suggestion, 1);
});

// ---------- mock planning fast path through the real harness ----------

const PLAN_MSG = '我想围绕龙舟开展大班主题，帮我做一个月计划';

test('round 1: planning request → blueprint v0.1 + ≤3 gap cards, zero blocking violations', () => {
  const state = createInitialState('t-bp');
  const raw = mockTurn(state, [], PLAN_MSG);
  const { turn, violations: parseViolations } = parseTurn(raw);
  assert.equal(parseViolations.length, 0);
  const bp = turn.artifacts.find((a) => a.type === 'blueprint');
  assert.ok(bp, 'blueprint artifact delivered on turn 1 (deliver-then-ask)');
  assert.equal(bp.data.version, 'v0.1');
  const moduleIds = bp.data.modules.map((m) => m.id);
  // Full picture from round 1: maps detailed + downstream modules present as
  // visibly-thin hypothesis placeholders (骨架先立起来).
  for (const required of ['theme_judgment', 'five_steps', 'network_map', 'depth_network', 'week_plan', 'activity_pack', 'environment']) {
    assert.ok(moduleIds.includes(required), `round 1 skeleton includes ${required}`);
  }
  const placeholders = bp.data.modules.filter((m) => ['week_plan', 'activity_pack', 'environment'].includes(m.id));
  assert.ok(placeholders.every((m) => m.status === 'hypothesis'), 'downstream modules are marked hypothesis until confirmed');
  assert.ok(turn.questions.length >= 1 && turn.questions.length <= 3, 'card count within planning density guardrail');
  for (const q of turn.questions) assert.ok(q.text && q.examples.length >= 2, 'every card complete');
  // Not-yet-happened child content is marked, not asserted.
  const flat = blueprintIndex(numberBlueprint(normalizeBlueprint(bp.data).modules));
  assert.ok(flat.some((r) => r.status === 'hypothesis'), 'child predictions carry hypothesis status');
  assert.equal(blocking(validateTurn(turn, state)).length, 0);
});

test('round 2: teacher reply → full 预设包 v0.2, closure loop, entry card in delta, zero blocking', () => {
  const state = createInitialState('t-bp2');
  const r1 = mockTurn(state, [], PLAN_MSG);
  const { state: next } = applyDelta(state, r1.state_delta);
  const history = [{ role: 'assistant', content: r1.reply_markdown }];
  const r2raw = mockTurn(next, history, '【问题卡回复】1. 「园里或周边有哪些能用上的龙舟资源」：附近有龙舟队，可以约参观 2. 「这个主题你打算做多久、班里大概多少个孩子」：做一个月，30个孩子');
  const { turn: r2 } = parseTurn(r2raw);
  const bp = r2.artifacts.find((a) => a.type === 'blueprint');
  assert.ok(bp, 'round 2 ships the full package');
  assert.equal(bp.data.version, 'v0.2', 'version bumps instead of forking a second plan');
  const ids = bp.data.modules.map((m) => m.id);
  for (const required of ['week_plan', 'activity_pack', 'environment', 'feedback_card']) {
    assert.ok(ids.includes(required), `full package includes ${required}`);
  }
  assert.equal(r2.round_complete, true);
  assert.ok(r2.closure_loop && r2.closure_loop.bring_back, 'closure loop hands work back to the field');
  assert.ok(r2.state_delta.resource_entry_card, 'entry card lands via state_delta so the normal flow continues');
  assert.equal(blocking(validateTurn(r2, next)).length, 0);
  // Confirmed status only where the teacher's reply confirmed it.
  const confirmedModules = bp.data.modules.filter((m) => m.status === 'confirmed').map((m) => m.id);
  assert.deepEqual(confirmedModules, ['network_map'], 'only the teacher-confirmed module escalates');
});

test('round 2 delta applies cleanly and the flow rejoins the normal from_zero path', () => {
  const state = createInitialState('t-bp3');
  const r1 = mockTurn(state, [], PLAN_MSG);
  const s1 = applyDelta(state, r1.state_delta).state;
  const r2 = mockTurn(s1, [{ role: 'assistant', content: r1.reply_markdown }], '就按这个方向来');
  const { state: s2, violations } = applyDelta(s1, r2.state_delta, { roundComplete: r2.round_complete });
  assert.equal(violations.filter((v) => v.action === 'strip').length, 0, 'no fields stripped from the round-2 delta');
  assert.ok(s2.resource_entry_card, 'entry card persisted');
  // 备课 delivery: no child evidence yet, so the round closes WITHOUT flipping
  // awaiting_feedback — the teacher confirms the plan, nothing is "awaited".
  assert.equal(s2.awaiting_feedback, false, '备课 round must not show 等待你带回现场反馈');
  // Next teacher message goes through the ordinary awaiting phase — no blueprint re-trigger.
  const r3 = mockTurn(s2, [], '孩子们围着龙舟模型看了很久，有人问「桨为什么是弯的」');
  assert.ok(!(r3.artifacts || []).some((a) => a.type === 'blueprint'), 'after round 2 the normal flow owns the course');
});

// ---------- required-gap intake: ask only what the teacher hasn't said ----------

test('gap cards skip what the message already answers (亮灯), ask what it lacks', () => {
  // PLAN_MSG says 一个月 + 月计划 → duration and format are known; intent/class are not.
  const known = mockTurn(createInitialState('t-gap1'), [], PLAN_MSG);
  const knownIds = known.questions.map((q) => q.id);
  assert.ok(!knownIds.includes('q-bp-duration'), 'duration already given — never re-asked');
  assert.ok(!knownIds.includes('q-bp-format'), '月计划 already named — format never re-asked');
  assert.ok(knownIds.includes('q-bp-intent'), 'intent not stated — asked (WF03b heart)');
  assert.ok(knownIds.includes('q-bp-class'), 'class size missing — asked');
  // A message that carries its intent skips the intent card and frees a slot.
  const withIntent = mockTurn(createInitialState('t-gap2'), [], '我想做醒狮，孩子们其实见过，园里想做本土文化课程');
  const wiIds = withIntent.questions.map((q) => q.id);
  assert.ok(!wiIds.includes('q-bp-intent'), 'stated intent is never re-asked');
  assert.ok(wiIds.includes('q-bp-duration'), 'freed slot goes to the next gap');
  assert.ok(withIntent.questions.length <= 3, 'planning density guardrail holds');
});

// ---------- both directions: no pollution of existing journeys ----------

test('蓝图共创 is the from_zero DEFAULT — a bare theme entry gets blueprint v0.1, no magic words', () => {
  const state = createInitialState('t-plain');
  const turn = mockTurn(state, [], '我想带中班孩子做醒狮');
  const bp = (turn.artifacts || []).find((a) => a.type === 'blueprint');
  assert.ok(bp, 'blueprint delivered on the very first theme message (ADR-0003 amendment 2)');
  assert.equal(bp.data.version, 'v0.1');
  assert.ok(turn.questions.some((q) => q.id === 'q-bp-intent'), 'required intent gap asked alongside');
});

test('material/story/optimize entries are untouched by the planning trigger', () => {
  const state = createInitialState('t-other');
  const material = mockTurn(state, [], '我想要一份趁墟的亲子调查素材');
  assert.ok(!(material.artifacts || []).some((a) => a.type === 'blueprint'));
  const story = mockTurn(createInitialState('t-story'), [], '帮我把照片整理成课程故事');
  assert.ok(!(story.artifacts || []).some((a) => a.type === 'blueprint'));
});
