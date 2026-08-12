// plan-tsv.test.mjs — the course_plan tree and its skeleton wire format.
//
// Round-trip equality is a TEST here, not an assumption: a shifted column in
// this table would parse successfully with wrong values, and one of the columns
// is provenance. `hypothesis` silently becoming `confirmed` is the failure
// non-negotiable #1 exists to stop, so it gets a test rather than a comment.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SKELETON_COLUMNS, SKELETON_VERSION, EMPTY, CLEARING_ACTS,
  normalizePlan, walkPlan, numberPlan, ancestorsOf,
  toSkeletonTSV, parseSkeletonTSV,
  blastRadius, markStale, markNeedsReview, clearStale, retireStale,
} from '../src/plan-tsv.mjs';

/** A small but structurally complete course: phase → weeks → dated activities. */
const COURSE = {
  version: 'v0.3',
  roots: [{
    id: 'p1', kind: 'phase', title: '东乡龙舟', status: 'confirmed', work_status: 'settled',
    children: [
      {
        id: 'w1', kind: 'week', title: '周1 认识龙舟', status: 'confirmed',
        children: [
          { id: 'a1', kind: 'activity', title: '集体：看一条真龙舟', dates: ['2026-09-21'], org_type: '集体教学', status: 'confirmed', work_status: 'settled' },
          { id: 'a2', kind: 'activity', title: '小组：鼓点节奏游戏', dates: ['2026-09-22', '2026-09-23'], status: 'ai_suggestion' },
        ],
      },
      {
        id: 'w2', kind: 'week', title: '周2 龙舟与水', status: 'ai_suggestion',
        stale_since: '7', stale_reason: '周1 去掉划船动作经验',
        children: [
          { id: 'a3', kind: 'activity', title: '自主游戏：做一条会浮的船', status: 'hypothesis', work_status: 'adjusting' },
        ],
      },
    ],
  }],
};

// ---------- normalize ----------

test('normalize: infers kind from depth and fills safe defaults', () => {
  const p = normalizePlan({ roots: [{ title: '龙舟', children: [{ title: '周1', children: [{ title: '活动' }] }] }] });
  const kinds = [...walkPlan(p)].map(({ node }) => node.kind);
  assert.deepEqual(kinds, ['phase', 'week', 'activity']);
  const [root] = p.roots;
  assert.equal(root.status, 'ai_suggestion', '出处默认最不可信的一档');
  assert.equal(root.work_status, 'draft');
  assert.ok(root.id, '缺 id 时按路径生成');
});

test('normalize: rejects unknown statuses rather than passing them through', () => {
  const p = normalizePlan({ roots: [{ title: 'x', status: 'totally_confirmed', work_status: 'done' }] });
  assert.equal(p.roots[0].status, 'ai_suggestion');
  assert.equal(p.roots[0].work_status, 'draft');
});

test('normalize: duplicate ids are made unique, never merged', () => {
  const p = normalizePlan({ roots: [{ id: 'x', title: 'a' }, { id: 'x', title: 'b' }] });
  assert.notEqual(p.roots[0].id, p.roots[1].id);
  assert.equal(p.roots[1].id, 'x-dup');
});

test('normalize: staleness never touches provenance', () => {
  const p = normalizePlan({ roots: [{ id: 'w', title: 'w', status: 'confirmed', stale_since: '7' }] });
  assert.equal(p.roots[0].status, 'confirmed', '待复查不降级已确认');
  assert.equal(p.roots[0].stale_since, '7');
});

// `summary` is what an ancestor contributes to a descendant's focus band
// (prompt-builder.ancestorSummary). normalizePlan rebuilds every node from a
// fixed field list and applyPlanDelta pushes incoming nodes through it, so a
// dropped `summary` meant every ancestor arrived as 「（尚无摘要）」 forever —
// the model promised context it could never be given.
test('normalize: keeps summary, and stays absent when nothing wrote one', () => {
  const p = normalizePlan({ roots: [
    { id: 'p1', title: '龙舟', summary: '一个月围绕真龙舟展开' },
    { id: 'p2', title: '趁墟' },
  ] });
  assert.equal(p.roots[0].summary, '一个月围绕真龙舟展开');
  assert.ok(!('summary' in p.roots[1]), '没写过摘要就不该凭空长一个');
});

// ---------- tree helpers ----------

test('walk: depth-first, parents before children, stable order', () => {
  const ids = [...walkPlan(normalizePlan(COURSE))].map(({ node }) => node.id);
  assert.deepEqual(ids, ['p1', 'w1', 'a1', 'a2', 'w2', 'a3']);
});

test('number: display numbers are computed here, never stored', () => {
  const nums = numberPlan(normalizePlan(COURSE));
  assert.equal(nums.get('p1'), '1');
  assert.equal(nums.get('w2'), '1.2');
  assert.equal(nums.get('a3'), '1.2.1');
});

test('ancestors: the minimum context set for a node turn', () => {
  // Revising a3 seeds the model with 周2 and the 月计划 — and nothing else.
  const chain = ancestorsOf(normalizePlan(COURSE), 'a3').map((n) => n.id);
  assert.deepEqual(chain, ['p1', 'w2']);
  assert.deepEqual(ancestorsOf(normalizePlan(COURSE), 'p1'), []);
  assert.deepEqual(ancestorsOf(normalizePlan(COURSE), 'nope'), []);
});

// ---------- skeleton shape ----------

test('skeleton: header carries the version and the exact column order', () => {
  const lines = toSkeletonTSV(COURSE).split('\n');
  assert.ok(lines[0].startsWith('# plan-skeleton '), '第一行是版本标记');
  assert.ok(lines[0].includes(SKELETON_VERSION));
  assert.deepEqual(lines[1].split('\t'), SKELETON_COLUMNS);
});

test('skeleton: never emits an empty cell', () => {
  const rows = toSkeletonTSV(COURSE).split('\n').slice(2);
  for (const row of rows) {
    const cells = row.split('\t');
    assert.equal(cells.length, SKELETON_COLUMNS.length, `列数必须固定：${row}`);
    for (const c of cells) assert.ok(c.length > 0, `空格子会让模型串列：${row}`);
  }
});

test('skeleton: bodies never reach the table', () => {
  const withBody = { roots: [{ id: 'x', title: '短标题', body: '这是很长的活动正文，绝对不能进骨架表'.repeat(20) }] };
  const tsv = toSkeletonTSV(withBody);
  assert.ok(!tsv.includes('活动正文'), '正文走焦点带，不走骨架');
  assert.ok(tsv.includes('短标题'));
});

test('skeleton: a date range stays one row, not two nodes', () => {
  const tsv = toSkeletonTSV(COURSE);
  const row = tsv.split('\n').find((l) => l.startsWith('a2\t'));
  assert.match(row, /2026-09-22~2026-09-23/);
});

test('skeleton: staleness is visible, and marked as a flag not a status', () => {
  const row = toSkeletonTSV(COURSE).split('\n').find((l) => l.startsWith('w2\t'));
  assert.match(row, /stale@7/);
  assert.match(row, /ai_suggestion/, '出处列仍然是出处');
});

// ---------- round trip ----------

test('round trip: tree survives the table', () => {
  const before = normalizePlan(COURSE);
  const after = parseSkeletonTSV(toSkeletonTSV(before));
  const shape = (p) => [...walkPlan(p)].map(({ node, parentId, depth }) => ({
    id: node.id, parentId, depth, kind: node.kind, title: node.title,
    status: node.status, work_status: node.work_status,
    dates: node.dates ?? [], stale: node.stale_since ?? '',
  }));
  assert.deepEqual(shape(after), shape(before));
});

test('round trip: a tab or newline in a title cannot break alignment', () => {
  const nasty = { roots: [{ id: 'x', kind: 'phase', title: '龙\t舟\n主题', children: [{ id: 'y', kind: 'week', title: 'ok' }] }] };
  const tsv = toSkeletonTSV(nasty);
  for (const row of tsv.split('\n').slice(2)) {
    assert.equal(row.split('\t').length, SKELETON_COLUMNS.length);
  }
  const back = parseSkeletonTSV(tsv);
  assert.equal(back.roots.length, 1, '仍然只有一个根');
  assert.equal(back.roots[0].children.length, 1);
  assert.equal(back.roots[0].title, '龙 舟 主题', '制表符被压成空格，不是被丢掉');
});

test('round trip: provenance values survive exactly — the reason this test exists', () => {
  const before = normalizePlan(COURSE);
  const after = parseSkeletonTSV(toSkeletonTSV(before));
  const statusOf = (p, id) => [...walkPlan(p)].find(({ node }) => node.id === id).node.status;
  assert.equal(statusOf(after, 'a3'), 'hypothesis', 'hypothesis 绝不能变成 confirmed');
  assert.equal(statusOf(after, 'a1'), 'confirmed');
  assert.equal(statusOf(after, 'a2'), 'ai_suggestion');
});

test('parse: an unknown parent attaches at root rather than vanishing', () => {
  const tsv = [
    `# plan-skeleton ${SKELETON_VERSION}`,
    SKELETON_COLUMNS.join('\t'),
    ['orphan', 'ghost', 'activity', '孤儿活动', EMPTY, 'ai_suggestion', 'draft', EMPTY].join('\t'),
  ].join('\n');
  const p = parseSkeletonTSV(tsv);
  assert.equal(p.roots.length, 1, '丢节点比放错位置更糟');
  assert.equal(p.roots[0].id, 'orphan');
});

test('parse: empty and comment-only input yield an empty plan, not a throw', () => {
  assert.deepEqual(parseSkeletonTSV(''), { version: 'v0.1', roots: [] });
  assert.deepEqual(parseSkeletonTSV('# plan-skeleton v1'), { version: 'v0.1', roots: [] });
});

test('parse: a header with no id column fails loudly', () => {
  assert.throws(() => parseSkeletonTSV('kind\ttitle\nactivity\tx'), /no id column/);
});

// ---------- change propagation ----------
//
// Every test here has a must-pass half: the node that MUST come out untouched
// matters more than the node that gets flagged. A propagation rule that marks
// the whole tree is indistinguishable from no rule at all — she stops reading
// the badges — and one that quietly moves provenance is the failure
// non-negotiable #1 exists to stop.

/** 周3 derives from 周2's boat activity, so an edit to 周2 reaches it sideways
 * through blueprint_refs rather than down the tree. Dates run past 周3 so
 * retirement has something to bite on.
 *
 * Normalized on the way in: propagation acts on the tree the engine holds, and
 * preserves what it does not touch rather than re-deriving it. */
const LINKED = normalizePlan({
  version: 'v7',
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
        id: 'w3', kind: 'week', title: '周3 划起来', status: 'ai_suggestion', blueprint_refs: ['a2'],
        children: [
          { id: 'a3', kind: 'activity', title: '试划自己的船', dates: ['2026-10-05'], status: 'hypothesis' },
        ],
      },
    ],
  }],
});

const nodeOf = (plan, id) => [...walkPlan(plan)].find(({ node }) => node.id === id)?.node;

test('blast radius: descendants and reference followers, never the edited node', () => {
  // 周2 changed. 周3 rests on it by reference, so 周3's own activity moves too.
  assert.deepEqual(blastRadius(LINKED, 'w2'), ['a2', 'w3', 'a3']);
});

test('blast radius: an unrelated branch and every ancestor stay outside it', () => {
  const hit = blastRadius(LINKED, 'w2');
  for (const id of ['p1', 'w1', 'a1', 'w2']) {
    assert.ok(!hit.includes(id), `${id} 不该被牵连：改动不向上、不向旁支扩散`);
  }
});

test('blast radius: an unknown node reaches nothing rather than everything', () => {
  assert.deepEqual(blastRadius(LINKED, 'ghost'), []);
  assert.deepEqual(blastRadius({ roots: [] }, 'p1'), []);
});

test('mark stale: stamps the radius and leaves provenance exactly where it was', () => {
  const after = markStale(LINKED, 'w2', { version: '8', reason: '周2 改成不下水' });
  const a2 = nodeOf(after, 'a2');
  assert.equal(a2.stale_since, '8');
  assert.equal(a2.stale_reason, '周2 改成不下水', '徽标要说清上游改了什么');
  assert.equal(a2.status, 'confirmed', '待复查不降级已确认的出处');
  assert.equal(a2.work_status, 'settled', '待复查也不改工作状态');
  assert.equal(nodeOf(after, 'a3').status, 'hypothesis', 'hypothesis 也不会被顺手改动');
});

test('mark stale: a node outside the radius keeps a clean record', () => {
  const after = markStale(LINKED, 'w2', { version: '8', reason: '周2 改成不下水' });
  for (const id of ['p1', 'w1', 'a1', 'w2']) {
    assert.equal(nodeOf(after, id).stale_since, undefined, `${id} 不该被标记`);
    assert.equal(nodeOf(after, id).stale_reason, undefined);
  }
});

test('mark stale: version falls back to the plan version, not to a placeholder', () => {
  const after = markStale(LINKED, 'w2', { reason: '周2 改成不下水' });
  assert.equal(nodeOf(after, 'a2').stale_since, 'v7');
});

test('mark stale: a newer upstream change replaces the older stamp', () => {
  const once = markStale(LINKED, 'w2', { version: '8', reason: '周2 改成不下水' });
  const twice = markStale(once, 'p1', { version: '9', reason: '整个月计划改成秋季' });
  assert.equal(nodeOf(twice, 'a2').stale_since, '9');
  assert.equal(nodeOf(twice, 'a2').stale_reason, '整个月计划改成秋季', '她没看过的那次改动才是要说的');
});

test('mark stale: the input plan is not modified', () => {
  const before = structuredClone(LINKED);
  markStale(LINKED, 'w2', { version: '8', reason: '周2 改成不下水' });
  markNeedsReview(LINKED, 'a3');
  clearStale(LINKED, 'a2', 'edited');
  retireStale(LINKED, '2026-12-01');
  assert.deepEqual(LINKED, before, '传播是纯函数，调用方拿到的是新树');
});

test('mark stale: the skeleton shows the flag without moving the status column', () => {
  const after = markStale(LINKED, 'w2', { version: '8', reason: '周2 改成不下水' });
  const row = toSkeletonTSV(after).split('\n').find((l) => l.startsWith('a2\t')).split('\t');
  assert.equal(row[SKELETON_COLUMNS.indexOf('stale')], 'stale@8');
  assert.equal(row[SKELETON_COLUMNS.indexOf('status')], 'confirmed');
});

test('needs review: ancestors are flagged on the work axis only', () => {
  const after = markNeedsReview(LINKED, 'a3');
  assert.equal(nodeOf(after, 'p1').work_status, 'needs_review', '月计划不能继续宣称周计划已经不产出的结果');
  assert.equal(nodeOf(after, 'w3').work_status, 'needs_review');
  assert.equal(nodeOf(after, 'p1').status, 'confirmed', '向上标记同样不动出处');
});

test('needs review: siblings and the edited node itself are left alone', () => {
  const after = markNeedsReview(LINKED, 'a3');
  assert.equal(nodeOf(after, 'w1').work_status, 'settled');
  assert.equal(nodeOf(after, 'w2').work_status, 'settled');
  assert.equal(nodeOf(after, 'a3').work_status, 'draft', '被改的那个节点不需要复查自己');
  assert.equal(nodeOf(after, 'a1').work_status, 'settled');
});

const STALED = markStale(LINKED, 'p1', { version: '8', reason: '月计划改成秋季' });

test('clear stale: opening a node does not clear it — reading is not deciding', () => {
  for (const how of ['opened', 'read', undefined, '']) {
    const after = clearStale(STALED, 'a1', how);
    assert.equal(nodeOf(after, 'a1').stale_since, '8', `「${String(how)}」不是一次决定`);
    assert.equal(nodeOf(after, 'a1').stale_reason, '月计划改成秋季');
  }
});

test('clear stale: each of the three deliberate acts clears the badge', () => {
  assert.deepEqual(CLEARING_ACTS, ['followed', 'edited', 'accepted'], '跟着改、我自己改、这样就行');
  for (const how of CLEARING_ACTS) {
    const after = clearStale(STALED, 'a1', how);
    assert.equal(nodeOf(after, 'a1').stale_since, undefined, `${how} 应当清除徽标`);
    assert.equal(nodeOf(after, 'a1').stale_reason, undefined);
    assert.equal(nodeOf(after, 'a1').status, 'confirmed', '清除徽标不动出处');
  }
});

test('clear stale: only the node she decided about clears', () => {
  const after = clearStale(STALED, 'a1', 'accepted');
  assert.equal(nodeOf(after, 'w1').stale_since, '8', '每个节点各自判断，不能替她一次清一片');
  assert.equal(nodeOf(after, 'a2').stale_since, '8');
});

test('retire stale: a node whose dates have passed retires without being touched', () => {
  const after = retireStale(STALED, '2026-10-01');
  assert.equal(nodeOf(after, 'a1').stale_since, undefined, '已经上过的课不需要再提醒');
  assert.equal(nodeOf(after, 'w1').stale_since, undefined, '周计划按自己活动的日期退休');
  assert.equal(nodeOf(after, 'a1').status, 'confirmed');
});

test('retire stale: anything still ahead keeps its badge, including today', () => {
  const after = retireStale(STALED, '2026-10-01');
  assert.equal(nodeOf(after, 'a3').stale_since, '8');
  assert.equal(nodeOf(after, 'a3').stale_reason, '月计划改成秋季', '理由要跟着节点活下来');
  assert.equal(nodeOf(after, 'w3').stale_since, '8');
  const onTheDay = retireStale(STALED, '2026-10-05');
  assert.equal(nodeOf(onTheDay, 'a3').stale_since, '8', '今天还要上的课，徽标今天还有用');
});

test('retire stale: an undated node never retires, and a bad date retires nothing', () => {
  const undated = markStale(
    normalizePlan({ roots: [{ id: 'w', kind: 'week', title: '周计划', children: [{ id: 'x', kind: 'activity', title: '还没排日期' }] }] }),
    'w',
    { version: '8', reason: '上游改了' },
  );
  assert.equal(nodeOf(retireStale(undated, '2099-01-01'), 'x').stale_since, '8', '不知道上没上过，就不能当作上过');
  assert.equal(nodeOf(retireStale(STALED, '下周'), 'a1').stale_since, '8', '读不懂的日期不退休任何东西');
});
