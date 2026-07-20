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

// ---------- L3: closure loop ----------

test('closure loop: fires when round_complete lacks closure', () => {
  const v = validateTurn(goodTurn({ closure_loop: null }), createInitialState('c1'));
  assert.ok(v.some((x) => x.kind === 'closure_missing'));
});

test('closure loop: fires when an element is empty', () => {
  const v = validateTurn(goodTurn({ closure_loop: { ...goodClosure, bring_back: ' ' } }), createInitialState('c1'));
  assert.ok(v.some((x) => x.kind === 'closure_incomplete' && x.detail.includes('bring_back')));
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

test('adult slogan: silent in teacher-backstage question_pool cultural hints', () => {
  const t = goodTurn({ artifacts: [{ type: 'question_pool', title: '问题池', data: { hint: '教师后台可关注：这背后有代际传承的生活经验（不讲给孩子）' } }] });
  const v = validateTurn(t, createInitialState('c1'));
  assert.equal(v.filter((x) => x.kind === 'adult_slogan').length, 0);
});

// ---------- engine: stage gates ----------

test('stage gate: blocks 0→2 jump and 0→1 without entry card', () => {
  const s = createInitialState('c1');
  assert.ok(stageGateError(s, 2));
  assert.ok(stageGateError(s, 1));
});

test('stage gate: allows 0→1 once entry card + fit level exist', () => {
  const s = createInitialState('c1');
  s.resource_entry_card = { original_theme: '龙舟' };
  s.theme_fit_level = 'theme_inquiry';
  assert.equal(stageGateError(s, 1), null);
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

test('applyDelta: awaiting_feedback lifecycle — set on round_complete, cleared on teacher turn', () => {
  const s = createInitialState('c1');
  const closed = applyDelta(s, {}, { roundComplete: true }).state;
  assert.equal(closed.awaiting_feedback, true);
  const reopened = applyDelta(closed, {}, { teacherTurn: true }).state;
  assert.equal(reopened.awaiting_feedback, false);
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

test('applyDelta: stage still stripped when prerequisites are missing from state AND delta', () => {
  const s = createInitialState('c1');
  const { state, violations } = applyDelta(s, { stage: 1 });
  assert.equal(state.stage, 0);
  assert.ok(violations.some((v) => v.kind === 'illegal_stage_jump'));
});

test('validateTurn: stage advisory is delta-aware both ways', () => {
  const clean = goodTurn({ state_delta: { resource_entry_card: { original_theme: '龙舟' }, theme_fit_level: 'theme_inquiry', stage: 1 } });
  assert.equal(validateTurn(clean, createInitialState('c1')).filter((v) => v.kind === 'illegal_stage_jump').length, 0);
  const bad = goodTurn({ state_delta: { stage: 1 } });
  assert.ok(validateTurn(bad, createInitialState('c1')).some((v) => v.kind === 'illegal_stage_jump'));
});

// ---------- engine: node prerequisite check (partial order, both directions) ----------

test('node prereq: fires when WF07 is marked without WF06 in state or delta', () => {
  const s = createInitialState('c1');
  const { state, violations } = applyDelta(s, { completed_nodes: ['WF07'], theme_fit_level: 'short_activity' });
  assert.ok(!state.completed_nodes.includes('WF07'), 'WF07 stripped');
  assert.equal(state.theme_fit_level, 'short_activity', 'rest of the delta still applies');
  assert.ok(violations.some((v) => v.kind === 'node_prerequisite' && v.action === 'strip' && v.detail.includes('WF06')));
});

test('node prereq: silent when the prerequisite arrives in the SAME delta (set semantics, any array order)', () => {
  const s = createInitialState('c1');
  const { state, violations } = applyDelta(s, { completed_nodes: ['WF07', 'WF06'] });
  assert.ok(state.completed_nodes.includes('WF06') && state.completed_nodes.includes('WF07'));
  assert.equal(violations.filter((v) => v.kind === 'node_prerequisite').length, 0);
});

test('node prereq: WF08 环境与计划 needs no question pool anymore (stage1-v1.0 re-bind)', () => {
  const s = createInitialState('c1');
  const { state, violations } = applyDelta(s, { completed_nodes: ['WF08'] });
  assert.ok(state.completed_nodes.includes('WF08'), 'environment/plan work is not gated on WF07');
  assert.equal(violations.filter((v) => v.kind === 'node_prerequisite').length, 0);
});

test('node prereq: satisfied by completed_nodes recorded in earlier turns', () => {
  const s = createInitialState('c1');
  s.completed_nodes = ['WF28'];
  const { state, violations } = applyDelta(s, { completed_nodes: ['WF29', 'WF31'] });
  assert.ok(state.completed_nodes.includes('WF29') && state.completed_nodes.includes('WF31'));
  assert.equal(violations.filter((v) => v.kind === 'node_prerequisite').length, 0);
});
