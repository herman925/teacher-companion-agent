// The scripted mock walkthroughs must themselves survive the runtime harness —
// every canned turn in every flow passes L2/L3 and every delta applies without
// gate violations, exactly as serve.mjs runs them. WF01 entry recognition must
// route each starter to its own flow, and each flow must demonstrate a
// DIFFERENT set of V1.3 workflow nodes (wf_trace). If a validator tightens or
// the mock drifts, this fails before a human demo does.

import test from 'node:test';
import assert from 'node:assert/strict';

import { mockTurn } from '../src/mock.mjs';
import { parseTurn, validateTurn } from '../src/harness.mjs';
import { createInitialState, applyDelta } from '../src/engine.mjs';

const SCRIPTS = {
  from_zero: [
    '我想带中班孩子做醒狮',
    '园附近每年都有醒狮活动，孩子们见过但只是看热闹，我希望他们多一点真实接触',
    '我们去看了训练。孩子们问狮子的眼睛为什么会眨，还有人问能不能进到狮子里面；好几个孩子自发模仿马步，在狮头架前停留很久。',
    '孩子们投票选了排小醒狮给弟弟妹妹看，最想解决怎么配合',
    '想把前面这段整理成课程故事的开头',
  ],
  optimize_existing: [
    '我们班在做龙舟主题，想优化',
    '有主题网络，但孩子兴趣散，做了两周活动不知道下一步',
    '有孩子问龙舟为什么要有鼓，还有孩子说想自己做一条会浮的龙舟',
  ],
  story_export: [
    '我有一堆照片想整理成课程故事',
    '主要是活动过程照片，还有孩子的作品和涂鸦，以及几段采访视频',
    '有孩子说这是我们一起做出来的，还有孩子说下次还想再做一遍',
  ],
  mid_course: [
    '昨天孩子们做狮头卡住了，想聊聊下一步',
    '孩子们试了纸箱做狮头，卡在固定不住；最活跃的是小宇，一直在指挥别人；我想知道下一轮该分组还是集体',
  ],
  material_support: [
    '我想要一份趁墟的亲子调查素材',
    '给家长的调查表',
  ],
};

/**
 * Drive a scripted flow through the REAL pipeline (parseTurn → validateTurn →
 * applyDelta), asserting every turn is contract-compliant and gate-legal.
 * Mirrors serve.mjs runTurn for provider === 'mock'.
 */
function runFlow(script, label) {
  let state = createInitialState(label);
  const history = [];
  const turns = [];
  const states = [];
  const stages = [state.stage];

  for (const [i, message] of script.entries()) {
    const raw = mockTurn(state, history, message);
    const { turn, violations: parseV } = parseTurn(raw);
    assert.ok(turn, `${label} turn ${i + 1} parses`);
    assert.equal(parseV.length, 0, `${label} turn ${i + 1} parse clean`);

    const blocking = validateTurn(turn, state).filter((v) => v.action === 'block');
    assert.deepEqual(blocking, [], `${label} turn ${i + 1} has no blocking violations: ${JSON.stringify(blocking)}`);

    const applied = applyDelta(state, turn.state_delta, { roundComplete: turn.round_complete, teacherTurn: true });
    assert.deepEqual(
      applied.violations.filter((v) => v.kind === 'illegal_stage_jump' || v.kind === 'bad_delta'),
      [], `${label} turn ${i + 1} writes only whitelisted fields via legal stage moves`,
    );
    state = applied.state;
    turns.push(turn);
    states.push(state);
    stages.push(state.stage);
    history.push({ role: 'user', content: message }, { role: 'assistant', content: turn.reply_markdown });
  }
  return { state, turns, states, stages };
}

/** Union of workflow node ids a flow's wf_trace annotations demonstrate. */
function traceNodeIds(turns) {
  return new Set(turns.flatMap((t) => (t.wf_trace?.nodes ?? []).map((n) => n.id)));
}

/** Every turn must carry a dev-facing wf_trace with at least one node. */
function assertWfTraces(turns, label) {
  for (const [i, t] of turns.entries()) {
    assert.ok(t.wf_trace, `${label} turn ${i + 1} carries wf_trace`);
    assert.ok(Array.isArray(t.wf_trace.nodes) && t.wf_trace.nodes.length > 0, `${label} turn ${i + 1} wf_trace has nodes`);
  }
}

// ---------------------------------------------------------------- 从零陪跑

test('from_zero: full walkthrough is contract-compliant and progresses the course', () => {
  const { state, turns, states } = runFlow(SCRIPTS.from_zero, 'flow-from-zero');
  assertWfTraces(turns, 'from_zero');
  assert.equal(states[0].teacher_mode, 'from_zero', 'WF01 classifies the starter as 从零陪跑');
  assert.ok(state.stage >= 2, `course advanced past intake (stage=${state.stage})`);
  assert.ok(state.children_evidence.length >= 5, 'evidence ledger populated');
  assert.ok(state.driving_question?.text, 'driving question chosen');
  assert.ok(state.story_materials?.gaps?.length, 'story fragment lists honest gaps');
  assert.equal(state.awaiting_feedback, true, 'last scripted turn closes a round');
  assert.ok(traceNodeIds(turns).has('WF03b'), 'from_zero demonstrates WF03b 资源意图确认');
});

// ------------------------------------------------------------ 已有主题优化

test('optimize_existing: backfill then evidence-first sharpening, stage 0→1→2', () => {
  const { state, turns, states, stages } = runFlow(SCRIPTS.optimize_existing, 'flow-optimize');
  assertWfTraces(turns, 'optimize_existing');
  assert.equal(states[0].teacher_mode, 'optimize_existing', 'WF01 classifies the starter as 已有主题优化');
  assert.equal(stages[1], 0, 'turn 1 only asks — no stage move without backfill');
  assert.equal(states[1].stage, 1, 'turn 2 backfills entry card + fit level and legally enters stage 1');
  assert.ok(states[1].resource_entry_card, 'entry card backfilled (已有主题回填)');
  assert.equal(states[1].children_evidence.length, 0, 'turn 2 asks for evidence instead of inventing it');
  assert.equal(state.stage, 2, 'turn 3 legally enters stage 2 with evidence + driving question in the same delta');
  assert.ok(state.children_evidence.length >= 3, 'child words ingested as evidence');
  assert.ok(state.child_question_pool.length >= 3, '儿童问题池 built from evidence');
  assert.ok((state.driving_question?.candidates || []).length >= 2, 'sharpened 核心驱动问题 candidates proposed');
});

// ------------------------------------------------------------ 课程故事整理

test('story_export: stage jumps to 5 ONLY after children_evidence is non-empty', () => {
  const { state, turns, states, stages } = runFlow(SCRIPTS.story_export, 'flow-story');
  assertWfTraces(turns, 'story_export');
  assert.equal(states[0].teacher_mode, 'story_export', 'WF01 classifies the starter as 课程故事整理');
  assert.equal(stages[1], 0, 'turn 1 keeps stage 0');
  assert.equal(stages[2], 0, 'turn 2 (materials ingest) still keeps stage 0');
  assert.ok(states[1].children_evidence.length > 0, 'turn 2 records materials as evidence before any jump');
  assert.ok(states[1].story_materials?.gaps?.length, 'WF28 lists gaps honestly instead of fabricating');
  assert.equal(state.stage, 5, 'turn 3 legally jumps to stage 5 (evidence non-empty, jump-to-5 allowed)');
  const spine = turns[2].artifacts.find((a) => a.type === 'story_fragment');
  assert.ok(spine, 'turn 3 produces the WF29 story_fragment spine');
  assert.ok((spine.data.chapters || []).length >= 3, 'spine has 3–4 chapters');
  assert.ok(turns[2].question && turns[2].question.examples.length >= 2, 'turn 3 asks the WF32 version question');
  const ids = traceNodeIds(turns);
  assert.ok(ids.has('WF28') && ids.has('WF29'), 'story_export demonstrates WF28 + WF29');
});

// -------------------------------------------------------------- 过程中续聊

test('mid_course: honest backfill, WF20 review, no illegal 0→3 jump', () => {
  const { state, turns, states } = runFlow(SCRIPTS.mid_course, 'flow-mid');
  assertWfTraces(turns, 'mid_course');
  assert.equal(states[0].teacher_mode, 'mid_course', 'WF01 classifies the starter as 过程中续聊');
  assert.equal(state.stage, 0, 'stage honestly stays 0 — jumping 0→3 is forbidden');
  assert.ok(state.children_evidence.length >= 2, 'field feedback ingested as evidence');
  assert.ok(state.teacher_focus_feedback.length >= 1, '三句聚焦反馈 recorded');
  assert.ok(state.child_participation_difference.length >= 1, 'participation difference (小宇) recorded');
  assert.ok(turns[1].artifacts.some((a) => a.type === 'cycle_task'), 'WF21 produces the next cycle_task');
  assert.ok(turns[1].reply_markdown.startsWith('先回答'), 'the judgment question (第三句) is answered first');
  const ids = traceNodeIds(turns);
  assert.ok(ids.has('WF20') && ids.has('WF20b') && ids.has('WF21'), 'mid_course demonstrates WF20/WF20b/WF21');
});

// ---------------------------------------------------------------- 素材支持

test('material_support: direct text scaffold, no stage change, closure on delivery', () => {
  const { state, turns, states } = runFlow(SCRIPTS.material_support, 'flow-material');
  assertWfTraces(turns, 'material_support');
  assert.equal(states[0].teacher_mode, 'material_support', 'WF01 classifies the starter as 素材支持');
  assert.equal(state.stage, 0, 'material support never moves the course stage');
  assert.ok(turns[0].reply_markdown.includes('调查表'), 'turn 1 delivers the text scaffold directly in the reply');
  assert.ok(turns[0].question && turns[0].question.examples.length >= 2, 'turn 1 asks one scene question');
  assert.equal(turns[1].round_complete, true, 'delivery turn closes the round with a full closure loop');
  assert.equal(state.awaiting_feedback, false, '素材交付无儿童证据——不得进入等待回传状态');
  assert.ok(traceNodeIds(turns).has('WF22'), 'material_support demonstrates WF22');
});

// -------------------------------------------------------- flows are distinct

test('flows are distinct: each mode demonstrates a different node union', () => {
  const unions = {};
  for (const [mode, script] of Object.entries(SCRIPTS)) {
    const { turns } = runFlow(script, `distinct-${mode}`);
    unions[mode] = traceNodeIds(turns);
  }
  const modes = Object.keys(unions);
  for (let i = 0; i < modes.length; i += 1) {
    for (let j = i + 1; j < modes.length; j += 1) {
      const a = [...unions[modes[i]]].sort().join(',');
      const b = [...unions[modes[j]]].sort().join(',');
      assert.notEqual(a, b, `${modes[i]} and ${modes[j]} must not demonstrate identical node sets`);
    }
  }
  assert.ok(unions.story_export.has('WF28') && unions.story_export.has('WF29'));
  assert.ok(unions.from_zero.has('WF03b'));
  assert.ok(unions.mid_course.has('WF20'));
  assert.ok(unions.optimize_existing.has('WF04'));
  assert.ok(unions.material_support.has('WF22'));
});

// --------------------------------------- negative fixtures (both directions)

test('negative: an illegal stage jump proposal is stripped, state stays put', () => {
  const s = createInitialState('neg-jump');
  const { state, violations } = applyDelta(s, { stage: 3 });
  assert.equal(state.stage, 0, 'jump 0→3 stripped');
  assert.ok(violations.some((v) => v.kind === 'illegal_stage_jump'));
});

test('negative: a fabricated child-claim turn without evidence refs is blocked', () => {
  const fabricated = {
    reply_markdown: '孩子们已经掌握了舞狮的全部鼓点，大家都爱上了排练。',
    question: null,
    artifacts: [],
    closure_loop: null,
    state_delta: {},
    evidence_refs: [],
    round_complete: false,
  };
  const { turn } = parseTurn(fabricated);
  const v = validateTurn(turn, createInitialState('neg-fab'));
  assert.ok(v.some((x) => x.kind === 'fabrication' && x.action === 'block'), 'validateTurn fires on the violating fixture');
});

test('wf_trace passes through parseTurn untouched; absent stays null', () => {
  const withTrace = parseTurn({
    reply_markdown: '好的。',
    wf_trace: { mode: '从零陪跑', stage: 0, nodes: [{ id: 'WF01', name: '入口识别', apply: 'x' }], principles: ['状态机优先'], state_notes: 'n' },
  });
  assert.equal(withTrace.turn.wf_trace.nodes[0].id, 'WF01');
  const withoutTrace = parseTurn({ reply_markdown: '好的。' });
  assert.equal(withoutTrace.turn.wf_trace, null);
});

// --------------------------------- awaiting-phase liveliness (from_zero fixes)

/** One pipeline step (parse → validate → apply) with history bookkeeping. */
function step(state, history, message) {
  const raw = mockTurn(state, history, message);
  const { turn } = parseTurn(raw);
  assert.ok(turn, 'turn parses');
  const blocking = validateTurn(turn, state).filter((v) => v.action === 'block');
  assert.deepEqual(blocking, [], `no blocking violations: ${JSON.stringify(blocking)}`);
  const applied = applyDelta(state, turn.state_delta, { roundComplete: turn.round_complete, teacherTurn: true });
  history.push({ role: 'user', content: message }, { role: 'assistant', content: turn.reply_markdown });
  return { turn, state: applied.state, violations: applied.violations };
}

test('from_zero turn 2 (切口卡) is fully clean — zero violations of ANY level', () => {
  let state = createInitialState('clean-entry');
  const history = [];
  ({ state } = step(state, history, '我想带中班孩子做醒狮'));
  const raw = mockTurn(state, history, '园附近每年都有醒狮活动，孩子们其实见过，但只是看热闹');
  const { turn } = parseTurn(raw);
  const validateV = validateTurn(turn, state);
  assert.deepEqual(validateV, [], `validateTurn totally silent: ${JSON.stringify(validateV)}`);
  const applied = applyDelta(state, turn.state_delta, { roundComplete: turn.round_complete, teacherTurn: true });
  assert.deepEqual(applied.violations, [], `applyDelta totally silent: ${JSON.stringify(applied.violations)}`);
  assert.equal(applied.state.stage, 1, 'stage legally advances in the self-satisfying delta');
});

test('awaiting phase: entry choice is acknowledged and written into the entry card', () => {
  let state = createInitialState('choice');
  const history = [];
  ({ state } = step(state, history, '我想带中班孩子做醒狮'));
  ({ state } = step(state, history, '园附近每年都有醒狮活动，孩子们其实见过，但只是看热闹'));
  const r = step(state, history, '狮头入口——班里孩子对面具类的东西一直很着迷');
  state = r.state;
  assert.ok(r.turn.reply_markdown.includes('狮头'), 'acknowledges the chosen entry specifically');
  assert.ok(!r.turn.reply_markdown.includes('我先在这里等'), 'not a generic awaiting reply');
  assert.equal(state.resource_entry_card.chosen_entry, '狮头入口', 'choice written into resource_entry_card');
  assert.equal(state.resource_entry_card.original_theme, '醒狮', 'existing card fields carried forward');
  assert.ok(r.turn.wf_trace.nodes.some((n) => n.id === 'WF09'), 'WF09 战术性环境支持 in trace');
  assert.deepEqual(r.violations, [], 'choice turn applies clean');
});

test('awaiting phase: nudges never repeat verbatim and explain empty deltas', () => {
  let state = createInitialState('nudge');
  const history = [];
  ({ state } = step(state, history, '我想带中班孩子做醒狮'));
  ({ state } = step(state, history, '园附近每年都有醒狮活动，孩子们其实见过，但只是看热闹'));
  const n1 = step(state, history, '還有呢？');
  state = n1.state;
  const n2 = step(state, history, '還有呢？');
  state = n2.state;
  assert.notEqual(n1.turn.reply_markdown, n2.turn.reply_markdown, 'second nudge varies');
  for (const t of [n1.turn, n2.turn]) {
    assert.ok(t.wf_trace && t.wf_trace.nodes.length > 0, 'trace present on nudge turns');
    assert.ok(t.wf_trace.state_notes.includes('无状态写入'), 'empty delta explained in state_notes');
  }
  // Real field feedback still lands after the detour.
  const f = step(state, history, '我们去看了训练。孩子们问狮子的眼睛为什么会眨，好几个孩子自发模仿马步，在狮头架前停留很久。');
  assert.ok(f.state.children_evidence.length >= 5, 'field feedback still ingests after nudges');
});

test('awaiting phase: in-place support (家长素材) answers without fabricating progress', () => {
  let state = createInitialState('support');
  const history = [];
  ({ state } = step(state, history, '我想带中班孩子做醒狮'));
  ({ state } = step(state, history, '园附近每年都有醒狮活动，孩子们其实见过，但只是看热闹'));
  const r = step(state, history, '能不能先来一段给家长的话，解释我们为什么要去看训练');
  assert.ok(r.turn.reply_markdown.includes('家长'), 'delivers the parent-facing scaffold');
  assert.equal(r.state.children_evidence.length, 0, 'no fabricated classroom progress');
  assert.equal(r.state.stage, 1, 'stage untouched');
  assert.ok(r.turn.wf_trace.nodes.some((n) => n.id === 'WF22'), 'WF22 in trace');
});

test('other flows: awaiting nudges vary instead of fabricating or repeating', () => {
  // story_export: a 记不全 answer must NOT fabricate 原话 and must vary on repeat.
  let state = createInitialState('story-wait');
  const history = [];
  ({ state } = step(state, history, '我有一堆照片想整理成课程故事'));
  ({ state } = step(state, history, '主要是活动过程照片，还有孩子的作品和涂鸦，以及几段采访视频'));
  const w1 = step(state, history, '记不全了，我再想想');
  state = w1.state;
  assert.equal(state.stage, 0, 'no stage 5 jump without 原话');
  assert.equal(state.children_evidence.filter((e) => e.kind === 'child_words').length, 0, 'no fabricated 原话');
  const w2 = step(state, history, '還有呢？');
  assert.notEqual(w1.turn.reply_markdown, w2.turn.reply_markdown, 'story wait varies');

  // material_support: repeated nudges cycle variants, never verbatim-adjacent.
  let ms = createInitialState('mat-wait');
  const mh = [];
  ({ state: ms } = step(ms, mh, '我想要一份趁墟的亲子调查素材'));
  const d1 = step(ms, mh, '给家长的调查表');
  ms = d1.state;
  const d2 = step(ms, mh, '還有呢？');
  ms = d2.state;
  const d3 = step(ms, mh, '再来');
  assert.notEqual(d1.turn.reply_markdown, d2.turn.reply_markdown, 'material nudge varies (1→2)');
  assert.notEqual(d2.turn.reply_markdown, d3.turn.reply_markdown, 'material nudge varies (2→3)');
});
