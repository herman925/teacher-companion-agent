// Both-directions tests for the questions[] card contract (harness.mjs):
// normalization, prose-question retargeting, per-card completeness, the
// uncapped-but-warned count, the anti-dead-end warn, and style proxies.
// Every rule fires on a violating turn AND stays silent on a compliant one.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTurn, validateTurn, violationFeedback, safeTemplate } from '../src/harness.mjs';
import { createInitialState, applyDelta } from '../src/engine.mjs';
import { mockTurn } from '../src/mock.mjs';

const q = (text, n = 2) => ({
  text,
  why: '需要这条信息才能定下一步',
  examples: Array.from({ length: n }, (_, i) => `示例答案${i + 1}`),
});

function baseTurn(extra = {}) {
  return {
    reply_markdown: '我先根据你说的整理出方向，下面几件事想请你补充。',
    artifacts: [],
    closure_loop: null,
    state_delta: {},
    evidence_refs: [],
    round_complete: false,
    ...extra,
  };
}

// ---------- L2 normalization ----------

test('parseTurn: questions[] becomes canonical, question mirrors the first entry', () => {
  const { turn } = parseTurn(baseTurn({ questions: [q('班里多少个孩子？'), q('孩子看过龙舟吗？')] }));
  assert.equal(turn.questions.length, 2);
  assert.equal(turn.question.text, '班里多少个孩子？');
});

test('parseTurn: legacy singular question is wrapped into questions[]', () => {
  const { turn } = parseTurn(baseTurn({ question: q('班里多少个孩子？') }));
  assert.equal(turn.questions.length, 1);
  assert.equal(turn.questions[0].text, '班里多少个孩子？');
});

test('parseTurn: no questions at all → empty array, null question', () => {
  const { turn } = parseTurn(baseTurn());
  assert.deepEqual(turn.questions, []);
  assert.equal(turn.question, null);
});

// ---------- L3: questions stay out of prose ----------

test('multi_question: fires when prose asks questions alongside question cards', () => {
  const t = baseTurn({
    reply_markdown: '场地在哪里？家长能来吗？我先整理了方向。',
    questions: [q('班里多少个孩子？')],
  });
  const v = validateTurn(t, createInitialState('c1'));
  assert.ok(v.some((x) => x.kind === 'multi_question' && x.action === 'block'));
});

test('multi_question: silent when prose only cites a child question in quotes', () => {
  const t = baseTurn({
    reply_markdown: '有孩子问「为什么船头有龙的眼睛？」这句原话很有价值。',
    questions: [q('这句话是哪个孩子说的？')],
  });
  const v = validateTurn(t, createInitialState('c1'));
  assert.equal(v.filter((x) => x.kind === 'multi_question').length, 0);
});

// ---------- L3: per-card completeness ----------

test('question_no_examples: fires when any card lacks examples or text', () => {
  const t = baseTurn({ questions: [q('完整的问题？'), { text: '缺示例的问题？', why: 'x', examples: [] }] });
  const v = validateTurn(t, createInitialState('c1'));
  assert.ok(v.some((x) => x.kind === 'question_no_examples' && x.action === 'block'));
});

test('question_no_examples: silent when every card is complete', () => {
  const t = baseTurn({ questions: [q('问题一？'), q('问题二？', 3)] });
  const v = validateTurn(t, createInitialState('c1'));
  assert.equal(v.filter((x) => x.kind === 'question_no_examples').length, 0);
});

// ---------- L3: uncapped count, warn above threshold ----------

test('many_questions: warn (not block) above 5 cards', () => {
  const t = baseTurn({ questions: Array.from({ length: 6 }, (_, i) => q(`问题${i + 1}？`)) });
  const v = validateTurn(t, createInitialState('c1'));
  const hit = v.find((x) => x.kind === 'many_questions');
  assert.ok(hit);
  assert.equal(hit.action, 'warn');
  assert.equal(v.filter((x) => x.action === 'block').length, 0);
});

test('many_questions: silent at 5 cards', () => {
  const t = baseTurn({ questions: Array.from({ length: 5 }, (_, i) => q(`问题${i + 1}？`)) });
  const v = validateTurn(t, createInitialState('c1'));
  assert.equal(v.filter((x) => x.kind === 'many_questions').length, 0);
});

// ---------- L3: anti-dead-end ----------

test('no_forward_handle: warns on a mid-round turn with nothing to grab', () => {
  const t = baseTurn({ reply_markdown: '这个想法不错。' });
  const v = validateTurn(t, createInitialState('c1'));
  const hit = v.find((x) => x.kind === 'no_forward_handle');
  assert.ok(hit);
  assert.equal(hit.action, 'warn');
});

test('no_forward_handle: silent when the turn carries cards, artifacts, or closes the round', () => {
  const withCards = baseTurn({ questions: [q('下一步想先看什么？')] });
  const withArtifact = baseTurn({ artifacts: [{ type: 'question_pool', title: '问题池', data: {} }] });
  const closing = baseTurn({
    round_complete: true,
    closure_loop: { do_now: '去河边看训练', materials: '记录卡', bring_back: '三句原话', i_will: '整理问题池' },
  });
  for (const t of [withCards, withArtifact, closing]) {
    assert.equal(validateTurn(t, createInitialState('c1')).filter((x) => x.kind === 'no_forward_handle').length, 0);
  }
});

// ---------- L3: style proxies (warn only) ----------

test('style proxy 极简速览: warns on long prose, silent on short', () => {
  const long = baseTurn({ reply_markdown: '很长的正文。'.repeat(300), questions: [q('问题？')] });
  const short = baseTurn({ reply_markdown: '短。', questions: [q('问题？')] });
  const vLong = validateTurn(long, createInitialState('c1'), { stylePref: '极简速览（电报体、越短越好）' });
  const hit = vLong.find((x) => x.kind === 'style_mismatch');
  assert.ok(hit);
  assert.equal(hit.action, 'warn');
  const vShort = validateTurn(short, createInitialState('c1'), { stylePref: '极简速览（电报体、越短越好）' });
  assert.equal(vShort.filter((x) => x.kind === 'style_mismatch').length, 0);
});

test('style proxy 提问引导: warns when a mid-round turn asks nothing, silent with cards or at round end', () => {
  const silentTurn = baseTurn({ reply_markdown: '建议先看看材料。' });
  const v = validateTurn(silentTurn, createInitialState('c1'), { stylePref: '提问引导（先问再建议）' });
  assert.ok(v.some((x) => x.kind === 'style_mismatch' && x.action === 'warn'));
  const withCards = baseTurn({ questions: [q('现场情况如何？')] });
  const v2 = validateTurn(withCards, createInitialState('c1'), { stylePref: '提问引导（先问再建议）' });
  assert.equal(v2.filter((x) => x.kind === 'style_mismatch').length, 0);
});

test('style proxies: silent entirely when no style is chosen', () => {
  const t = baseTurn({ reply_markdown: '很长的正文。'.repeat(300), questions: [q('问题？')] });
  const v = validateTurn(t, createInitialState('c1'));
  assert.equal(v.filter((x) => x.kind === 'style_mismatch').length, 0);
});

// ---------- L4: warns never reach the retry feedback ----------

test('violationFeedback lists blocks only — warns never trigger or pollute the rewrite', () => {
  const feedback = violationFeedback([
    { kind: 'many_questions', detail: '6 张卡', action: 'warn' },
    { kind: 'fabrication', detail: '断言无证据', action: 'block' },
  ]);
  assert.ok(feedback.includes('fabrication'));
  assert.ok(!feedback.includes('many_questions'));
});

test('safeTemplate carries both question shapes', () => {
  const t = safeTemplate(createInitialState('c1'));
  assert.equal(t.questions.length, 1);
  assert.equal(t.question.text, t.questions[0].text);
});

// ---------- mock: batch-answer fast paths (多问一答 → 一次点亮多节点) ----------

/** Run one mock turn through the real L2/L3 pipeline and apply its delta. */
function step(state, history, message) {
  const { turn, violations: pv } = parseTurn(mockTurn(state, history, message));
  assert.ok(turn, 'turn parses');
  assert.equal(pv.length, 0, 'parse clean');
  const blocking = validateTurn(turn, state).filter((v) => v.action === 'block');
  assert.deepEqual(blocking, [], 'no blocking violations: ' + JSON.stringify(blocking));
  const applied = applyDelta(state, turn.state_delta, { roundComplete: turn.round_complete, teacherTurn: true });
  return { turn, state: applied.state };
}

test('optimize fast path: entry cards batch-answered with 原话 → backfill AND evidence in one turn', () => {
  let state = createInitialState('opt-fast');
  const history = [];
  const r1 = step(state, history, '我们班在做龙舟主题，想优化');
  assert.equal(r1.turn.questions.length, 2, 'entry carries two cards');
  history.push({ role: 'user', content: '我们班在做龙舟主题，想优化' }, { role: 'assistant', content: r1.turn.reply_markdown });
  state = r1.state;

  const packed = '【问题卡回复】\n1. 「你们现在手上已经有什么，做到哪一步了？」：有主题网络，但孩子兴趣散\n2. 「这段时间里，孩子说过哪几句让你印象深的话？」：有孩子问龙舟为什么要有鼓，还有孩子说想自己做一条会浮的龙舟';
  const r2 = step(state, history, packed);
  const types = r2.turn.artifacts.map((a) => a.type);
  assert.ok(types.includes('entry_card') && types.includes('question_pool') && types.includes('driving_questions'),
    'one turn carries backfill AND evidence artifacts: ' + types.join(','));
  assert.ok(r2.state.resource_entry_card, 'entry card written');
  assert.ok((r2.state.children_evidence || []).length >= 3, 'evidence ingested');
  assert.ok((r2.state.driving_question?.candidates || []).length >= 2, 'driving candidates written');
  assert.equal(r2.state.stage, 1, 'stage advanced 0→1 only (no illegal jump)');
});

test('optimize fast path: skipped 原话 card does NOT trigger it (quoted titles are stripped)', () => {
  let state = createInitialState('opt-slow');
  const history = [];
  const r1 = step(state, history, '我们班在做龙舟主题，想优化');
  history.push({ role: 'user', content: '我们班在做龙舟主题，想优化' }, { role: 'assistant', content: r1.turn.reply_markdown });
  state = r1.state;

  // Card 2 skipped — the packaged text still contains 「问」-quoted titles with 说/问,
  // which must NOT count as 原话 (answersOnly strips them).
  const packed = '【问题卡回复】\n1. 「你们现在手上已经有什么，做到哪一步了？」：有主题网络\n2. 「这段时间里，孩子说过哪几句让你印象深的话？」：（跳过）';
  const r2 = step(state, history, packed);
  const types = r2.turn.artifacts.map((a) => a.type);
  assert.ok(!types.includes('question_pool'), 'no evidence turn without real 原话');
  assert.ok(r2.state.resource_entry_card, 'backfill still lands');
  assert.equal((r2.state.children_evidence || []).length, 0, 'no fabricated evidence');
});

test('story fast path: entry cards batch-answered with 原话 → materials AND spine in one turn', () => {
  let state = createInitialState('story-fast');
  const history = [];
  const r1 = step(state, history, '我有一堆照片想整理成课程故事');
  assert.equal(r1.turn.questions.length, 2, 'entry carries two cards');
  history.push({ role: 'user', content: '我有一堆照片想整理成课程故事' }, { role: 'assistant', content: r1.turn.reply_markdown });
  state = r1.state;

  const packed = '【问题卡回复】\n1. 「这堆照片主要拍的是什么？」：主要是活动过程照片，还有几段采访视频\n2. 「你还记得孩子当时说过哪几句话吗？」：有孩子说：这是我们一起做出来的';
  const r2 = step(state, history, packed);
  const types = r2.turn.artifacts.map((a) => a.type);
  assert.ok(types.includes('story_fragment'), 'spine arrives in the same turn');
  assert.ok(r2.state.story_materials?.narrative_spine, 'narrative spine written');
  assert.equal(r2.state.stage, 5, 'stage 0→5 (the one legal long jump)');
});
