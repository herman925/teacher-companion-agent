// plan-view.test.mjs — the workbench's pure logic layer (Workflow v2, ADR-0010).
//
// Every rule here is tested in BOTH directions, because half of this module's
// job is to stay quiet. A receipt that appears when nothing was written, a
// 待确认 roll-up inflated by a badge that is not about provenance, a subject
// that keeps pointing at a deleted node — each of those is a screen telling the
// teacher something the record does not support, which is non-negotiable #1
// wearing a UI costume.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyPlanDelta } from '../src/engine.mjs';
import {
  COURSE_SUBJECT, RECENT_MAX, RECEIPT_KINDS, TALLY_STATUSES,
  planVersionNumber, planViewModel, visiblePlanNodes, toggleFold, foldSignature, planRenderKey,
  messageCountsBySubject, recentNodes, mergeRecent,
  summarizeTurnReceipt, receiptLine,
  normalizeSubject, isNodeSubject, resolveSubject, filterBySubject, nodeContext,
  stepZeroStatus, STEP_ZERO_ITEMS,
} from '../src/ui/plan-view.mjs';

/** One structurally complete course_state: 月计划 → 周计划 → dated 活动, with
 * both axes and a 待复查 stamp in play. 月计划 is a PHASE of several weeks, not
 * a calendar month, and a day is a DATE on an activity — there is no day level
 * anywhere in this fixture because there is no day kind. */
const STATE = {
  course_plan: {
    version: 3,
    revision_log: [
      { v: 1, root_id: 'p1', op: 'set', node_id: 'p1', parent_id: null },
      { v: 2, root_id: 'p1', op: 'set', node_id: 'w2', parent_id: 'p1' },
      { v: 3, root_id: 'p1', op: 'update', node_id: 'a2' },
    ],
    roots: [{
      id: 'p1', kind: 'phase', title: '东乡龙舟', status: 'confirmed', work_status: 'settled',
      children: [
        {
          id: 'w1', kind: 'week', title: '周1 认识龙舟', status: 'confirmed', work_status: 'settled',
          children: [
            { id: 'a1', kind: 'activity', title: '集体：看一条真龙舟', dates: ['2026-09-21'], status: 'confirmed', work_status: 'settled' },
            { id: 'a2', kind: 'activity', title: '小组：鼓点节奏游戏', dates: ['2026-09-22', '2026-09-23'], status: 'ai_suggestion', work_status: 'draft' },
          ],
        },
        {
          id: 'w2', kind: 'week', title: '周2 龙舟与水', status: 'ai_suggestion', work_status: 'adjusting',
          stale_since: '2', stale_reason: '周1 去掉划船动作经验',
          children: [
            { id: 'a3', kind: 'activity', title: '自主游戏：做一条会浮的船', status: 'hypothesis', work_status: 'draft' },
          ],
        },
      ],
    }],
  },
};

const rowOf = (model, id) => model.byId.get(id);

// ---------- view model ----------

test('view model: one row per node, in the tree order the panel draws', () => {
  const model = planViewModel(STATE);
  assert.deepEqual(model.nodes.map((n) => n.id), ['p1', 'w1', 'a1', 'a2', 'w2', 'a3']);
  assert.deepEqual(model.nodes.map((n) => n.number), ['1', '1.1', '1.1.1', '1.1.2', '1.2', '1.2.1']);
});

test('view model: only the three plan kinds exist — a day is a date, not a level', () => {
  const model = planViewModel(STATE);
  for (const n of model.nodes) {
    assert.ok(['phase', 'week', 'activity'].includes(n.kind), `不该出现第四种节点：${n.kind}`);
  }
  assert.deepEqual(rowOf(model, 'a2').dates, ['2026-09-22', '2026-09-23'], '跨两天的活动仍是一个节点');
  assert.deepEqual(rowOf(model, 'w1').dates, [], '周计划自己不带日期');
});

test('view model: the two axes stay two fields all the way out', () => {
  const model = planViewModel(STATE);
  const w2 = rowOf(model, 'w2');
  assert.equal(w2.status, 'ai_suggestion', '出处轴');
  assert.equal(w2.work_status, 'adjusting', '工作状态轴');
  assert.ok(!('axis' in w2) && !('state' in w2), '两条轴不合并成一个显示值');
});

test('view model: staleness is a flag with a reason, never a provenance change', () => {
  const model = planViewModel(STATE);
  const w2 = rowOf(model, 'w2');
  assert.equal(w2.stale, true);
  assert.equal(w2.staleReason, '周1 去掉划船动作经验', '徽标要说清上游改了什么');
  assert.equal(rowOf(model, 'a1').stale, false);
  assert.equal(rowOf(model, 'a1').staleReason, '');
});

test('view model: the tally counts the two axes in two separate groups', () => {
  const { tally } = planViewModel(STATE);
  assert.equal(tally.confirmed, 3);
  assert.equal(tally.ai_suggestion, 2);
  assert.equal(tally.hypothesis, 1);
  assert.equal(tally.teacher_preset, 0);
  assert.equal(tally.pending_validation, 0);
  assert.equal(tally.total, 6);
  assert.equal(tally.pending, 3, '待确认＝出处不是 confirmed 的节点数');
  assert.equal(tally.stale, 1, '待复查独立计数，不混进出处');
  assert.equal(tally.needs_review, 0);
  for (const s of TALLY_STATUSES) assert.equal(typeof tally[s], 'number', `${s} 必须有一格`);
});

test('view model: a roll-up counts descendants only, and only on the provenance axis', () => {
  const model = planViewModel(STATE);
  assert.equal(rowOf(model, 'w1').rollup.pending, 1, '周1 下面只有 a2 还没确认');
  assert.equal(rowOf(model, 'p1').rollup.pending, 3, '月计划把整棵子树的待确认加起来');
  assert.equal(rowOf(model, 'a1').rollup.pending, 0, '叶子节点不把自己算成一项');
});

test('view model: a stale but confirmed node does not inflate 待确认', () => {
  // 待复查 says 「上游动过，回来看一眼」; it never says 「这条没跟孩子核对过」.
  // If it leaked into the provenance roll-up, one upstream edit would make the
  // whole month look unverified.
  const staled = structuredClone(STATE);
  const a1 = staled.course_plan.roots[0].children[0].children[0];
  a1.stale_since = '4';
  a1.stale_reason = '周1 改了';
  const model = planViewModel(staled);
  assert.equal(rowOf(model, 'a1').stale, true);
  assert.equal(rowOf(model, 'w1').rollup.pending, 1, '已确认的节点被标待复查，待确认数不动');
  assert.equal(rowOf(model, 'w1').rollup.stale, 1, '待复查有自己的计数');
  assert.equal(model.tally.confirmed, 3, '出处计数同样不受影响');
});

test('view model: version reads the plan counter whether it is a number or a string', () => {
  assert.equal(planViewModel(STATE).version, 3);
  assert.equal(planViewModel(STATE).versionLabel, 'v0.3');
  assert.equal(planViewModel({ course_plan: { version: 'v0.7', roots: [] } }).version, 7);
  assert.equal(planVersionNumber(undefined), 0);
});

test('view model: an empty course yields no rows and says so — that is step zero', () => {
  for (const empty of [null, {}, { course_plan: null }, { course_plan: { roots: [] } }]) {
    const model = planViewModel(empty);
    assert.equal(model.hasPlan, false, '没有计划树时面板渲染第零步，而不是空树');
    assert.deepEqual(model.nodes, []);
    assert.equal(model.tally.total, 0);
  }
  assert.equal(planViewModel(STATE).hasPlan, true);
});

test('view model: message counts ride the row, and are absent rather than zero-badged', () => {
  const model = planViewModel(STATE, { messageCounts: { a2: 3, ghost: 9 } });
  assert.equal(rowOf(model, 'a2').messageCount, 3);
  assert.equal(rowOf(model, 'a1').messageCount, 0, '没人聊过的节点计数为 0，渲染层据此不画徽标');
});

test('view model: the open highlight comes from the caller, not from the tree', () => {
  const model = planViewModel(STATE, { openNodeId: 'a3' });
  assert.equal(rowOf(model, 'a3').open, true);
  assert.equal(rowOf(model, 'a2').open, false);
  assert.equal(rowOf(planViewModel(STATE), 'a3').open, false, '没打开任何节点时没有高亮');
});

// ---------- fold ----------

test('fold: a collapsed branch hides its subtree but keeps its own row', () => {
  const model = planViewModel(STATE, { folded: ['w1'] });
  const ids = visiblePlanNodes(model).map((n) => n.id);
  assert.deepEqual(ids, ['p1', 'w1', 'w2', 'a3']);
  assert.ok(ids.includes('w1'), '折叠的分支自己要留着——它才是那条待确认计数的落脚点');
});

test('fold: nothing collapsed shows everything, and a leaf id collapses nothing', () => {
  assert.equal(visiblePlanNodes(planViewModel(STATE)).length, 6);
  assert.equal(visiblePlanNodes(planViewModel(STATE, { folded: ['a1'] })).length, 6, '叶子没有子树可折');
  assert.equal(visiblePlanNodes(planViewModel(STATE, { folded: ['ghost'] })).length, 6);
});

test('fold: collapsing a phase hides the whole month, not just one level', () => {
  const ids = visiblePlanNodes(planViewModel(STATE, { folded: ['p1'] })).map((n) => n.id);
  assert.deepEqual(ids, ['p1']);
});

test('fold: toggle is pure and the id list stays sorted for a stable render key', () => {
  const before = ['w2'];
  const after = toggleFold(before, 'w1');
  assert.deepEqual(after, ['w1', 'w2']);
  assert.deepEqual(before, ['w2'], '折叠状态是纯函数，调用方拿到的是新数组');
  assert.deepEqual(toggleFold(after, 'w1'), ['w2'], '再点一次就展开');
  assert.deepEqual(toggleFold(after, 'w1', true), ['w1', 'w2'], '强制折叠是幂等的');
  assert.equal(foldSignature(['w2', 'w1']), foldSignature(['w1', 'w2']), '同一个形状必须给同一个签名');
});

// ---------- render key ----------
//
// The old blueprint panel memoized on courseId:version:tab and simply did not
// repaint when a badge changed. Each of these asserts one thing that must move
// the key, and the last one asserts the key does NOT churn when nothing changed.

test('render key: repaints when the open node moves', () => {
  const a = planRenderKey(planViewModel(STATE, { openNodeId: 'a2' }), { openNodeId: 'a2' });
  const b = planRenderKey(planViewModel(STATE, { openNodeId: 'a3' }), { openNodeId: 'a3' });
  assert.notEqual(a, b, '高亮换了节点，面板必须重画');
});

test('render key: repaints when a message count, a badge or the view changes', () => {
  const base = planRenderKey(planViewModel(STATE));
  assert.notEqual(base, planRenderKey(planViewModel(STATE, { messageCounts: { a2: 1 } })), '消息计数徽标');
  assert.notEqual(base, planRenderKey(planViewModel(STATE, { folded: ['w1'] })), '折叠形状');
  assert.notEqual(base, planRenderKey(planViewModel(STATE), { view: 'map' }), '列表与导图是两种画法');

  const staled = structuredClone(STATE);
  staled.course_plan.roots[0].children[0].stale_since = '4';
  assert.notEqual(base, planRenderKey(planViewModel(staled)), '待复查徽标');

  const moved = structuredClone(STATE);
  moved.course_plan.roots[0].children[0].work_status = 'needs_review';
  assert.notEqual(base, planRenderKey(planViewModel(moved)), '工作状态徽标');
});

test('render key: identical state gives an identical key — memoizing still works', () => {
  const opts = { messageCounts: { a2: 2 }, folded: ['w2'], openNodeId: 'a1' };
  assert.equal(
    planRenderKey(planViewModel(STATE, opts), { view: 'list', openNodeId: 'a1' }),
    planRenderKey(planViewModel(structuredClone(STATE), opts), { view: 'list', openNodeId: 'a1' }),
    '什么都没变就不该重画',
  );
});

// ---------- message counts ----------

test('message counts: tallied per subject, with untagged rows reading as course-level', () => {
  const counts = messageCountsBySubject([
    { subject: 'a2' }, { subject: 'a2' }, { subject: 'course' }, {}, { subject: '  ' },
  ]);
  assert.equal(counts.a2, 2);
  assert.equal(counts[COURSE_SUBJECT], 3, '没有 subject 的老消息算整门课的，不需要迁移');
  assert.equal(counts.a1, undefined, '没聊过的节点根本不在表里');
});

test('message counts: an empty or missing log counts nothing rather than throwing', () => {
  assert.deepEqual(messageCountsBySubject([]), {});
  assert.deepEqual(messageCountsBySubject(null), {});
});

// ---------- 最近处理 ----------

test('recent: newest first, deduped, straight out of the revision log', () => {
  const recent = recentNodes(STATE.course_plan);
  assert.deepEqual(recent.map((r) => r.id), ['a2', 'w2', 'p1'], '最后动过的排最前');
  assert.equal(recent[0].number, '1.1.2', '芯片显示的是面板上的编号');
  assert.equal(recent[0].title, '小组：鼓点节奏游戏');
  assert.equal(recent[0].v, 3);
});

test('recent: a node that no longer exists is dropped, not shown as a dead chip', () => {
  const plan = structuredClone(STATE.course_plan);
  plan.revision_log.push({ v: 4, root_id: 'p1', op: 'remove', node_id: 'a3' });
  plan.roots[0].children[1].children = [];
  assert.ok(!recentNodes(plan).some((r) => r.id === 'a3'), '点开是空的芯片比短一点的条子更糟');
  assert.deepEqual(recentNodes(plan).map((r) => r.id), ['a2', 'w2', 'p1']);
});

test('recent: no revision log means no strip — no 「还没有记录」 furniture', () => {
  assert.deepEqual(recentNodes({ roots: [] }), []);
  assert.deepEqual(recentNodes(null), []);
});

test('recent: the strip is capped, and the cap is the panel-row default', () => {
  const plan = structuredClone(STATE.course_plan);
  const ids = ['p1', 'w1', 'a1', 'a2', 'w2', 'a3'];
  for (let i = 0; i < 20; i += 1) plan.revision_log.push({ v: 4 + i, op: 'update', node_id: ids[i % ids.length] });
  assert.ok(recentNodes(plan).length <= RECENT_MAX);
  assert.equal(recentNodes(plan, { limit: 2 }).length, 2);
});

test('recent: opening a node pushes it to the front without duplicating it', () => {
  const start = [{ id: 'a2', title: '鼓点' }, { id: 'w2', title: '周2' }];
  const after = mergeRecent(start, { id: 'w2', title: '周2', at: '2026-08-12T09:00:00Z' });
  assert.deepEqual(after.map((e) => e.id), ['w2', 'a2'], '再打开一次是提前，不是多一条');
  assert.deepEqual(start.map((e) => e.id), ['a2', 'w2'], '合并是纯函数');
  assert.equal(after[0].at, '2026-08-12T09:00:00Z', '时间戳由调用方盖章——这个模块没有时钟');
  assert.equal(mergeRecent(start, {}).length, 2, '没有 id 的条目不进条子');
});

// ---------- receipts ----------
//
// The silent half matters more than the loud half: a line invented for a turn
// that wrote nothing tells the teacher the agent recorded something it did not.

test('receipt: a turn that only talked produces no line at all', () => {
  assert.equal(summarizeTurnReceipt(STATE, structuredClone(STATE)), null, '什么都没写，就不该有回执');
  assert.equal(summarizeTurnReceipt({}, {}), null);
  assert.equal(receiptLine(null), '');
});

test('receipt: an op the engine stripped leaves no trace', () => {
  const { state, violations } = applyPlanDelta(STATE, [{ op: 'update', id: 'ghost', node: { title: '并不存在' } }]);
  assert.ok(violations.length, '引擎确实拒绝了它');
  assert.equal(summarizeTurnReceipt(STATE, state), null, '模型提了、引擎没写，回执就该沉默');
});

test('receipt: an applied edit names the node by its panel number', () => {
  const { state } = applyPlanDelta(STATE, [{ op: 'update', id: 'a2', node: { title: '小组：换成拍手节奏' } }]);
  const receipt = summarizeTurnReceipt(STATE, state, { id: 'r1', at: '2026-08-12T09:00:00Z', turnIndex: 4 });
  assert.deepEqual(receipt.parts.map((p) => p.kind), ['edit']);
  assert.deepEqual(receipt.parts[0].node_ids, ['a2']);
  assert.equal(receiptLine(receipt), '1.1.2 已改');
  assert.equal(receipt.id, 'r1');
  assert.equal(receipt.at, '2026-08-12T09:00:00Z', '时间戳由调用方给，模块自己不读时钟');
  assert.equal(receipt.turn_index, 4);
  assert.equal(receipt.undone, false);
});

test('receipt: a citation-backed confirmation reports both what was vouched for and what moved', () => {
  const { state } = applyPlanDelta(
    STATE,
    [{ op: 'update', id: 'a2', node: { status: 'confirmed' }, confirmed_by_quote: '就用鼓点这个' }],
    { teacherText: '就用鼓点这个，别改了' },
  );
  const receipt = summarizeTurnReceipt(STATE, state);
  assert.deepEqual(receipt.parts.map((p) => p.kind), ['confirm', 'edit']);
  assert.equal(receiptLine(receipt), '已确认 1 处 · 1.1.2 已改');
  assert.deepEqual(receipt.parts[0].node_ids, ['a2']);
});

test('receipt: an uncited confirmation is not reported as one', () => {
  // 引擎把它退回原出处（uncited_confirmation）。回执读的是引擎写下的树，
  // 不是模型说过的话，所以这里必须只剩下「改过」，没有「已确认」。
  const { state, violations } = applyPlanDelta(
    STATE,
    [{ op: 'update', id: 'a2', node: { status: 'confirmed', title: '小组：鼓点节奏游戏' } }],
    { teacherText: '嗯，我先看看' },
  );
  assert.ok(violations.some((v) => v.kind === 'uncited_confirmation'));
  const receipt = summarizeTurnReceipt(STATE, state);
  assert.ok(!receipt.parts.some((p) => p.kind === 'confirm'), '没有教师原话就不能写成「已确认」');
  assert.equal(receiptLine(receipt), '1.1.2 已改');
});

test('receipt: a node that did not exist before this turn is never reported as confirmed', () => {
  // 引擎已经禁止「一出生就 confirmed」。万一它还是出现了，诚实的回执是沉默，
  // 而不是替一个她从没见过的节点宣称「已确认 1 处」。
  const after = structuredClone(STATE);
  after.course_plan.roots[0].children[1].children.push({
    id: 'a9', kind: 'activity', title: '新活动', status: 'confirmed', work_status: 'draft',
  });
  const receipt = summarizeTurnReceipt(STATE, after);
  assert.equal(receipt, null, '新节点的 confirmed 不算一次确认');
});

test('receipt: several edits collapse into a count rather than a list of numbers', () => {
  const { state } = applyPlanDelta(STATE, [
    { op: 'update', id: 'a2', node: { title: '改一' } },
    { op: 'update', id: 'a3', node: { title: '改二' } },
  ]);
  const receipt = summarizeTurnReceipt(STATE, state);
  assert.equal(receiptLine(receipt), '2 处已改');
  assert.equal(receipt.parts[0].count, 2);
});

test('receipt: remembered facts are counted from the store, not from the reply text', () => {
  const receipt = summarizeTurnReceipt(STATE, STATE, {
    factsBefore: [{ id: 'f1' }],
    factsAfter: [{ id: 'f1' }, { id: 'f2' }],
  });
  assert.equal(receiptLine(receipt), '记住了 1 条');
  assert.deepEqual(receipt.parts[0].node_ids, [], '记忆条目不是计划节点');
  assert.equal(
    summarizeTurnReceipt(STATE, STATE, { factsBefore: [{ id: 'f1' }], factsAfter: [{ id: 'f1' }] }),
    null,
    '记忆没变就不该说记住了',
  );
});

test('receipt: the parts read in the contract order', () => {
  const { state } = applyPlanDelta(
    STATE,
    [{ op: 'update', id: 'a2', node: { status: 'confirmed' }, confirmed_by_quote: '就用鼓点这个' }],
    { teacherText: '就用鼓点这个' },
  );
  const receipt = summarizeTurnReceipt(STATE, state, { factsBefore: [], factsAfter: [{ id: 'f1' }] });
  assert.deepEqual(receipt.parts.map((p) => p.kind), ['memory', 'confirm', 'edit']);
  assert.equal(receiptLine(receipt), '记住了 1 条 · 已确认 1 处 · 1.1.2 已改');
  for (const p of receipt.parts) assert.ok(RECEIPT_KINDS.includes(p.kind));
});

// ---------- subjects ----------
//
// One subject-tagged log per course; a node conversation is a filtered VIEW of
// it. The client never sent a subject before this module existed, so every row
// was course-level and node mode had nothing to filter on.

test('subject: anything unusable reads as course-level, which is why there is no migration', () => {
  for (const raw of [undefined, null, '', '   ', 42, {}]) {
    assert.equal(normalizeSubject(raw), COURSE_SUBJECT, `「${String(raw)}」应当读作整门课`);
  }
  assert.equal(normalizeSubject('  a2  '), 'a2');
  assert.equal(normalizeSubject('a\n2'), 'a 2', '换行压成空格，不改变长度判断');
  assert.equal(normalizeSubject('x'.repeat(300)).length, 120, 'subject 是节点 id，不是正文');
});

test('subject: only a node id counts as a node subject', () => {
  assert.equal(isNodeSubject('a2'), true);
  assert.equal(isNodeSubject(COURSE_SUBJECT), false);
  assert.equal(isNodeSubject(''), false);
});

test('subject: an existing node resolves to itself', () => {
  assert.equal(resolveSubject('a3', STATE.course_plan), 'a3');
  assert.equal(resolveSubject(' a3 ', STATE.course_plan), 'a3');
});

test('subject: a deleted node falls back to the course rather than filtering to nothing', () => {
  assert.equal(resolveSubject('a9', STATE.course_plan), COURSE_SUBJECT, '指向不存在的节点就退回整门课');
  assert.equal(resolveSubject('a3', { roots: [] }), COURSE_SUBJECT);
  assert.equal(resolveSubject('a3', null), COURSE_SUBJECT);
  assert.equal(resolveSubject(COURSE_SUBJECT, STATE.course_plan), COURSE_SUBJECT);
});

const LOG = [
  { id: 1, role: 'user', content: '这门课怎么开始' },
  { id: 2, role: 'assistant', content: '先说说班里的情况' },
  { id: 3, role: 'user', content: '这个活动改成拍手', subject: 'a2' },
  { id: 4, role: 'assistant', content: '好，改成拍手节奏', subject: 'a2' },
  { id: 5, role: 'user', content: '周2 再想想', subject: 'w2' },
];

test('subject: a node view shows only that node, in the one log order', () => {
  const view = filterBySubject(LOG, 'a2');
  assert.deepEqual(view.map((m) => m.id), [3, 4]);
  assert.deepEqual(filterBySubject(LOG, 'w2').map((m) => m.id), [5]);
  assert.deepEqual(filterBySubject(LOG, 'a9'), [], '没聊过的节点是空的对话，不是整门课');
});

test('subject: the course view is the WHOLE log, not the rows tagged course', () => {
  // 返回整门课的对话 replays everything. Filtering it down to literally-tagged
  // rows would hide inside-a-node conversation from the one place meant to show
  // the whole course.
  assert.deepEqual(filterBySubject(LOG, COURSE_SUBJECT).map((m) => m.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(filterBySubject(LOG, undefined).map((m) => m.id), [1, 2, 3, 4, 5]);
  assert.notEqual(filterBySubject(LOG, COURSE_SUBJECT), LOG, '返回的是新数组，不是原始记录');
});

// ---------- node context ----------

test('node context: the ancestor chain is the minimum context a node view shows', () => {
  const ctx = nodeContext(STATE.course_plan, 'a3');
  assert.equal(ctx.number, '1.2.1');
  assert.equal(ctx.node.title, '自主游戏：做一条会浮的船');
  assert.deepEqual(ctx.ancestors.map((a) => `${a.number} ${a.title}`), ['1 东乡龙舟', '1.2 周2 龙舟与水']);
});

test('node context: an unknown node returns null, never an empty shell', () => {
  assert.equal(nodeContext(STATE.course_plan, 'a9'), null, '空壳会渲染成一个没有标题的节点，读起来像数据丢了');
  assert.equal(nodeContext(null, 'a3'), null);
  assert.deepEqual(nodeContext(STATE.course_plan, 'p1').ancestors, [], '根节点没有祖先，但它自己存在');
});


// ---------- step zero: 已知 must mean the TEACHER said it ----------
//
// The live checklist is the one surface whose whole job is telling her honestly
// what the agent has and has not heard. `teacher_resource_intent` carries
// `confidence(teacher_stated|agent_proposed_pending)` for exactly this reason,
// so a row sourced from it is 已知 only on her word. Both directions: a stated
// intent must still show, or the rule stops being a guard and becomes a wall.

test('step zero: an agent proposal she never answered is 待聊, not 已知', () => {
  const proposed = stepZeroStatus({
    teacher_resource_intent: {
      why_this_resource: '想让孩子理解本土文化',
      hoped_feeling: '孩子敢自己动手',
      confidence: 'agent_proposed_pending',
    },
    // The model's derived pedagogical core is NOT her stated 教育期待 and must
    // never stand in for one — that flipped the row to 已知 with nothing said.
    goals_assessment_axis: { core_understanding: '醒狮是社区共同的事' },
  });
  const by = new Map(proposed.items.map((i) => [i.key, i]));
  assert.equal(by.get('why_this_theme').known, false);
  assert.equal(by.get('why_this_theme').value, '', '没确认的话连值都不显示');
  assert.equal(by.get('expectation').known, false);
});

test('step zero: a missing confidence is treated as not-hers', () => {
  const silent = stepZeroStatus({ teacher_resource_intent: { why_this_resource: '园里想做本土文化' } });
  assert.equal(silent.items.find((i) => i.key === 'why_this_theme').known, false,
    '模型漏写 confidence 时，诚实的默认是「待聊」');
});

test('step zero: what she actually said shows, with her own words', () => {
  const known = stepZeroStatus({
    class_profile: { age_band: '中班', experience_base: '端午看过巡游' },
    theme_resource: { name: '龙舟', available_scenes: ['村口河涌', '祠堂'], expected_duration: '四周' },
    teacher_resource_intent: {
      why_this_resource: '孩子自己问起来的',
      hoped_feeling: '他们能讲给家里人听',
      confidence: 'teacher_stated',
    },
  });
  const by = new Map(known.items.map((i) => [i.key, i]));
  assert.equal(by.get('age_group').value, '中班');
  assert.equal(by.get('prior_experience').known, true);
  assert.equal(by.get('why_this_theme').value, '孩子自己问起来的');
  assert.equal(by.get('expectation').value, '他们能讲给家里人听');
  assert.equal(by.get('duration').value, '四周');
  assert.equal(by.get('resources').value, '龙舟 · 村口河涌、祠堂');
  assert.ok(known.items.every((i) => i.known), '六项都说过就是六项都已知');
});

test('step zero: an empty state invents nothing and still returns every row', () => {
  const empty = stepZeroStatus(null);
  assert.equal(empty.items.length, STEP_ZERO_ITEMS.length);
  assert.ok(empty.items.every((i) => i.known === false && i.value === ''));
});
