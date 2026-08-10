// plan-tsv.test.mjs — the course_plan tree and its skeleton wire format.
//
// Round-trip equality is a TEST here, not an assumption: a shifted column in
// this table would parse successfully with wrong values, and one of the columns
// is provenance. `hypothesis` silently becoming `confirmed` is the failure
// non-negotiable #1 exists to stop, so it gets a test rather than a comment.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SKELETON_COLUMNS, SKELETON_VERSION, EMPTY,
  normalizePlan, walkPlan, numberPlan, ancestorsOf,
  toSkeletonTSV, parseSkeletonTSV,
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
