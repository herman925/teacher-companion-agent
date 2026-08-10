#!/usr/bin/env node
// make-context-arms.mjs — payload generator for the context-format measurement
// (ADR-0007 §6, ADR-0011 §7). 冯浩然 owns the numbers; this owns the payloads.
//
// It builds ONE realistic course — a 4-week 东乡龙舟 month with ~20 activities —
// and renders the plan three ways, so the comparison is like-for-like:
//
//   arm A  pretty JSON   what ships TODAY (JSON.stringify(state, null, 1))
//   arm B  compact JSON  same data, no indentation
//   arm C  TSV skeleton  titles and statuses only, bodies excluded
//
// Arm C is NOT arm B minus whitespace. It also drops every activity body, which
// is the larger part of the saving and the part that has nothing to do with the
// format. Reported separately below so the two effects are not confused: if
// tiering alone gets most of the win, TSV is not worth its escaping rules.
//
// Character counts are printed as a rough shape only. TOKENS ARE THE REAL
// MEASURE and must come from a live call's `usage` — Chinese text does not
// tokenize proportionally to characters, so a char ratio can mislead in either
// direction. Feed these payloads to a real provider and read the counters.
//
// Usage:
//   node demo/tests/fixtures/make-context-arms.mjs            # summary
//   node demo/tests/fixtures/make-context-arms.mjs --emit A   # print one arm

import { toSkeletonTSV, normalizePlan } from '../../src/plan-tsv.mjs';

const WEEKS = [
  { title: '周1 认识龙舟', focus: '共同经验', dates: ['2026-09-21', '2026-09-25'] },
  { title: '周2 龙舟与水', focus: '材料与浮沉', dates: ['2026-09-28', '2026-10-02'] },
  { title: '周3 一起划', focus: '协作与节奏', dates: ['2026-10-05', '2026-10-09'] },
  { title: '周4 我们的龙舟', focus: '表达与呈现', dates: ['2026-10-12', '2026-10-16'] },
];

const ORG_TYPES = ['集体教学', '小组教学', '个别指导', '自主游戏·环创', '亲子活动'];

/** A body of the length a real 活动方案 runs to — the thing tiering removes. */
function activityBody(title, org, focus) {
  return [
    `活动目标：围绕「${focus}」，让孩子在${org}中获得可迁移的直接经验。`,
    `活动准备：材料清单见课程资料；场地按当日天气调整，雨天改在多功能室。`,
    `活动过程：一、引入——教师出示上一次孩子留下的作品，请孩子说说自己记得什么。`,
    `二、展开——孩子分组尝试「${title}」，教师不示范，只在孩子求助时给一句提示。`,
    `三、回顾——请两三个孩子说说自己是怎么做的，教师记录原话，不替孩子总结。`,
    `重点观察（提示，不是要求）：孩子是否主动尝试；遇到困难时求助还是放弃；`,
    `是否出现反复出现的问题，如果有，可以在下一次活动里收成探究聚焦点。`,
    `预设，待现场验证：孩子可能会对声音特别有反应，也可能完全不感兴趣。`,
  ].join('\n');
}

function buildCourse() {
  const roots = [{
    id: 'p1', kind: 'phase', title: '东乡龙舟', status: 'confirmed', work_status: 'settled',
    body: '本月围绕东乡龙舟展开主题探究，从认识到协作再到表达，四周一个阶段。',
    children: WEEKS.map((w, wi) => ({
      id: `w${wi + 1}`,
      kind: 'week',
      title: w.title,
      status: wi === 0 ? 'confirmed' : 'ai_suggestion',
      work_status: wi === 0 ? 'settled' : 'draft',
      body: `本周聚焦「${w.focus}」。${wi === 0 ? '已与教师确认。' : '待教师确认。'}`,
      ...(wi === 2 ? { stale_since: '7', stale_reason: '周2 去掉划船动作经验' } : {}),
      children: ORG_TYPES.map((org, ai) => {
        const title = `${org}：${w.focus}${ai + 1}`;
        return {
          id: `w${wi + 1}.a${ai + 1}`,
          kind: 'activity',
          title,
          org_type: org,
          dates: [w.dates[0]],
          status: wi === 0 ? 'confirmed' : (ai % 3 === 0 ? 'hypothesis' : 'ai_suggestion'),
          work_status: 'draft',
          body: activityBody(title, org, w.focus),
        };
      }),
    })),
  }];
  return normalizePlan({ version: 'v0.4', roots });
}

const plan = buildCourse();

// Arm A — today: the whole thing, pretty-printed with an indent of 1.
const armA = JSON.stringify({ course_plan: plan }, null, 1);
// Arm B — same data, no indentation.
const armB = JSON.stringify({ course_plan: plan });
// Arm C — skeleton only: titles and statuses, no bodies.
const armC = toSkeletonTSV(plan);
// Arm C' — the tiering effect ALONE, so the format effect can be isolated.
const stripBodies = (n) => ({ ...n, body: undefined, children: (n.children ?? []).map(stripBodies) });
const armBnoBodies = JSON.stringify({ course_plan: { ...plan, roots: plan.roots.map(stripBodies) } });

const emit = process.argv.indexOf('--emit');
if (emit > -1) {
  const which = (process.argv[emit + 1] || 'C').toUpperCase();
  process.stdout.write({ A: armA, B: armB, C: armC }[which] ?? armC);
} else {
  let nodes = 0;
  for (const _ of (function* w(ns) { for (const n of ns) { yield n; yield* w(n.children ?? []); } })(plan.roots)) nodes += 1;
  const pct = (x) => `${Math.round((x / armA.length) * 100)}%`;
  console.log(`课程规模：${nodes} 个节点（1 个月计划 · ${WEEKS.length} 个周计划 · ${WEEKS.length * ORG_TYPES.length} 个活动）\n`);
  console.log('字符数（仅供大致判断——真实口径是 token，要从实际调用的 usage 读）');
  console.log(`  A 现状 · 带缩进 JSON      ${String(armA.length).padStart(7)}  ${pct(armA.length)}`);
  console.log(`  B 紧凑 JSON               ${String(armB.length).padStart(7)}  ${pct(armB.length)}`);
  console.log(`  B' 紧凑 JSON · 去掉正文    ${String(armBnoBodies.length).padStart(7)}  ${pct(armBnoBodies.length)}   <- 分层单独的效果`);
  console.log(`  C TSV 骨架                ${String(armC.length).padStart(7)}  ${pct(armC.length)}   <- 分层 + 格式`);
  console.log('\nB→B\' 是分层带来的，B\'→C 才是 TSV 本身带来的。');
  console.log('如果 B\' 已经拿到大部分收益，TSV 的转义规则就不值得。');
  console.log('\n取单独一份：node demo/tests/fixtures/make-context-arms.mjs --emit A|B|C');
}
