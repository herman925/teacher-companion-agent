// The scripted walkthrough must demonstrate the v2 plan loop — build a plan,
// edit a node, live with the staleness an upstream edit causes — through the
// REAL write path (plan_delta → engine.applyPlanDelta), not a shortcut into
// course_state. A mock that took the shortcut would teach every key-less demo
// run a confirmation rule we do not ship.
//
// Every rule here is pinned in BOTH directions: the mock's own output stays
// silent, and a hand-built op that breaks the rule fires.

import test from 'node:test';
import assert from 'node:assert/strict';

import { mockTurn } from '../src/mock.mjs';
import { parseTurn, validateTurn } from '../src/harness.mjs';
import { createInitialState, applyDelta, absorbBlueprint, applyPlanDelta } from '../src/engine.mjs';
import { walkPlan, PLAN_KINDS } from '../src/plan-tsv.mjs';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** One pipeline step, mirroring demo/src/ui/local-turn.mjs exactly. */
function step(state, history, message, label = message.slice(0, 12)) {
  const { turn, violations: parseV } = parseTurn(mockTurn(state, history, message));
  assert.ok(turn, `${label} parses`);
  assert.equal(parseV.length, 0, `${label} parse clean`);
  const violations = validateTurn(turn, state, { teacherText: message, mock: true });
  assert.deepEqual(violations.filter((v) => v.action === 'block'), [], `${label} no blocking: ${JSON.stringify(violations)}`);
  let applied = applyDelta(state, turn.state_delta, { roundComplete: turn.round_complete, teacherTurn: true, teacherText: message, mock: true });
  applied.state = absorbBlueprint(applied.state, turn, { teacherTurn: true }).state;
  const pd = applyPlanDelta(applied.state, turn.plan_delta, { teacherText: message });
  history.push({ role: 'user', content: message }, { role: 'assistant', content: turn.reply_markdown });
  return { turn, state: pd.state, planViolations: pd.violations, violations };
}

/** Walk a script, returning the final state plus every turn seen. */
function walk(label, script) {
  let state = createInitialState(label);
  const history = [];
  const turns = [];
  for (const message of script) {
    const r = step(state, history, message, `${label}·${message.slice(0, 10)}`);
    assert.deepEqual(r.planViolations, [], `${label} plan ops apply clean: ${JSON.stringify(r.planViolations)}`);
    state = r.state;
    turns.push({ message, turn: r.turn });
  }
  return { state, turns, history };
}

const nodesOf = (plan) => [...walkPlan(plan)].map(({ node, depth }) => ({ ...node, _depth: depth }));
const byId = (plan, id) => nodesOf(plan).find((n) => n.id === id);

/** The from_zero script up to the point the plan tree exists. */
const BUILD = [
  '我想带中班孩子做醒狮',
  '园附近每年都有醒狮活动，孩子们其实见过，但只是看热闹',
];

// ------------------------------------------------------- 1. build the plan

test('from_zero round 2 builds a real course_plan through plan_delta', () => {
  const { state, turns } = walk('plan-build', BUILD);
  const round2 = turns[1].turn;
  assert.ok(round2.plan_delta.length >= 9, `round 2 emits the tree as ops (got ${round2.plan_delta.length})`);
  assert.ok(round2.plan_delta.every((o) => o.op === 'set'), 'a first plan is all set ops');
  const plan = state.course_plan;
  assert.ok(plan && plan.roots.length === 1, 'exactly one root 月计划');
  assert.equal(plan.roots[0].kind, 'phase', 'the root is a phase, not a calendar month');
  assert.ok(plan.revision_log.length >= 9, 'every op is in the revision log');
});

test('the tree has exactly three levels — a day is a FIELD, never a level', () => {
  const { state } = walk('plan-levels', BUILD);
  const nodes = nodesOf(state.course_plan);
  for (const n of nodes) {
    assert.ok(PLAN_KINDS.includes(n.kind), `${n.id} uses a known kind (${n.kind})`);
    assert.equal(n.kind, PLAN_KINDS[n._depth], `${n.id} sits at the depth its kind implies`);
    assert.ok(n._depth <= 2, `${n.id} is not a fourth level`);
  }
  assert.ok(nodes.some((n) => n.kind === 'week'), '周计划 present');
  const activities = nodes.filter((n) => n.kind === 'activity');
  assert.ok(activities.length >= 5, `activities present (${activities.length})`);
  assert.ok(activities.every((a) => !(a.children || []).length), 'no node hangs below an activity');
  // Dates live on activities and nowhere else.
  for (const a of activities) {
    assert.ok(Array.isArray(a.dates) && a.dates.length, `${a.id} carries its own date`);
    for (const d of a.dates) assert.match(d, ISO_DATE, `${a.id} date is ISO`);
  }
  for (const n of nodes.filter((x) => x.kind !== 'activity')) {
    assert.ok(!n.dates, `${n.id} (${n.kind}) does not carry a date — only activities do`);
  }
});

test('ancestors carry a summary — the one line a descendant focus band gets', () => {
  const { state } = walk('plan-summary', BUILD);
  for (const n of nodesOf(state.course_plan).filter((x) => x.kind !== 'activity')) {
    assert.ok(String(n.summary || '').trim(), `${n.id} (${n.title}) has a summary`);
  }
});

test('the five 组织形式 are on the activities as org_type', () => {
  const { state } = walk('plan-org', BUILD);
  const kinds = new Set(nodesOf(state.course_plan).filter((n) => n.kind === 'activity').map((n) => n.org_type));
  for (const org of ['集体教学', '小组教学', '个别指导', '自主游戏·环创', '亲子活动']) {
    assert.ok(kinds.has(org), `${org} appears in the plan`);
  }
});

// ---------------------------------------- 2. nobody is born confirmed

test('no plan node is born confirmed, however the teacher replied', () => {
  const { state } = walk('plan-birth', BUILD);
  for (const n of nodesOf(state.course_plan)) {
    assert.notEqual(n.status, 'confirmed', `${n.id} is not born confirmed`);
    assert.equal(n.work_status, 'draft', `${n.id} is born draft — nobody has worked on it yet`);
  }
});

test('negative: a set op claiming confirmed is degraded and reported', () => {
  const { state } = walk('plan-birth-neg', BUILD);
  const { violations, state: after } = applyPlanDelta(state, [{
    op: 'set',
    id: 'p9',
    parent_id: null,
    node: { kind: 'phase', title: '偷跑的阶段', body: '。', status: 'confirmed' },
    confirmed_by_quote: '园附近每年都有醒狮活动',
  }], { teacherText: '园附近每年都有醒狮活动，孩子们其实见过，但只是看热闹' });
  assert.ok(violations.some((v) => v.kind === 'born_confirmed'), 'born_confirmed fires on the violating fixture');
  assert.equal(byId(after.course_plan, 'p9').status, 'ai_suggestion', 'and the node is degraded, not applied as claimed');
});

// -------------------------------------- 3. hypothesis marking, both ways

test('a node body about what children will do is hedged AND marked hypothesis', () => {
  const { state, turns } = walk('plan-hyp', BUILD);
  assert.deepEqual(validateTurn(turns[1].turn, createInitialState('x'), { teacherText: turns[1].message, mock: true })
    .filter((v) => v.kind === 'unmarked_hypothesis'), [], 'the mock\'s own nodes stay silent');
  const wall = byId(state.course_plan, 'p1.w2.a2');
  assert.ok(wall, '问题墙 node exists');
  assert.equal(wall.status, 'hypothesis', 'it is marked hypothesis');
  assert.match(wall.body, /(可能|预计|待现场(确认|验证))/, 'and hedged in the prose too — belt and braces');
});

test('negative: an unhedged child-claim in a plan node body is blocked', () => {
  const { turn } = parseTurn({
    reply_markdown: '好的。',
    plan_delta: [{
      op: 'set',
      id: 'x1',
      node: { kind: 'week', title: '第 1 周', body: '孩子们都爱上了敲鼓，全班已经掌握了节奏。' },
    }],
  });
  const v = validateTurn(turn, createInitialState('neg-hyp'), { teacherText: '开始吧', mock: true });
  assert.ok(v.some((x) => x.kind === 'unmarked_hypothesis' && x.action === 'block'),
    'the harness fires on the violating fixture');
});

// ------------------------------- 4. edit a node → staleness downstream

test('editing 第 1 周 stamps the blast radius stale and leaves provenance alone', () => {
  const { state, history } = walk('plan-edit', BUILD);
  const before = nodesOf(state.course_plan);
  assert.ok(before.every((n) => n.stale_since == null), 'nothing is stale before the edit');

  const r = step(state, history, '第 1 周改一下');
  assert.deepEqual(r.planViolations, [], `edit applies clean: ${JSON.stringify(r.planViolations)}`);
  const after = r.state.course_plan;
  const edited = byId(after, 'p1.w1');
  assert.equal(edited.work_status, 'adjusting', 'the edited node moves on the WORK axis');
  assert.equal(edited.stale_since, undefined, 'the node she just edited is not stale to herself');

  // Its own activities and — through blueprint_refs — the weeks that rest on it.
  for (const id of ['p1.w1.a1', 'p1.w1.a2', 'p1.w2', 'p1.w2.a1', 'p1.w3', 'p1.w3.a1']) {
    const n = byId(after, id);
    assert.ok(n.stale_since, `${id} is stamped 待复查`);
    assert.ok(String(n.stale_reason || '').length, `${id} says WHY it is flagged`);
  }
  // Staleness never touches provenance — that is the whole point of two axes.
  for (const n of nodesOf(after)) {
    const was = before.find((b) => b.id === n.id);
    if (was) assert.equal(n.status, was.status, `${n.id} keeps its provenance through an upstream edit`);
  }
  assert.match(r.turn.reply_markdown, /待复查/, 'and she is TOLD, in the reply, what got flagged');
});

// ------------------------------------------ 5. a date is a field, not a level

test('a reschedule moves one activity date; the tree grows no new level', () => {
  const { state, history } = walk('plan-date', BUILD);
  const depthBefore = Math.max(...nodesOf(state.course_plan).map((n) => n._depth));
  const r = step(state, history, '把体验角挪到周三');
  assert.deepEqual(r.planViolations, [], 'reschedule applies clean');
  const moved = byId(r.state.course_plan, 'p1.w1.a2');
  assert.equal(moved.dates.length, 1, 'the activity now sits on one day');
  assert.match(moved.dates[0], ISO_DATE, 'still an ISO date');
  const [y, m, d] = moved.dates[0].split('-').map(Number);
  assert.equal(new Date(y, m - 1, d).getDay(), 3, '周三 means Wednesday');
  assert.equal(Math.max(...nodesOf(r.state.course_plan).map((n) => n._depth)), depthBefore, 'no 日计划 level appeared');
  assert.equal(byId(r.state.course_plan, 'p1.w1').kind, 'week', 'the week is still a week');
});

// -------------------------------------------------- 6. remove an activity

test('dropping an activity removes it and leaves a record of the removal', () => {
  const { state, history } = walk('plan-drop', BUILD);
  assert.ok(byId(state.course_plan, 'p1.w3.a2'), '个别指导 exists before the drop');
  const r = step(state, history, '第 3 周的个别指导先去掉');
  assert.deepEqual(r.planViolations, [], 'drop applies clean');
  assert.equal(byId(r.state.course_plan, 'p1.w3.a2'), undefined, 'the node is gone from the tree');
  assert.ok(r.state.course_plan.revision_log.some((e) => e.op === 'remove' && e.node_id === 'p1.w3.a2'),
    'but the removal itself is on the record');
  assert.equal(byId(r.state.course_plan, 'p1.w3').work_status, 'adjusting', 'the week it left is marked adjusting');
});

// -------------------------------- 7. confirmation is citation, both ways

test('confirming a node quotes words she actually typed this turn', () => {
  const { state, history } = walk('plan-confirm', BUILD);
  const message = '第 1 周就这样定了';
  const r = step(state, history, message);
  assert.deepEqual(r.planViolations, [], `confirm applies clean: ${JSON.stringify(r.planViolations)}`);
  const op = r.turn.plan_delta[0];
  assert.ok(message.includes(op.confirmed_by_quote), 'the quote is a substring of what she typed');
  const node = byId(r.state.course_plan, 'p1.w1');
  assert.equal(node.status, 'confirmed', 'her words move provenance');
  assert.equal(node.work_status, 'settled', 'and the work axis moves with them, independently');
});

test('negative: a quote she never said is refused and the status reverts', () => {
  const { state } = walk('plan-confirm-neg', BUILD);
  const faked = [{
    op: 'update',
    id: 'p1.w1',
    node: { status: 'confirmed' },
    confirmed_by_quote: '第 1 周就这样定了',
  }];
  const r = applyPlanDelta(state, faked, { teacherText: '我再想想，先不定' });
  assert.ok(r.violations.some((v) => v.kind === 'uncited_confirmation'), 'uncited_confirmation fires');
  assert.notEqual(byId(r.state.course_plan, 'p1.w1').status, 'confirmed', 'and the escalation does not land');
});

test('across a whole walk the mock never emits a quote the teacher did not type', () => {
  const { turns } = walk('plan-quotes', [
    ...BUILD,
    '第 1 周改一下',
    '把体验角挪到周三',
    '第 3 周的个别指导先去掉',
    '第 1 周就这样定了',
  ]);
  let checked = 0;
  for (const { message, turn } of turns) {
    for (const op of turn.plan_delta || []) {
      if (!op.confirmed_by_quote) continue;
      assert.ok(String(message).includes(op.confirmed_by_quote),
        `「${op.confirmed_by_quote}」 must occur in 「${message}」`);
      checked += 1;
    }
  }
  assert.ok(checked >= 1, 'at least one confirmation was actually exercised');
});

// ----------------------------------------- 8. optimize_existing plans too

test('optimize_existing also lands a plan tree once the driving question is set', () => {
  const { state, turns } = walk('plan-optimize', [
    '我们班在做龙舟主题，想优化',
    '有主题网络，但孩子兴趣散，做了两周活动不知道下一步',
    '有孩子问龙舟为什么要有鼓，还有孩子说想自己做一条会浮的龙舟',
    '孩子们更想做会浮的小龙舟，就选第一个',
  ]);
  assert.ok(turns[3].turn.plan_delta.length >= 5, 'the pick turn carries the plan ops');
  const nodes = nodesOf(state.course_plan);
  assert.equal(nodes.filter((n) => n.kind === 'phase').length, 1, 'one action phase');
  assert.equal(nodes.filter((n) => n.kind === 'week').length, 2, 'two weeks under it');
  assert.ok(nodes.filter((n) => n.kind === 'activity').every((a) => (a.dates || []).every((d) => ISO_DATE.test(d))),
    'activities carry ISO dates');
  assert.ok(nodes.every((n) => n.status !== 'confirmed'), 'and still nothing is born confirmed');
});

// -------------------------------------------- 9. the two axes are separate

test('the two status axes move independently across the loop', () => {
  const { state, history } = walk('plan-axes', BUILD);
  const seen = { status: new Set(), work: new Set() };
  const record = (plan) => {
    for (const n of nodesOf(plan)) { seen.status.add(n.status); seen.work.add(n.work_status); }
  };
  record(state.course_plan);
  let cur = state;
  for (const message of ['第 1 周改一下', '第 1 周就这样定了']) {
    const r = step(cur, history, message);
    cur = r.state;
    record(cur.course_plan);
  }
  assert.ok(seen.status.has('ai_suggestion') && seen.status.has('hypothesis') && seen.status.has('confirmed'),
    `provenance values seen: ${[...seen.status].join(',')}`);
  assert.ok(seen.work.has('draft') && seen.work.has('adjusting') && seen.work.has('settled'),
    `work values seen: ${[...seen.work].join(',')}`);
  // The independence itself: a hypothesis node that is nonetheless being worked on.
  const wall = byId(cur.course_plan, 'p1.w2.a2');
  assert.equal(wall.status, 'hypothesis', 'still a hypothesis after all that editing');
});
