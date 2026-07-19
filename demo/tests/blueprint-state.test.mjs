// ADR-0003 Phase 3, state side: blueprint artifacts absorb into the living
// course_plan_blueprint (engine-owned versioning, module-granularity merge,
// born-confirmed downgrade) and the new harness rules fire on violating
// blueprints while staying silent on compliant ones — both directions.

import test from 'node:test';
import assert from 'node:assert/strict';

import { absorbBlueprint, applyDelta, createInitialState } from '../src/engine.mjs';
import { parseTurn, validateTurn, safeTemplate } from '../src/harness.mjs';
import { mockTurn } from '../src/mock.mjs';

const bpTurn = (modules, version = 'v0.1') => ({
  artifacts: [{ type: 'blueprint', title: 't', data: { version, modules } }],
});

// ---------- engine absorb ----------

test('absorb: modules merge by id, engine owns the monotonic version', () => {
  const s0 = createInitialState('t-abs');
  const r1 = absorbBlueprint(s0, bpTurn([{ id: 'a', title: 'A', status: 'ai_suggestion' }, { id: 'b', title: 'B', status: 'hypothesis' }]));
  assert.equal(r1.state.course_plan_blueprint.version, 1);
  assert.equal(r1.state.course_plan_blueprint.modules.length, 2);
  const r2 = absorbBlueprint(r1.state, bpTurn([{ id: 'a', title: 'A改', status: 'ai_suggestion' }, { id: 'c', title: 'C', status: 'ai_suggestion' }], 'v0.2'));
  const bp = r2.state.course_plan_blueprint;
  assert.equal(bp.version, 2);
  assert.equal(bp.display_version, 'v0.2');
  assert.deepEqual(bp.modules.map((m) => m.id), ['a', 'b', 'c'], 'merge by id, first-appearance order kept');
  assert.equal(bp.modules[0].title, 'A改', 'same id = replace');
  assert.deepEqual(bp.revision_log.map((r) => `${r.v}:${r.module_id}:${r.op}`), ['1:a:set', '1:b:set', '2:a:update', '2:c:set']);
  assert.ok(!s0.course_plan_blueprint, 'pure — input untouched');
});

test('absorb: a module can never be BORN confirmed; escalation needs a teacher reply', () => {
  const s0 = createInitialState('t-esc');
  const born = absorbBlueprint(s0, bpTurn([{ id: 'net', title: 'N', status: 'confirmed' }]), { teacherTurn: true });
  assert.equal(born.state.course_plan_blueprint.modules[0].status, 'ai_suggestion', 'born-confirmed downgraded even on a teacher turn');
  const esc = absorbBlueprint(born.state, bpTurn([{ id: 'net', title: 'N', status: 'confirmed' }], 'v0.2'), { teacherTurn: true });
  assert.equal(esc.state.course_plan_blueprint.modules[0].status, 'confirmed', 'existing module escalates on a teacher reply');
  const silent = absorbBlueprint(born.state, bpTurn([{ id: 'net', title: 'N', status: 'confirmed' }], 'v0.2'), {});
  assert.equal(silent.state.course_plan_blueprint.modules[0].status, 'ai_suggestion', 'no teacher turn → no escalation');
});

test('absorb: two artifacts in ONE turn cannot launder a confirmation (review finding)', () => {
  const s0 = createInitialState('t-launder');
  const turn = {
    artifacts: [
      { type: 'blueprint', data: { modules: [{ id: 'net', title: 'N', status: 'ai_suggestion' }] } },
      { type: 'blueprint', data: { modules: [{ id: 'net', title: 'N', status: 'confirmed' }] } },
    ],
  };
  const r = absorbBlueprint(s0, turn, { teacherTurn: true });
  assert.equal(r.state.course_plan_blueprint.modules[0].status, 'ai_suggestion', 'same-turn artifact #1 must not count as pre-turn state');
});

test('absorb: NESTED nodes obey born-confirmed too (review finding)', () => {
  const s0 = createInitialState('t-nested');
  const r = absorbBlueprint(s0, bpTurn([{ id: 'm', title: 'M', status: 'ai_suggestion', children: [{ id: 'm.kid', title: 'K', status: 'confirmed' }] }]), { teacherTurn: true });
  assert.equal(r.state.course_plan_blueprint.modules[0].children[0].status, 'ai_suggestion');
  const esc = absorbBlueprint(r.state, bpTurn([{ id: 'm', title: 'M', status: 'ai_suggestion', children: [{ id: 'm.kid', title: 'K', status: 'confirmed' }] }], 'v2'), { teacherTurn: true });
  assert.equal(esc.state.course_plan_blueprint.modules[0].children[0].status, 'confirmed', 'existing nested node escalates on teacher reply');
});

test('absorb: empty blueprint artifact bumps nothing (review finding)', () => {
  const s0 = createInitialState('t-empty');
  const withBp = absorbBlueprint(s0, bpTurn([{ id: 'a', title: 'A', status: 'ai_suggestion' }])).state;
  const after = absorbBlueprint(withBp, { artifacts: [{ type: 'blueprint', data: {} }] });
  assert.equal(after.state.course_plan_blueprint.version, 1, 'no modules → no version bump');
  assert.equal(after.state.course_plan_blueprint.display_version, withBp.course_plan_blueprint.display_version);
});

test('pending_validation survives normalization end to end (review finding)', () => {
  const s0 = createInitialState('t-pv');
  const r = absorbBlueprint(s0, bpTurn([{ id: 'p', title: 'P', body: '孩子们都发现了浮力。', status: 'pending_validation' }]));
  assert.equal(r.state.course_plan_blueprint.modules[0].status, 'pending_validation', 'tentative marking is never silently destroyed');
  // and the harness accepts it as tentative (no unmarked_hypothesis)
  const { turn } = parseTurn({ reply_markdown: '看卡片。', artifacts: [{ type: 'blueprint', data: { modules: [{ id: 'p', title: 'P', body: '孩子们都发现了浮力。', status: 'pending_validation' }] } }], state_delta: {}, evidence_refs: [], round_complete: false });
  assert.ok(!validateTurn(turn, s0).some((v) => v.kind === 'unmarked_hypothesis'));
});

test('absorb: no blueprint artifact → state returned as-is; junk data tolerated', () => {
  const s0 = createInitialState('t-noop');
  assert.equal(absorbBlueprint(s0, { artifacts: [] }).state, s0);
  const junk = absorbBlueprint(s0, bpTurn([{ title: '无id', status: 'nonsense' }]));
  assert.equal(junk.state.course_plan_blueprint.modules[0].status, 'ai_suggestion', 'normalize handles junk');
});

test('absorb: mock two-round planning flow builds a living blueprint in state', () => {
  const s0 = createInitialState('t-flow');
  const r1raw = mockTurn(s0, [], '我想围绕龙舟开展大班主题，帮我做一个月计划');
  const { turn: t1 } = parseTurn(r1raw);
  let s1 = applyDelta(s0, t1.state_delta).state;
  s1 = absorbBlueprint(s1, t1, { teacherTurn: true }).state;
  assert.equal(s1.course_plan_blueprint.version, 1);
  const r2raw = mockTurn(s1, [{ role: 'assistant', content: t1.reply_markdown }], '就按这个方向来');
  const { turn: t2 } = parseTurn(r2raw);
  let s2 = applyDelta(s1, t2.state_delta).state;
  s2 = absorbBlueprint(s2, t2, { teacherTurn: true }).state;
  assert.equal(s2.course_plan_blueprint.version, 2);
  const net = s2.course_plan_blueprint.modules.find((m) => m.id === 'network_map');
  assert.equal(net.status, 'confirmed', 'teacher-reply escalation lands for the confirmed map module');
  const ids = s2.course_plan_blueprint.modules.map((m) => m.id);
  for (const id of ['week_plan', 'activity_pack', 'environment']) assert.ok(ids.includes(id));
});

// ---------- harness rules, both directions ----------

const baseTurn = (extra) => ({
  reply_markdown: '这一轮的蓝图在卡片里。',
  artifacts: [],
  closure_loop: null,
  state_delta: {},
  evidence_refs: [],
  round_complete: false,
  ...extra,
});

test('unmarked_hypothesis FIRES: child-reaction-as-fact node without tentative status', () => {
  const { turn } = parseTurn(baseTurn(bpTurn([{ id: 'x', title: 'X', body: '孩子们已经爱上醒狮了。', status: 'ai_suggestion' }])));
  const v = validateTurn(turn, createInitialState('t-h1'));
  assert.ok(v.some((x) => x.kind === 'unmarked_hypothesis' && x.action === 'block'));
});

test('unmarked_hypothesis SILENT: same claim marked hypothesis, or hedged, or in a plain turn', () => {
  const marked = parseTurn(baseTurn(bpTurn([{ id: 'x', title: 'X', body: '孩子们已经爱上醒狮了。', status: 'hypothesis' }]))).turn;
  assert.ok(!validateTurn(marked, createInitialState('t-h2')).some((x) => x.kind === 'unmarked_hypothesis'));
  const hedged = parseTurn(baseTurn(bpTurn([{ id: 'x', title: 'X', body: '孩子们可能会爱上醒狮。', status: 'ai_suggestion' }]))).turn;
  assert.ok(!validateTurn(hedged, createInitialState('t-h3')).some((x) => x.kind === 'unmarked_hypothesis'));
  // Dormancy: no blueprint artifact → rule never runs (prose rules still apply elsewhere).
  const plain = parseTurn(baseTurn({ reply_markdown: '好的，我们继续。' })).turn;
  assert.ok(!validateTurn(plain, createInitialState('t-h4')).some((x) => x.kind === 'unmarked_hypothesis'));
});

test('planning_question_density: warns above 3 cards on a blueprint turn, silent at 3 or on plain turns', () => {
  const q = (t) => ({ text: t, why: 'w', examples: ['a', 'b'] });
  const dense = parseTurn(baseTurn({ ...bpTurn([{ id: 'x', title: 'X', status: 'ai_suggestion' }]), questions: [q('一'), q('二'), q('三'), q('四')] })).turn;
  const v = validateTurn(dense, createInitialState('t-d1'));
  assert.ok(v.some((x) => x.kind === 'planning_question_density' && x.action === 'warn'));
  const ok = parseTurn(baseTurn({ ...bpTurn([{ id: 'x', title: 'X', status: 'ai_suggestion' }]), questions: [q('一'), q('二'), q('三')] })).turn;
  assert.ok(!validateTurn(ok, createInitialState('t-d2')).some((x) => x.kind === 'planning_question_density'));
  const plainDense = parseTurn(baseTurn({ questions: [q('一'), q('二'), q('三'), q('四')] })).turn;
  assert.ok(!validateTurn(plainDense, createInitialState('t-d3')).some((x) => x.kind === 'planning_question_density'), 'dormant without a blueprint');
});

test('safeTemplate: planning variant when a blueprint exists, field-fact variant otherwise', () => {
  const s = createInitialState('t-st');
  assert.match(safeTemplate(s).reply_markdown, /现场信息/);
  const withBp = absorbBlueprint(s, bpTurn([{ id: 'a', title: 'A', status: 'ai_suggestion' }])).state;
  const t = safeTemplate(withBp);
  assert.match(t.reply_markdown, /蓝图保持原样/);
  assert.ok(!/现场信息/.test(t.reply_markdown), 'planning fallback never demands field facts');
});
