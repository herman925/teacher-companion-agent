// plan-delta.test.mjs — applyPlanDelta: the model's only write path into the
// 课程计划树 (ADR-0007 §2/§5, ADR-0010 §5/§6).
//
// Every rule here is tested in BOTH directions, and the must-pass half is the
// one that matters: an engine that strips everything is indistinguishable from
// an engine with no write path at all. The confirmation rules get the most
// weight because ADR-0010 §6 removed the ✓确认 tick and moved the whole
// escalation guarantee onto the citation checked in this file — a `confirmed`
// written without the teacher's words is non-negotiable #1 failing quietly.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createInitialState, applyPlanDelta } from '../src/engine.mjs';
import { walkPlan, toSkeletonTSV, SKELETON_COLUMNS } from '../src/plan-tsv.mjs';

/** 周3 rests on 周2's boat activity by reference, so an edit to 周2 reaches it
 * sideways as well as down. Everything else is confirmed and settled, so any
 * accidental movement shows up immediately. */
const COURSE = () => ({
  ...createInitialState('plan-delta'),
  course_plan: {
    version: 7,
    roots: [{
      id: 'p1', kind: 'phase', title: '东乡龙舟', status: 'confirmed', work_status: 'settled',
      children: [
        {
          id: 'w1', kind: 'week', title: '周1 认识龙舟', status: 'confirmed', work_status: 'settled',
          children: [
            { id: 'a1', kind: 'activity', title: '看一条真龙舟', dates: ['2026-09-21'], status: 'confirmed', work_status: 'settled' },
          ],
        },
        {
          id: 'w2', kind: 'week', title: '周2 龙舟与水', status: 'confirmed', work_status: 'settled',
          children: [
            { id: 'a2', kind: 'activity', title: '做一条会浮的船', dates: ['2026-09-28'], status: 'confirmed', work_status: 'settled' },
          ],
        },
        {
          id: 'w3', kind: 'week', title: '周3 划起来', status: 'ai_suggestion', work_status: 'draft', blueprint_refs: ['a2'],
          children: [
            { id: 'a3', kind: 'activity', title: '试划自己的船', dates: ['2026-10-05'], status: 'hypothesis', work_status: 'draft' },
          ],
        },
      ],
    }],
  },
});

const nodeOf = (state, id) => [...walkPlan(state.course_plan)].find(({ node }) => node.id === id)?.node;
const kinds = (violations) => violations.map((v) => v.kind);

// ---------- the engine decides ----------

test('unknown node: the op is stripped and nothing about the plan moves', () => {
  const before = COURSE();
  const { state, violations } = applyPlanDelta(before, [
    { op: 'update', id: 'w9', node: { title: '不存在的周' } },
    { op: 'remove', id: 'ghost' },
    { op: 'set', id: 'a9', parent_id: 'w9', node: { title: '挂在鬼节点下' } },
  ]);
  assert.equal(violations.length, 3);
  assert.deepEqual(kinds(violations), ['plan_scope', 'plan_scope', 'plan_scope']);
  for (const v of violations) assert.equal(v.action, 'strip');
  assert.equal(nodeOf(state, 'w9'), undefined, '错 id 不能悄悄长出第二棵树');
  assert.equal(nodeOf(state, 'a9'), undefined);
  assert.equal(state.course_plan.version, 7, '全被剥掉的一轮不能推进版本');
  assert.equal(state.course_plan.revision_log.length, 0);
});

test('MUST PASS — a well-formed op on a known node applies in full', () => {
  const { state, violations } = applyPlanDelta(COURSE(), [
    { op: 'update', id: 'w3', node: { title: '周3 划起来（改）', work_status: 'adjusting' } },
  ]);
  assert.deepEqual(violations, [], '合法的改动必须原样通过');
  assert.equal(nodeOf(state, 'w3').title, '周3 划起来（改）');
  assert.equal(nodeOf(state, 'w3').work_status, 'adjusting');
  assert.equal(nodeOf(state, 'w3').status, 'ai_suggestion', '没说出处就不动出处');
  assert.equal(nodeOf(state, 'w3').blueprint_refs?.[0], 'a2', '没提到的字段保持原样');
});

test('unknown op kind is recorded rather than guessed at', () => {
  const { state, violations } = applyPlanDelta(COURSE(), [{ op: 'merge', id: 'w2', node: {} }]);
  assert.deepEqual(kinds(violations), ['plan_scope']);
  assert.equal(state.course_plan.version, 7);
});

test('an empty or junk delta is a no-op returning the same state object', () => {
  const before = COURSE();
  for (const ops of [[], null, undefined, 'nonsense', [null, {}, { op: 'update' }, { id: 'w2' }]]) {
    const { state, violations } = applyPlanDelta(before, ops);
    assert.equal(state, before, '没有可执行的操作就不该重建状态');
    assert.deepEqual(violations, []);
  }
});

test('purity: the caller keeps the state it passed in', () => {
  const before = COURSE();
  const snapshot = structuredClone(before);
  applyPlanDelta(before, [
    { op: 'update', id: 'w2', node: { title: '改了' } },
    { op: 'remove', id: 'a1' },
    { op: 'set', id: 'a4', parent_id: 'w1', node: { title: '新活动' } },
  ]);
  assert.deepEqual(before, snapshot, '纯函数：调用方拿到的是新状态');
});

// ---------- a node is never born confirmed ----------

test('born confirmed: a new node degrades to ai_suggestion, quote or no quote', () => {
  for (const quote of [undefined, '就加这个，确认']) {
    const { state, violations } = applyPlanDelta(COURSE(), [
      { op: 'set', id: 'a4', parent_id: 'w1', node: { title: '划船动作练习', status: 'confirmed' }, confirmed_by_quote: quote },
    ]);
    assert.equal(nodeOf(state, 'a4').status, 'ai_suggestion', '她没看过的节点不可能被她确认过');
    assert.ok(kinds(violations).includes('born_confirmed'));
    assert.equal(nodeOf(state, 'a4').title, '划船动作练习', '降级出处，但内容照常写入');
  }
});

test('born confirmed: a nested new child cannot arrive confirmed either', () => {
  const { state, violations } = applyPlanDelta(COURSE(), [{
    op: 'set',
    id: 'w4',
    parent_id: 'p1',
    node: { title: '周4 龙舟赛', status: 'ai_suggestion', children: [{ id: 'a5', title: '办一场赛', status: 'confirmed' }] },
  }]);
  assert.equal(nodeOf(state, 'a5').status, 'ai_suggestion');
  assert.equal(kinds(violations).filter((k) => k === 'born_confirmed').length, 1);
  assert.equal(nodeOf(state, 'a5').kind, 'activity', '深度决定层级：周下面的新节点是活动');
});

test('MUST PASS — a new node arrives with the provenance it was given', () => {
  const { state, violations } = applyPlanDelta(COURSE(), [
    { op: 'set', id: 'a4', parent_id: 'w1', node: { title: '划船动作练习', status: 'hypothesis', work_status: 'draft' } },
  ]);
  assert.deepEqual(violations, []);
  const a4 = nodeOf(state, 'a4');
  assert.equal(a4.status, 'hypothesis', '假设就是假设，既不升级也不降级');
  assert.equal(a4.work_status, 'draft');
  assert.equal(a4.kind, 'activity');
  assert.equal(nodeOf(state, 'w1').children.length, 2);
});

test('born confirmed: remove-then-set in ONE delta cannot resurrect a confirmation', () => {
  // The snapshot is what makes an id count as pre-existing. Taken once before
  // the loop, a `remove` followed by a `set` of the same id walked straight past
  // the guard: the tree lost the node she confirmed and gained content she never
  // saw, wearing her badge.
  const { state, violations } = applyPlanDelta(COURSE(), [
    { op: 'remove', id: 'a1' },
    { op: 'set', id: 'a1', parent_id: 'w1', node: { title: '孩子们发现龙舟桨是弯的', body: '全班都说桨弯了更好划', status: 'confirmed' } },
  ]);
  assert.equal(nodeOf(state, 'a1').status, 'ai_suggestion', '删掉再写回来的是新节点，新节点不能一出生就确认');
  assert.ok(kinds(violations).includes('born_confirmed'));
  assert.equal(nodeOf(state, 'a1').title, '孩子们发现龙舟桨是弯的', '降级出处，内容照常写入');
});

test('MUST PASS — a plain remove of a confirmed node behaves exactly as before', () => {
  const { state, violations } = applyPlanDelta(COURSE(), [{ op: 'remove', id: 'a1' }]);
  assert.deepEqual(violations, []);
  assert.equal(nodeOf(state, 'a1'), undefined);
  assert.equal(nodeOf(state, 'w1').children.length, 0);
});

// ---------- a confirmation covers the text she read ----------

test('a body rewrite on a confirmed node demotes it to pending_validation', () => {
  // The edited node is excluded from its own blast radius, so without this the
  // substitution keeps her badge AND carries no 待复查 stamp: 「孩子们已经掌握了
  // 龙舟结构」 reads as a fact she vouched for.
  const { state, violations } = applyPlanDelta(COURSE(), [
    { op: 'update', id: 'a1', node: { title: '孩子们已经掌握了龙舟结构', body: '全班都能说出龙骨、桨、鼓的作用' } },
  ]);
  assert.equal(nodeOf(state, 'a1').status, 'pending_validation', '模型提议，她重新确认');
  assert.deepEqual(kinds(violations), ['uncited_confirmation']);
  assert.equal(nodeOf(state, 'a1').body, '全班都能说出龙骨、桨、鼓的作用', '内容照常写入，只是出处退了一格');
});

test('MUST PASS — she can re-confirm the rewrite in the same op with her words', () => {
  const { state, violations } = applyPlanDelta(COURSE(), [
    { op: 'update', id: 'a1', node: { body: '先看船，再摸桨' }, confirmed_by_quote: '就按这个写' },
  ], { teacherText: '第一周就按这个写吧' });
  assert.deepEqual(violations, []);
  assert.equal(nodeOf(state, 'a1').status, 'confirmed');
});

test('MUST PASS — an already-confirmed node stays confirmed through an unrelated edit', () => {
  const { state, violations } = applyPlanDelta(COURSE(), [
    { op: 'update', id: 'a1', node: { title: '看一条真龙舟（改到周二）', dates: ['2026-09-22'] } },
  ]);
  assert.deepEqual(violations, []);
  assert.equal(nodeOf(state, 'a1').status, 'confirmed', '改标题不该动已确认的出处');
  assert.deepEqual(nodeOf(state, 'a1').dates, ['2026-09-22']);
});

// ---------- escalation needs her own words ----------

test('uncited escalation is stripped back to the status the node already had', () => {
  const { state, violations } = applyPlanDelta(COURSE(), [
    { op: 'update', id: 'w3', node: { status: 'confirmed', title: '周3 划起来' } },
  ]);
  assert.equal(nodeOf(state, 'w3').status, 'ai_suggestion', '「好的，我先看看」不是同意');
  assert.deepEqual(kinds(violations), ['uncited_confirmation']);
  assert.equal(violations[0].action, 'strip');
  assert.equal(nodeOf(state, 'w3').title, '周3 划起来', '只剥掉升级，不丢掉这次改动的其他内容');
});

test('uncited escalation: an empty or non-string quote is no quote at all', () => {
  for (const quote of ['', '   ', null, 42, true, {}]) {
    const { state, violations } = applyPlanDelta(COURSE(), [
      { op: 'update', id: 'a3', node: { status: 'confirmed' }, confirmed_by_quote: quote },
    ]);
    assert.equal(nodeOf(state, 'a3').status, 'hypothesis', `「${String(quote)}」不能当作教师原话`);
    assert.deepEqual(kinds(violations), ['uncited_confirmation']);
  }
});

test('MUST PASS — an escalation carrying her words goes through untouched', () => {
  const { state, violations } = applyPlanDelta(COURSE(), [
    { op: 'update', id: 'w3', node: { status: 'confirmed' }, confirmed_by_quote: '周3 就这样定了，不用再改' },
  ]);
  assert.deepEqual(violations, [], '有原话的确认必须原样通过——否则确认这条通道就没了');
  assert.equal(nodeOf(state, 'w3').status, 'confirmed');
  assert.equal(state.course_plan.revision_log.at(-1).op, 'update');
});

test('the quote is checked against what she actually typed, when we have it', () => {
  const said = '周3 就这样定了，不用再改';
  const honest = applyPlanDelta(COURSE(), [
    { op: 'update', id: 'w3', node: { status: 'confirmed' }, confirmed_by_quote: '就这样定了' },
  ], { teacherText: said });
  assert.deepEqual(honest.violations, [], '她真说过的话必须算数');
  assert.equal(nodeOf(honest.state, 'w3').status, 'confirmed');

  const invented = applyPlanDelta(COURSE(), [
    { op: 'update', id: 'w3', node: { status: 'confirmed' }, confirmed_by_quote: '我同意全部方案' },
  ], { teacherText: said });
  assert.deepEqual(kinds(invented.violations), ['uncited_confirmation'], '编出来的引用不是引用');
  assert.equal(nodeOf(invented.state, 'w3').status, 'ai_suggestion');
});

test('the quote survives different spacing, because whitespace is not evidence', () => {
  const { state, violations } = applyPlanDelta(COURSE(), [
    { op: 'update', id: 'w3', node: { status: 'confirmed' }, confirmed_by_quote: ' 就这样  定了 ' },
  ], { teacherText: '周3 就这样定了，不用再改' });
  assert.deepEqual(violations, []);
  assert.equal(nodeOf(state, 'w3').status, 'confirmed');
});

test('one quote confirms one node: a nested node cannot ride along on it', () => {
  const { state, violations } = applyPlanDelta(COURSE(), [{
    op: 'update',
    id: 'w3',
    node: { status: 'confirmed', children: [{ id: 'a3', title: '试划自己的船', status: 'confirmed' }] },
    confirmed_by_quote: '周3 就这样定了',
  }]);
  assert.equal(nodeOf(state, 'w3').status, 'confirmed', '她确认的那个节点确实升级了');
  assert.equal(nodeOf(state, 'a3').status, 'hypothesis', '同一句原话不能顺手确认子节点');
  assert.deepEqual(kinds(violations), ['uncited_confirmation']);
});

test('a borrowed id cannot smuggle a new node in as pre-confirmed', () => {
  // a1 is confirmed and lives under 周1. Re-using its id as a NEW child of 周3
  // would make the guard read it as already confirmed.
  const { state, violations } = applyPlanDelta(COURSE(), [{
    op: 'update',
    id: 'w3',
    node: { children: [{ id: 'a1', title: '冒名顶替', status: 'confirmed' }] },
  }]);
  assert.deepEqual(kinds(violations), ['plan_scope']);
  assert.equal(nodeOf(state, 'a1').title, '看一条真龙舟', '同一个 id 不能出现两次');
  assert.equal(nodeOf(state, 'w3').children.length, 1, '整条操作被剥掉');
  assert.equal(state.course_plan.version, 7);
});

test('set refuses an id that already exists rather than duplicating it', () => {
  const { state, violations } = applyPlanDelta(COURSE(), [
    { op: 'set', id: 'a2', parent_id: 'w1', node: { title: '第二个 a2' } },
  ]);
  assert.deepEqual(kinds(violations), ['plan_scope']);
  assert.equal([...walkPlan(state.course_plan)].filter(({ node }) => node.id === 'a2').length, 1);
});

// ---------- the engine owns staleness ----------

test('an applied update stamps the blast radius and nothing else', () => {
  const { state } = applyPlanDelta(COURSE(), [
    { op: 'update', id: 'w2', node: { title: '周2 龙舟与水（不下水）' }, reason: '周2 改成不下水' },
  ]);
  assert.equal(nodeOf(state, 'a2').stale_since, '8', '版本号由引擎盖章');
  assert.equal(nodeOf(state, 'a2').stale_reason, '周2 改成不下水');
  assert.equal(nodeOf(state, 'w3').stale_since, '8', '按引用挂在 a2 上的周3 也要复查');
  assert.equal(nodeOf(state, 'a3').stale_since, '8');
  for (const id of ['p1', 'w1', 'a1', 'w2']) {
    assert.equal(nodeOf(state, id).stale_since, undefined, `${id} 不该被牵连：不向上、不向旁支扩散`);
  }
});

test('the badge is never bare: an op with no reason still records one', () => {
  // 待复查 with nothing after it is a puzzle she has to solve before she can
  // judge it, and the turn that caused it will be out of the window by then.
  const { state } = applyPlanDelta(COURSE(), [{ op: 'update', id: 'w2', node: { title: '周2 龙舟与水（不下水）' } }]);
  assert.match(nodeOf(state, 'a2').stale_reason, /周2 龙舟与水/, '徽标要说清上游改了什么');
  const removed = applyPlanDelta(COURSE(), [{ op: 'remove', id: 'a2' }]).state;
  assert.match(nodeOf(removed, 'w3').stale_reason, /已删除/);
});

test('MUST PASS — marking never moves either status axis', () => {
  const { state } = applyPlanDelta(COURSE(), [
    { op: 'update', id: 'w2', node: { title: '周2 龙舟与水（不下水）' } },
  ]);
  assert.equal(nodeOf(state, 'a2').status, 'confirmed', '待复查不降级已确认');
  assert.equal(nodeOf(state, 'a2').work_status, 'settled', '待复查也不改工作状态');
  assert.equal(nodeOf(state, 'a3').status, 'hypothesis');
  const row = toSkeletonTSV(state.course_plan).split('\n').find((l) => l.startsWith('a2\t')).split('\t');
  assert.equal(row[SKELETON_COLUMNS.indexOf('status')], 'confirmed', '骨架表的出处列还是出处');
  assert.equal(row[SKELETON_COLUMNS.indexOf('stale')], 'stale@8');
});

test('a removal marks what rested on it, even though the node is gone', () => {
  const { state, violations } = applyPlanDelta(COURSE(), [
    { op: 'remove', id: 'a2', reason: '这个活动取消了' },
  ]);
  assert.deepEqual(violations, []);
  assert.equal(nodeOf(state, 'a2'), undefined);
  assert.equal(nodeOf(state, 'w3').stale_since, '8', '删掉的东西也会让下游失效');
  assert.equal(nodeOf(state, 'w3').stale_reason, '这个活动取消了');
  assert.equal(nodeOf(state, 'w2').children.length, 0);
  assert.equal(nodeOf(state, 'w1').stale_since, undefined);
});

test('the root of the plan is not removable', () => {
  const { state, violations } = applyPlanDelta(COURSE(), [{ op: 'remove', id: 'p1' }]);
  assert.deepEqual(kinds(violations), ['plan_scope']);
  assert.equal(nodeOf(state, 'p1').title, '东乡龙舟', '整棵计划不能被一条操作删掉');
});

test('MUST PASS — a node inserted this turn is not born stale', () => {
  const { state } = applyPlanDelta(COURSE(), [{
    op: 'set',
    id: 'w4',
    parent_id: 'p1',
    node: { title: '周4 龙舟赛', children: [{ id: 'a5', title: '办一场赛' }] },
  }]);
  assert.equal(nodeOf(state, 'w4').stale_since, undefined, '刚写下的节点不可能对自己过期');
  assert.equal(nodeOf(state, 'a5').stale_since, undefined);
  assert.equal(nodeOf(state, 'w1').stale_since, undefined, '新增一个周不该惊动其他的周');
});

test('the model cannot write or clear the staleness stamp itself', () => {
  const staled = applyPlanDelta(COURSE(), [{ op: 'update', id: 'w2', node: { title: '改了' }, reason: '上游改了' }]).state;
  assert.equal(nodeOf(staled, 'a2').stale_since, '8');
  const { state } = applyPlanDelta(staled, [
    { op: 'update', id: 'a2', node: { title: '做一条会浮的船', stale_since: '1', stale_reason: '我替她清掉了' } },
    { op: 'set', id: 'a6', parent_id: 'w1', node: { title: '装成待复查', stale_since: '99' } },
  ]);
  assert.equal(nodeOf(state, 'a2').stale_since, '8', '模型清不掉徽标——能清掉就能瞒着教师');
  assert.equal(nodeOf(state, 'a2').stale_reason, '上游改了');
  assert.equal(nodeOf(state, 'a6').stale_since, undefined, '也不能自己贴一个');
});

// ---------- version and revision log ----------

test('the engine owns the version: one bump per applied delta, never per op', () => {
  const { state } = applyPlanDelta(COURSE(), [
    { op: 'update', id: 'w2', node: { title: '一改' } },
    { op: 'update', id: 'w3', node: { title: '二改' } },
  ]);
  assert.equal(state.course_plan.version, 8);
  assert.deepEqual(state.course_plan.revision_log.map((r) => [r.v, r.op, r.node_id]), [
    [8, 'update', 'w2'], [8, 'update', 'w3'],
  ]);
  assert.equal(state.course_plan.revision_log[0].root_id, 'p1');
});

test('the version is monotonic across deltas and reads through a display string', () => {
  const once = applyPlanDelta(COURSE(), [{ op: 'update', id: 'w2', node: { title: '一改' } }]).state;
  const twice = applyPlanDelta(once, [{ op: 'update', id: 'w3', node: { title: '二改' } }]).state;
  assert.equal(twice.course_plan.version, 9);
  assert.equal(nodeOf(twice, 'a3').stale_since, '9', '她还没看过的那次改动才是要说的');
  assert.equal(twice.course_plan.revision_log.length, 2, '修订记录是累加的');

  // A model-written display version ('v7') must not send the counter backwards.
  const display = COURSE();
  display.course_plan.version = 'v7';
  const after = applyPlanDelta(display, [{ op: 'update', id: 'w2', node: { title: '一改' } }]).state;
  assert.equal(after.course_plan.version, 8);
});

// ---------- content discipline ----------

test('an update carrying empty children keeps the subtree it was not asked to delete', () => {
  const { state, violations } = applyPlanDelta(COURSE(), [
    { op: 'update', id: 'w2', node: { title: '周2 龙舟与水', children: [] } },
  ]);
  assert.equal(nodeOf(state, 'w2').children.length, 1, '顺手清空子节点是事故，不是编辑');
  assert.deepEqual(kinds(violations), ['plan_scope']);
  assert.equal(nodeOf(state, 'a2').title, '做一条会浮的船');
});

test('MUST PASS — replacing children with real content is a legal edit', () => {
  const { state, violations } = applyPlanDelta(COURSE(), [{
    op: 'update',
    id: 'w2',
    node: { children: [{ id: 'a2', title: '做一条会浮的船', status: 'confirmed' }, { id: 'a7', title: '试试哪种木头浮得住' }] },
  }]);
  assert.deepEqual(violations, [], 'a2 本来就是 confirmed，重述它不是升级');
  assert.deepEqual(nodeOf(state, 'w2').children.map((c) => c.id), ['a2', 'a7']);
  assert.equal(nodeOf(state, 'a7').status, 'ai_suggestion');
  assert.equal(nodeOf(state, 'a7').kind, 'activity');
});

test('fields the model invents are dropped; fields it omits survive', () => {
  const { state } = applyPlanDelta(COURSE(), [
    { op: 'update', id: 'a1', node: { title: '看一条真龙舟', sentiment: '很棒', 手写字段: 1 } },
  ]);
  const a1 = nodeOf(state, 'a1');
  assert.equal(a1.sentiment, undefined, '树的形状由 plan-tsv 说了算，不是模型');
  assert.equal(a1['手写字段'], undefined);
  assert.deepEqual(a1.dates, ['2026-09-21'], '没提到的字段原样留下');
  assert.equal(a1.status, 'confirmed');
});

test('an unknown provenance value degrades instead of entering the status column', () => {
  const { state } = applyPlanDelta(COURSE(), [
    { op: 'set', id: 'a8', parent_id: 'w1', node: { title: '新活动', status: '已确认' } },
  ]);
  assert.equal(nodeOf(state, 'a8').status, 'ai_suggestion', '看不懂的出处按最不可信的一档处理');
});

test('a plan can be born from a set op when the course has none yet', () => {
  const { state, violations } = applyPlanDelta(createInitialState('empty'), [
    { op: 'set', id: 'p1', node: { title: '东乡龙舟', status: 'confirmed' } },
  ]);
  assert.equal(nodeOf(state, 'p1').kind, 'phase');
  assert.equal(nodeOf(state, 'p1').status, 'ai_suggestion', '第一个节点同样不能一出生就确认');
  assert.deepEqual(kinds(violations), ['born_confirmed']);
  assert.equal(state.course_plan.version, 1);
  assert.equal(state.course_plan.revision_log[0].op, 'set');
});
