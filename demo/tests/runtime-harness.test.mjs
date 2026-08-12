// Both-directions tests for the RUNTIME harness (demo/src/harness.mjs) and the
// deterministic engine (demo/src/engine.mjs): every rule must fire on a violating
// turn AND stay silent on a compliant one (CLAUDE.md discipline).

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTurn, validateTurn, findClaimSentences, violationFeedback, safeTemplate } from '../src/harness.mjs';
import { createInitialState, applyDelta, stageGateError } from '../src/engine.mjs';

// ---------- fixtures ----------

const goodClosure = {
  do_now: '带孩子到河边看一次真实的龙舟训练',
  materials: '观察记录卡、访谈卡各一张',
  bring_back: '孩子的三句原话、两个停留点、一张照片',
  i_will: '我会根据孩子的真实反应整理问题池',
};

/** A fully compliant round-ending turn. */
function goodTurn(extra = {}) {
  return {
    reply_markdown: '我们先让孩子真正遇见龙舟。回来时带几句孩子原话就很好。',
    question: null,
    artifacts: [],
    closure_loop: goodClosure,
    state_delta: {},
    evidence_refs: [],
    round_complete: true,
    ...extra,
  };
}

function stateWithEvidence() {
  const s = createInitialState('c1');
  s.children_evidence = [{ id: 'ev1', kind: 'child_words', content: '为什么船头有龙的眼睛？', recorded_at: 'r1' }];
  return s;
}

// ---------- L2 parse ----------

test('parseTurn accepts a plain JSON object', () => {
  const { turn, violations } = parseTurn(goodTurn());
  assert.ok(turn);
  assert.equal(violations.length, 0);
});

test('parseTurn extracts fenced JSON from prose-wrapped output', () => {
  const raw = '好的，输出如下：\n```json\n' + JSON.stringify(goodTurn()) + '\n```\n';
  const { turn } = parseTurn(raw);
  assert.ok(turn);
  assert.equal(turn.round_complete, true);
});

test('parseTurn blocks on garbage', () => {
  const { turn, violations } = parseTurn('这不是JSON');
  assert.equal(turn, null);
  assert.equal(violations[0].kind, 'contract_parse');
});

// ---------- L3: closure loop (advisory since ADR-0012 §2) ----------

// ADR-0008 §3 made 回传 an invitation rather than a duty, so these two report
// and never block. Both directions of the WEAKENING: they must still be
// recorded (the rate is pilot data), and they must never reach the regenerate
// path — a turn whose only fault is a missing closure loop is a legal turn.
test('closure loop: still reported when round_complete lacks closure — as a warn', () => {
  const v = validateTurn(goodTurn({ closure_loop: null }), createInitialState('c1'));
  const hit = v.find((x) => x.kind === 'closure_missing');
  assert.ok(hit, '仍然记录');
  assert.equal(hit.action, 'warn');
});

test('closure loop: still reported when an element is empty — as a warn', () => {
  const v = validateTurn(goodTurn({ closure_loop: { ...goodClosure, bring_back: ' ' } }), createInitialState('c1'));
  const hit = v.find((x) => x.kind === 'closure_incomplete');
  assert.ok(hit && hit.detail.includes('bring_back'));
  assert.equal(hit.action, 'warn');
});

test('closure loop: a missing closure never blocks, so it never triggers regeneration', () => {
  const v = validateTurn(goodTurn({ closure_loop: null }), createInitialState('c1'));
  assert.equal(v.filter((x) => x.action === 'block').length, 0, '回传缺失不再是缺陷，不能触发重生成');
  assert.ok(!violationFeedback(v).includes('closure_missing'), 'advisory 违例不进重生成反馈');
});

test('closure loop: silent on a complete four-part closure', () => {
  const v = validateTurn(goodTurn(), createInitialState('c1'));
  assert.equal(v.filter((x) => x.kind.startsWith('closure')).length, 0);
});

// ---------- L3: screening contract ----------

test('question: fires without examples', () => {
  const t = goodTurn({ round_complete: false, closure_loop: null, question: { text: '班里多少个孩子？', why: '定分组', examples: [] } });
  const v = validateTurn(t, createInitialState('c1'));
  assert.ok(v.some((x) => x.kind === 'question_no_examples'));
});

test('question: silent with 2–3 examples', () => {
  const t = goodTurn({ round_complete: false, closure_loop: null, question: { text: '为什么想带孩子做龙舟？', why: '先听懂你的资源意图', examples: ['村里每年都有龙舟赛', '孩子在河边见过龙舟'] } });
  const v = validateTurn(t, createInitialState('c1'));
  assert.equal(v.filter((x) => x.kind === 'question_no_examples').length, 0);
});

test('interrogation: fires when prose piles on many more questions', () => {
  const t = goodTurn({
    round_complete: false, closure_loop: null,
    reply_markdown: '班里几个孩子？年龄多大？做过什么活动？家长能来吗？场地在哪里？',
    question: { text: '班里几个孩子？', why: 'x', examples: ['20', '30'] },
  });
  const v = validateTurn(t, createInitialState('c1'));
  assert.ok(v.some((x) => x.kind === 'multi_question'));
});

// ---------- L3: evidence-first / fabrication ----------

test('fabrication: fires on child-claims with empty evidence_refs', () => {
  const t = goodTurn({ reply_markdown: '孩子们已经爱上了龙舟，都发现了船桨的秘密。' });
  const v = validateTurn(t, createInitialState('c1'));
  assert.ok(v.some((x) => x.kind === 'fabrication'));
});

test('fabrication: silent when the claim cites existing evidence', () => {
  const t = goodTurn({ reply_markdown: '孩子们发现了船头的龙眼，证据是你记录的原话。', evidence_refs: ['ev1'] });
  const v = validateTurn(t, stateWithEvidence());
  assert.equal(v.filter((x) => x.kind === 'fabrication').length, 0);
});

test('fabrication: silent on hedged possibilities without evidence', () => {
  const t = goodTurn({ reply_markdown: '孩子们可能会喜欢龙舟的鼓声，建议下一轮观察他们的停留点。' });
  const v = validateTurn(t, createInitialState('c1'));
  assert.equal(v.filter((x) => x.kind === 'fabrication').length, 0);
});

test('fabrication: fires on refs to nonexistent evidence ids', () => {
  const t = goodTurn({ evidence_refs: ['ghost-1'] });
  const v = validateTurn(t, createInitialState('c1'));
  assert.ok(v.some((x) => x.kind === 'fabrication' && x.detail.includes('ghost-1')));
});

test('fabrication: accepts refs to evidence newly provided in this turn delta', () => {
  const t = goodTurn({
    reply_markdown: '孩子们发现了船头的龙眼。',
    evidence_refs: ['new1'],
    state_delta: { children_evidence: [{ id: 'new1', kind: 'child_words', content: '龙的眼睛为什么是凸的？', recorded_at: 'r1' }] },
  });
  const v = validateTurn(t, createInitialState('c1'));
  assert.equal(v.filter((x) => x.kind === 'fabrication').length, 0);
});

// ---------- L3: the artifact is the deliverable, so it is scanned too ----------

/** The 课程故事 shape: bland prose, everything asserted inside the artifact. */
const storyTurn = (extra = {}) => goodTurn({
  reply_markdown: '我把这一段整理好了，你看看。',
  artifacts: [{ type: 'story_fragment', title: '课程故事片段', data: {
    chapters: [{ text: '孩子们发现龙舟的桨是弯的，全班都爱上了划船，大家已经理解了团队协作的意义。' }],
  } }],
  ...extra,
});

test('fabrication: fires on a story artifact asserting child discoveries with no refs', () => {
  const v = validateTurn(storyTurn(), createInitialState('c1'));
  assert.ok(v.some((x) => x.kind === 'fabrication' && x.action === 'block'), '产物才是她留下的东西，正文平淡不代表这一轮没断言');
});

test('MUST PASS — the same artifact with resolving evidence_refs goes through', () => {
  const v = validateTurn(storyTurn({ evidence_refs: ['ev1'] }), stateWithEvidence());
  assert.equal(v.filter((x) => x.kind === 'fabrication').length, 0);
});

test('MUST PASS — an ordinary planning artifact is not a claim about children', () => {
  const t = goodTurn({ artifacts: [{ type: 'experience_plan', title: '第2周', data: {
    activity: '带孩子到河边看一次真实的龙舟训练，回来画自己看到的船',
    observation: '谁在船边停得最久，孩子会问什么',
  } }] });
  assert.equal(validateTurn(t, createInitialState('c1')).filter((x) => x.kind === 'fabrication').length, 0);
});

// ---------- L3: evidence must come from HER (ADR-0011 §5 / non-negotiable #1) ----------

const mintedEvidenceTurn = (content) => goodTurn({
  reply_markdown: '孩子们已经发现了桨是弯的，全班都很兴奋。',
  evidence_refs: ['e1'],
  state_delta: {
    stage: 2,
    children_evidence: [{ id: 'e1', kind: 'child_words', content, recorded_at: 'r1' }],
  },
});

/** Stage 1 → 2 is one legal step; the only thing standing in the way is whether
 * real child evidence exists. */
const atStageOne = () => ({ ...createInitialState('c1'), stage: 1 });

test('fabrication: evidence the teacher never mentioned does not license the claim', () => {
  // The turn used to write its own permission slip: mint the row, cite it,
  // assert on it, and open stage 2 with it — all in one turn.
  const v = validateTurn(mintedEvidenceTurn('孩子说桨为什么是弯的'), atStageOne(), {
    teacherText: '这周我们还没开展活动，先给我看看第二周的安排。',
  });
  assert.ok(v.some((x) => x.kind === 'fabrication' && x.detail.includes('e1')), '自己写的证据不是证据');
  assert.ok(v.some((x) => x.kind === 'illegal_stage_jump'), '也不能凭它推进阶段');
});

test('MUST PASS — evidence quoting her 回传 message is accepted and opens stage 2', () => {
  const said = '今天带孩子去看了龙舟，男孩A说「桨为什么是弯的」，好几个孩子围着看了很久。';
  const v = validateTurn(mintedEvidenceTurn('桨为什么是弯的'), atStageOne(), { teacherText: said });
  assert.equal(v.filter((x) => x.kind === 'fabrication').length, 0, '她说过的话就是证据');
  assert.equal(v.filter((x) => x.kind === 'illegal_stage_jump').length, 0, '有证据就能进阶段2');
});

test('evidence grounding is dormant when the caller supplies no teacher text', () => {
  const v = validateTurn(mintedEvidenceTurn('孩子说桨为什么是弯的'), atStageOne());
  assert.equal(v.filter((x) => x.kind === 'fabrication').length, 0);
});

// ---------- L3: culture stays backstage ----------

test('adult slogan: fires inside a child-facing artifact', () => {
  const t = goodTurn({ artifacts: [{ type: 'cycle_task', title: '下一轮', data: { task: '让孩子理解传承精神' } }] });
  const v = validateTurn(t, createInitialState('c1'));
  assert.ok(v.some((x) => x.kind === 'adult_slogan'));
});

test('adult slogan: silent in adult_phrasings_to_avoid (the field that names them)', () => {
  const t = goodTurn({ artifacts: [{ type: 'entry_card', title: '切口卡', data: { child_entry_points: ['听鼓点'], adult_phrasings_to_avoid: ['传承精神', '民族精神'] } }] });
  const v = validateTurn(t, createInitialState('c1'));
  assert.equal(v.filter((x) => x.kind === 'adult_slogan').length, 0);
});

test('adult slogan: still fires elsewhere in the same artifact carrying the exempt field', () => {
  const t = goodTurn({ artifacts: [{ type: 'entry_card', title: '切口卡', data: { child_entry_points: ['体会民族精神'], adult_phrasings_to_avoid: ['传承精神'] } }] });
  const v = validateTurn(t, createInitialState('c1'));
  assert.ok(v.some((x) => x.kind === 'adult_slogan'));
});

// Blueprint nodes are child-facing script and, under ADR-0003, the whole
// deliverable — so the slogan rule (non-negotiable #3) must reach them. Both
// directions: a slogan in a node body blocks; a clean node stays silent.
test('adult slogan: fires inside a blueprint node body', () => {
  const t = goodTurn({ artifacts: [{ type: 'blueprint', title: '预设蓝图', data: {
    version: 'v0.1',
    modules: [{ id: 'm1', title: '第一周', body: '带孩子理解传承精神', status: 'hypothesis' }],
  } }] });
  const v = validateTurn(t, createInitialState('c1'));
  assert.ok(v.some((x) => x.kind === 'adult_slogan'), 'a slogan in a blueprint node must fire #3');
});

test('adult slogan: silent on a clean child-actionable blueprint node', () => {
  const t = goodTurn({ artifacts: [{ type: 'blueprint', title: '预设蓝图', data: {
    version: 'v0.1',
    modules: [{ id: 'm1', title: '第一周', body: '带孩子到祠堂前看醒狮，数一数狮头有几种颜色', status: 'hypothesis' }],
  } }] });
  const v = validateTurn(t, createInitialState('c1'));
  assert.equal(v.filter((x) => x.kind === 'adult_slogan').length, 0);
});

test('adult slogan: silent in teacher-backstage question_pool cultural hints', () => {
  const t = goodTurn({ artifacts: [{ type: 'question_pool', title: '问题池', data: { hint: '教师后台可关注：这背后有代际传承的生活经验（不讲给孩子）' } }] });
  const v = validateTurn(t, createInitialState('c1'));
  assert.equal(v.filter((x) => x.kind === 'adult_slogan').length, 0);
});

// ---------- L3: the marking rule watches the DELTAS, not only artifacts ----------
//
// Since ADR-0010 §6 the deltas are the primary write channel into both trees,
// so a walk that only ever looked at `turn.artifacts` left the main road
// unwatched: an un-hedged, un-marked assertion about what children learned went
// straight into the living plan.

test('unmarked_hypothesis: fires on a blueprint_delta node body asserting child learning', () => {
  const t = goodTurn({ blueprint_delta: [{ op: 'set', id: 'm9', parent_id: 'm1', node: {
    title: '龙舟周', body: '孩子们都理解了龙舟的结构，全班已经学会了划桨的动作。', status: 'ai_suggestion',
  } }] });
  const v = validateTurn(t, createInitialState('c1'));
  assert.ok(v.some((x) => x.kind === 'unmarked_hypothesis' && x.action === 'block'));
  assert.ok(v.find((x) => x.kind === 'unmarked_hypothesis').detail.includes('m9'), '要说清是哪一个节点');
});

test('unmarked_hypothesis: fires on a plan_delta node body too', () => {
  const t = goodTurn({ plan_delta: [{ op: 'set', id: 'a9', parent_id: 'w1', node: {
    title: '划桨练习', body: '孩子们已经掌握了划桨的节奏。', status: 'ai_suggestion',
  } }] });
  assert.ok(validateTurn(t, createInitialState('c1')).some((x) => x.kind === 'unmarked_hypothesis'));
});

test('MUST PASS — the same delta body marked hypothesis, or hedged, sails through', () => {
  const marked = goodTurn({ blueprint_delta: [{ op: 'set', id: 'm9', parent_id: 'm1', node: {
    title: '龙舟周', body: '孩子们都理解了龙舟的结构，全班已经学会了划桨的动作。', status: 'hypothesis',
  } }] });
  assert.equal(validateTurn(marked, createInitialState('c1')).filter((x) => x.kind === 'unmarked_hypothesis').length, 0,
    '预设可以写孩子，只要看得出是预设');
  const hedged = goodTurn({ blueprint_delta: [{ op: 'set', id: 'm9', parent_id: 'm1', node: {
    title: '龙舟周', body: '预计孩子们会理解龙舟的结构。', status: 'ai_suggestion',
  } }] });
  assert.equal(validateTurn(hedged, createInitialState('c1')).filter((x) => x.kind === 'unmarked_hypothesis').length, 0);
});

// 待现场验证 is the phrase the whole prompt corpus mandates ('预设，待现场验证')
// and the one blueprint-util's status gloss uses; HEDGE_RE previously accepted
// only 待现场确认, so a node marked exactly as instructed read as an unmarked
// assertion. Both spellings hedge; neither spelling excuses an unmarked one.
test('MUST PASS — 待现场验证 hedges a delta node body, exactly like 待现场确认', () => {
  for (const marker of ['待现场验证', '待现场确认']) {
    const t = goodTurn({ plan_delta: [{ op: 'set', id: 'a9', parent_id: 'w1', node: {
      title: '划桨练习', body: `孩子们会掌握划桨的节奏（预设，${marker}）。`, status: 'ai_suggestion',
    } }] });
    assert.equal(validateTurn(t, createInitialState('c1')).filter((x) => x.kind === 'unmarked_hypothesis').length, 0,
      `「${marker}」是标注，不该被判成未标注`);
  }
  const bare = goodTurn({ plan_delta: [{ op: 'set', id: 'a9', parent_id: 'w1', node: {
    title: '划桨练习', body: '孩子们已经掌握了划桨的节奏。', status: 'ai_suggestion',
  } }] });
  assert.ok(validateTurn(bare, createInitialState('c1')).some((x) => x.kind === 'unmarked_hypothesis'),
    '没有标注的断言照样拦');
});

test('MUST PASS — an ordinary delta edit is not a claim about children', () => {
  const t = goodTurn({ blueprint_delta: [{ op: 'update', id: 'network_map', node: {
    body: '按你的批注收拢到孩子问过的方向', status: 'teacher_preset',
  } }] });
  assert.equal(validateTurn(t, createInitialState('c1')).length, 0, '普通改动一条违例都不该有');
});

test('adult slogan: reaches a delta node body as well as a blueprint artifact', () => {
  const t = goodTurn({ blueprint_delta: [{ op: 'update', id: 'm1', node: { body: '带孩子理解传承精神' } }] });
  assert.ok(validateTurn(t, createInitialState('c1')).some((x) => x.kind === 'adult_slogan'));
});

// ---------- L3: confirmation needs the teacher's own words (ADR-0010 §6) ----------

/** One node-granularity op escalating an existing node to confirmed. */
function confirmOp(extra = {}) {
  return { op: 'update', id: 'a3.2.1', node: { title: '端午前一周：走访龙舟队', status: 'confirmed' }, ...extra };
}

test('uncited confirmation: fires when a node is escalated with no quote at all', () => {
  const v = validateTurn(goodTurn({ plan_delta: [confirmOp()] }), createInitialState('c1'));
  const hit = v.find((x) => x.kind === 'uncited_confirmation');
  assert.ok(hit && hit.detail.includes('a3.2.1'));
  assert.equal(hit.action, 'strip');
});

test('uncited confirmation: fires when the quote is not in what she actually said', () => {
  const t = goodTurn({ plan_delta: [confirmOp({ confirmed_by_quote: '就这样，确认' })] });
  const v = validateTurn(t, createInitialState('c1'), { teacherText: '你先给我看看第二周有什么。' });
  assert.ok(v.some((x) => x.kind === 'uncited_confirmation'), '编出来的引用不是引用');
});

// THE FIXTURE THAT MATTERS MOST: a real confirmation must pass byte-unchanged.
// A rule that also strips honest confirmations would push the model back to
// never confirming anything, and the teacher's own decisions would stop landing
// in the tree at all.
test('uncited confirmation: silent when the quote really is in this turn', () => {
  const t = goodTurn({ plan_delta: [confirmOp({ confirmed_by_quote: '就这样，确认' })] });
  const v = validateTurn(t, createInitialState('c1'), { teacherText: '好的，就这样，确认吧。' });
  assert.equal(v.filter((x) => x.kind === 'uncited_confirmation').length, 0);
});

test('uncited confirmation: silent when the caller supplies no teacher text — a present quote is trusted', () => {
  const t = goodTurn({ plan_delta: [confirmOp({ confirmed_by_quote: '就这样，确认' })] });
  assert.equal(validateTurn(t, createInitialState('c1')).filter((x) => x.kind === 'uncited_confirmation').length, 0);
});

test('uncited confirmation: one quote confirms one node — nested children do not ride along', () => {
  const t = goodTurn({ plan_delta: [confirmOp({
    confirmed_by_quote: '这周就这样',
    node: {
      title: '第2周', status: 'confirmed',
      children: [{ id: 'a3.2.1.1', title: '做小龙舟', status: 'confirmed' }],
    },
  })] });
  const v = validateTurn(t, createInitialState('c1'), { teacherText: '这周就这样，别的先不动。' });
  const hit = v.find((x) => x.kind === 'uncited_confirmation');
  assert.ok(hit, '搭便车的子节点必须被抓到');
  assert.ok(hit.detail.includes('把 a3.2.1.1 升为 confirmed'), `只点名子节点，被引用的父节点不在名单里：${hit.detail}`);
});

test('uncited confirmation: the older blueprint_delta channel is watched too', () => {
  const t = goodTurn({ blueprint_delta: [{ op: 'update', id: 'network_map', node: { status: 'confirmed' } }] });
  assert.ok(validateTurn(t, createInitialState('c1')).some((x) => x.kind === 'uncited_confirmation'));
});

test('uncited confirmation: silent on an ordinary edit that claims no confirmation', () => {
  const t = goodTurn({ blueprint_delta: [{ op: 'update', id: 'network_map', node: { body: '已按你的批注调整', status: 'teacher_preset' } }] });
  assert.equal(validateTurn(t, createInitialState('c1')).filter((x) => x.kind === 'uncited_confirmation').length, 0);
});

// ---------- L3: memory contradiction (ADR-0011 §5) ----------

/** The canonical class fact: 「我们班没有鼓」 — stated once, binding on every
 * activity in every week of every course she plans with this class. */
const NO_DRUMS = [{ scope: 'class', text: '班上没有鼓', quote: '我们班没有鼓', at: '2026-07-01T00:00:00Z', source: 'teacher' }];

/** A turn proposing an activity, as an artifact rather than prose. */
function activityTurn(activity) {
  return goodTurn({ artifacts: [{ type: 'experience_plan', title: '第2周', data: { activity } }] });
}

test('memory contradiction: fires when the proposed activity needs what the class does not have', () => {
  const v = validateTurn(activityTurn('准备两面小鼓，请孩子轮流敲出龙舟的节奏'), createInitialState('c1'), { facts: NO_DRUMS });
  const hit = v.find((x) => x.kind === 'memory_contradiction');
  assert.ok(hit, '班上没有鼓，却提了敲鼓活动');
  assert.ok(hit.detail.includes('班上没有鼓'), '反馈必须点名是哪条记忆');
  assert.equal(hit.action, 'strip');
});

// THE FIXTURE THAT MATTERS MOST: an activity that needs no drum must sail
// through. A memory rule that fires on activities it has no quarrel with would
// make every remembered constraint a tax on planning.
test('memory contradiction: silent on an activity that does not need the missing thing', () => {
  const v = validateTurn(activityTurn('准备一箱纸盒和木棒，请孩子敲出自己的节奏'), createInitialState('c1'), { facts: NO_DRUMS });
  assert.equal(v.filter((x) => x.kind === 'memory_contradiction').length, 0);
});

test('memory contradiction: silent when the turn is respecting the fact out loud', () => {
  const t = goodTurn({ reply_markdown: '你们班没有鼓，所以这一周改用木棒敲纸箱，孩子照样听得见节奏。' });
  const v = validateTurn(t, createInitialState('c1'), { facts: NO_DRUMS });
  assert.equal(v.filter((x) => x.kind === 'memory_contradiction').length, 0, '谈论约束不等于违反约束');
});

test('memory contradiction: dormant when the caller supplies no facts', () => {
  const v = validateTurn(activityTurn('准备两面小鼓，请孩子轮流敲出龙舟的节奏'), createInitialState('c1'));
  assert.equal(v.filter((x) => x.kind === 'memory_contradiction').length, 0);
});

test('memory contradiction: a fact that excludes nothing bans nothing', () => {
  const facts = [{ scope: 'class', text: '有几个孩子很怕大声', quote: '有几个孩子很怕大声', source: 'teacher' }];
  const v = validateTurn(activityTurn('准备两面小鼓，请孩子轮流敲出龙舟的节奏'), createInitialState('c1'), { facts });
  assert.equal(v.filter((x) => x.kind === 'memory_contradiction').length, 0);
});

test('memory contradiction: 「没有见过X」 is a verb phrase, not a banned material', () => {
  const facts = [{ scope: 'class', text: '孩子们没有见过龙舟', source: 'auto' }];
  const v = validateTurn(activityTurn('准备一条龙舟模型，请孩子摸一摸船桨'), createInitialState('c1'), { facts });
  assert.equal(v.filter((x) => x.kind === 'memory_contradiction').length, 0, '没见过正是要去看，不是禁止出现');
});

test('memory contradiction: reads the plan delta, not only artifacts', () => {
  const t = goodTurn({ plan_delta: [{ op: 'set', id: 'a4.1', parent_id: 'w4', node: { title: '敲鼓感受节奏', body: '每人一面小鼓，跟着节拍敲' } }] });
  assert.ok(validateTurn(t, createInitialState('c1'), { facts: NO_DRUMS }).some((x) => x.kind === 'memory_contradiction'));
});

// ---------- engine: stage gates ----------

// ADR-0012 §2 (corrected): the ordinal check and the EVIDENCE branches stay;
// the V1.3 ARTIFACT prerequisites (entry card, fit screening, goals axis, cycle
// record) retired with the workflow chain. Workflow v2 produces a plan tree, so
// demanding an entry card would block stage 1 permanently.
test('stage gate: ordinal sanity survives — 0→2 is still refused', () => {
  const s = createInitialState('c1');
  assert.ok(stageGateError(s, 2), '跨阶段跳仍然要拦——这是结构完整性，不是工作流链');
});

test('stage gate: 0→1 now passes — the artifact prerequisites are retired', () => {
  const s = createInitialState('c1');
  assert.equal(stageGateError(s, 1), null);
  // and it does not secretly depend on the retired artifacts existing
  s.resource_entry_card = { original_theme: '龙舟' };
  s.theme_fit_level = 'theme_inquiry';
  assert.equal(stageGateError(s, 1), null);
});

test('stage gate: the EVIDENCE gate is untouched — non-negotiable #1', () => {
  const s = createInitialState('c1');
  s.stage = 1;
  // No child evidence: entering 目标轴心 stays refused, whatever happened to
  // the chain. ADR-0008 §3 unforced 回传 for the TEACHER, not for the model.
  assert.ok(stageGateError(s, 2), '没有儿童证据不能进阶段2');
  s.children_evidence = [{ id: 'ev-1', kind: 'child_words', content: '为什么鼓这么响？', recorded_at: 'r1' }];
  assert.equal(stageGateError(s, 2), null);
  // Course-story export without any evidence stays refused too.
  const t = createInitialState('c2');
  t.stage = 4;
  assert.ok(stageGateError(t, 5), '没有过程证据不能导出课程故事');
});

test('stage gate 1→2: evidence is mandatory, a driving question is not (stage1-v1.0)', () => {
  const bare = createInitialState('c1');
  bare.stage = 1;
  assert.ok(stageGateError(bare, 2), 'no children evidence → still blocked');
  const s = stateWithEvidence();
  s.stage = 1;
  assert.equal(stageGateError(s, 2), null, 'evidence alone opens stage 2 — 核心驱动问题 is derived there, not required here');
});

test('applyDelta: strips illegal stage jump but applies the rest, logging violation', () => {
  const s = createInitialState('c1');
  const { state, violations } = applyDelta(s, { stage: 3, theme_fit_level: 'short_activity' });
  assert.equal(state.stage, 0);
  assert.equal(state.theme_fit_level, 'short_activity');
  assert.ok(violations.some((v) => v.kind === 'illegal_stage_jump'));
});

test('applyDelta: drops non-whitelisted fields (course_id is platform identity)', () => {
  const s = createInitialState('c1');
  const { state, violations } = applyDelta(s, { course_id: 'hacked', awaiting_feedback: false });
  assert.equal(state.course_id, 'c1');
  assert.equal(violations.filter((v) => v.kind === 'bad_delta').length, 2);
});

test('applyDelta: appends evidence with id-dedupe (update in place)', () => {
  const s = stateWithEvidence();
  const { state } = applyDelta(s, {
    children_evidence: [
      { id: 'ev1', kind: 'child_words', content: '（教师修正后的原话）', recorded_at: 'r1' },
      { id: 'ev2', kind: 'photo', content: '孩子围观龙舟头', recorded_at: 'r1' },
    ],
  });
  assert.equal(state.children_evidence.length, 2);
  assert.ok(state.children_evidence[0].content.includes('修正'));
});

test('applyDelta: awaiting_feedback lifecycle — evidence-gated set on round_complete, cleared on teacher turn', () => {
  // 备课期 (no child evidence yet): a completed round does NOT wait for 回传.
  const planned = applyDelta(createInitialState('c1'), {}, { roundComplete: true }).state;
  assert.equal(planned.awaiting_feedback, false, '备课 round_complete must not flip awaiting_feedback');
  // 实施期 (evidence exists): the completed round waits for the classroom.
  const closed = applyDelta(stateWithEvidence(), {}, { roundComplete: true }).state;
  assert.equal(closed.awaiting_feedback, true);
  const reopened = applyDelta(closed, {}, { teacherTurn: true }).state;
  assert.equal(reopened.awaiting_feedback, false);
});

test('applyDelta: evidence arriving in the same delta as round_complete starts the wait', () => {
  const { state } = applyDelta(createInitialState('c1'), {
    children_evidence: [{ id: 'ev1', kind: 'child_words', content: '桨为什么是弯的？', recorded_at: 'r1' }],
  }, { roundComplete: true });
  assert.equal(state.awaiting_feedback, true);
});

// ---------- L4 ----------

test('violationFeedback lists blocking violations for regeneration', () => {
  const msg = violationFeedback([{ kind: 'closure_missing', detail: 'x', action: 'block' }]);
  assert.ok(msg.includes('closure_missing'));
  assert.ok(msg.includes('重新生成'));
});

test('safeTemplate is itself contract-compliant and validator-clean', () => {
  const s = createInitialState('c1');
  const t = safeTemplate(s);
  const v = validateTurn(t, s);
  assert.equal(v.filter((x) => x.action === 'block').length, 0);
});

// ---------- claim detector unit ----------

test('findClaimSentences: catches realized claims, skips hedged ones', () => {
  const claims = findClaimSentences('孩子们都爱上了醒狮。孩子们可能会喜欢鼓点。');
  assert.equal(claims.length, 1);
  assert.ok(claims[0].includes('爱上'));
});

// ---------- engine: delta-aware stage gates (both directions) ----------

test('applyDelta: stage advances when the SAME delta supplies the prerequisites (any key order)', () => {
  const s = createInitialState('c1');
  const { state, violations } = applyDelta(s, {
    stage: 1, // stage listed FIRST on purpose — gate must see the merged candidate
    resource_entry_card: { original_theme: '龙舟' },
    theme_fit_level: 'theme_inquiry',
  });
  assert.equal(state.stage, 1);
  assert.equal(violations.length, 0, `no violations: ${JSON.stringify(violations)}`);
});

test('applyDelta: stage 1→2 legal when evidence + driving question arrive in the same delta', () => {
  const s = createInitialState('c1');
  s.stage = 1;
  s.resource_entry_card = { original_theme: '龙舟' };
  s.theme_fit_level = 'theme_inquiry';
  const { state, violations } = applyDelta(s, {
    children_evidence: [{ id: 'ev-n1', kind: 'child_words', content: '为什么要有鼓？', recorded_at: 'r1' }],
    driving_question: { candidates: ['我们怎样做一条会浮的小龙舟？'] },
    stage: 2,
  });
  assert.equal(state.stage, 2);
  assert.equal(violations.filter((v) => v.kind === 'illegal_stage_jump').length, 0);
});

test('applyDelta: stage stripped when the EVIDENCE gate is unmet', () => {
  const s = createInitialState('c1');
  s.stage = 1;
  const { state, violations } = applyDelta(s, { stage: 2 });
  assert.equal(state.stage, 1, '证据不足时阶段不推进');
  assert.ok(violations.some((v) => v.kind === 'illegal_stage_jump'));
});

test('applyDelta: 0→1 applies cleanly now the artifact gate is retired', () => {
  const s = createInitialState('c1');
  const { state, violations } = applyDelta(s, { stage: 1 });
  assert.equal(state.stage, 1);
  assert.equal(violations.filter((v) => v.kind === 'illegal_stage_jump').length, 0);
});

test('validateTurn: stage advisory is delta-aware both ways', () => {
  // Evidence supplied by the SAME delta counts toward the gate...
  const s = createInitialState('c1');
  s.stage = 1;
  const clean = goodTurn({ state_delta: { children_evidence: [{ id: 'ev-1', kind: 'child_words', content: '鼓好响', recorded_at: 'r1' }], stage: 2 } });
  assert.equal(validateTurn(clean, s).filter((v) => v.kind === 'illegal_stage_jump').length, 0);
  // ...and its absence is still caught.
  const bad = goodTurn({ state_delta: { stage: 2 } });
  assert.ok(validateTurn(bad, s).some((v) => v.kind === 'illegal_stage_jump'));
});

// ---------- engine: completed_nodes, after the chain (ADR-0012 §2) ----------

// `node_prerequisite` is RETIRED: it enforced the NODE_PREREQS dependency graph,
// which is the workflow chain itself, and the chain is gone. The direction that
// asserted it FIRES went with it — a retired rule has no violating fixture. What
// remains is the must-pass direction, which has to hold both before and after
// the graph is removed from engine.mjs: marking work done never gets stripped.
//
// Note the contrast with `illegal_stage_jump`, which shares the chain's
// vocabulary and was NOT retired: its ordinal check and its stage-2/5 evidence
// branches are structural integrity and non-negotiable #1, not chain order.

test('completed_nodes: applies when the earlier node is in the SAME delta (set semantics, any array order)', () => {
  const s = createInitialState('c1');
  const { state, violations } = applyDelta(s, { completed_nodes: ['WF07', 'WF06'] });
  assert.ok(state.completed_nodes.includes('WF06') && state.completed_nodes.includes('WF07'));
  assert.equal(violations.filter((v) => v.kind === 'node_prerequisite').length, 0);
});

test('completed_nodes: WF08 环境与计划 applies on its own', () => {
  const s = createInitialState('c1');
  const { state, violations } = applyDelta(s, { completed_nodes: ['WF08'] });
  assert.ok(state.completed_nodes.includes('WF08'), 'environment/plan work is not gated on WF07');
  assert.equal(violations.filter((v) => v.kind === 'node_prerequisite').length, 0);
});

test('completed_nodes: later nodes apply alongside ones recorded in earlier turns', () => {
  const s = createInitialState('c1');
  s.completed_nodes = ['WF28'];
  const { state, violations } = applyDelta(s, { completed_nodes: ['WF29', 'WF31'] });
  assert.ok(state.completed_nodes.includes('WF29') && state.completed_nodes.includes('WF31'));
  assert.equal(violations.filter((v) => v.kind === 'node_prerequisite').length, 0);
});
