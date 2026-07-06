// FLOW CRAWLER — every node must be able to reach the final goal.
// Programmatically walks all five flows through the REAL pipeline:
//   · every question's example chips are forked and must lead somewhere sane;
//   · every step: zero blocking violations, wf_trace present, no verbatim
//     repeat of the previous assistant reply, never the dead awaiting text;
//   · every flow reaches its terminal deliverable;
//   · post-terminal generic follow-ups hit the 演示边界 horizon (varied).

import test from 'node:test';
import assert from 'node:assert/strict';

import { mockTurn } from '../src/mock.mjs';
import { parseTurn, validateTurn } from '../src/harness.mjs';
import { createInitialState, applyDelta } from '../src/engine.mjs';

const DEAD_AWAITING = '我先在这里等你带孩子去现场';
const HORIZON_RE = /演示脚本到这里|演示的边界/;
const GENERIC_FOLLOWUPS = ['好的', '還有呢？', '然后呢'];

const coverage = { steps: 0, branches: 0 };

/** One asserted pipeline step; returns the applied state + turn. */
function stepAssert(state, history, message, label) {
  const raw = mockTurn(state, history, message);
  const { turn, violations: pv } = parseTurn(raw);
  assert.ok(turn, label + ' parses');
  assert.equal(pv.length, 0, label + ' parse clean');
  const blocking = validateTurn(turn, state).filter((v) => v.action === 'block');
  assert.deepEqual(blocking, [], label + ' blocking: ' + JSON.stringify(blocking));
  assert.ok(turn.wf_trace && Array.isArray(turn.wf_trace.nodes) && turn.wf_trace.nodes.length > 0, label + ' wf_trace present');
  assert.ok(typeof turn.wf_trace.state_notes === 'string' && turn.wf_trace.state_notes.length > 0, label + ' state_notes present');
  assert.ok(!turn.reply_markdown.includes(DEAD_AWAITING), label + ' never the dead awaiting text');
  const prevAssistant = [...history].reverse().find((m) => m.role === 'assistant');
  if (prevAssistant) assert.notEqual(turn.reply_markdown, prevAssistant.content, label + ' no verbatim repeat');
  const applied = applyDelta(state, turn.state_delta, { roundComplete: turn.round_complete, teacherTurn: true });
  const dirty = applied.violations.filter((v) => ['illegal_stage_jump', 'bad_delta', 'node_prerequisite'].includes(v.kind));
  assert.deepEqual(dirty, [], label + ' delta clean: ' + JSON.stringify(dirty));
  coverage.steps += 1;
  return { turn, state: applied.state };
}

/**
 * Walk a flow: scripted main path (forking every chip of the previous turn's
 * question), terminal check, then generic follow-ups → horizon.
 */
function walk(flowName, script, terminalCheck) {
  let state = createInitialState('crawl-' + flowName);
  let history = [];
  const turns = [];

  for (const [i, message] of script.entries()) {
    const label = flowName + ' step ' + (i + 1);
    const prevTurn = turns[turns.length - 1];
    if (prevTurn?.question?.examples) {
      for (const example of prevTurn.question.examples) {
        const forkState = structuredClone(state);
        const forkHistory = structuredClone(history);
        stepAssert(forkState, forkHistory, example, label + ' fork「' + example.slice(0, 10) + '…」');
        coverage.branches += 1;
      }
    }
    const r = stepAssert(state, history, message, label);
    history.push({ role: 'user', content: message }, { role: 'assistant', content: r.turn.reply_markdown });
    state = r.state;
    turns.push(r.turn);
  }

  assert.ok(terminalCheck(state, turns), flowName + ' reached its terminal deliverable');

  const horizonReplies = [];
  for (const [i, message] of GENERIC_FOLLOWUPS.entries()) {
    const r = stepAssert(state, history, message, flowName + ' post-terminal ' + (i + 1));
    assert.match(r.turn.reply_markdown, HORIZON_RE, flowName + ' post-terminal ' + (i + 1) + ' is the horizon');
    assert.ok(r.turn.wf_trace.state_notes.includes('演示脚本边界'), flowName + ' horizon trace explains itself');
    horizonReplies.push(r.turn.reply_markdown);
    history.push({ role: 'user', content: message }, { role: 'assistant', content: r.turn.reply_markdown });
    state = r.state;
  }
  assert.ok(new Set(horizonReplies).size >= 2, flowName + ' horizon uses at least two phrasings');

  return { state, turns, history };
}

// ------------------------------------------------------------- flow walks

test('crawler: from_zero reaches stage 3 via pick → cycle 1 → cycle 2, then horizon', () => {
  const { state } = walk('from_zero', [
    '我想带中班孩子做醒狮',
    '园附近每年都有醒狮活动，孩子们其实见过，但只是看热闹',
    '我们去看了训练。孩子们问狮子的眼睛为什么会眨，还有人问能不能进到狮子里面；好几个孩子自发模仿马步，在狮头架前停留很久。',
    '孩子们投票选了排小醒狮给弟弟妹妹看，最想解决怎么配合',
    '好的',
    '第一次排练卡在两人配合上，有孩子提议喊一二一二，还有孩子说想请师傅来看看',
  ], (state) => state.stage === 3
    && (state.cycle_history || []).length >= 2
    && Boolean(state.driving_question?.text)
    && state.completed_nodes.includes('WF10')
    && state.completed_nodes.includes('WF20'));
  assert.ok(state.children_evidence.some((e) => e.id.startsWith('ev-r2-')), 'second-round evidence ingested');
});

test('crawler: from_zero accepts the OTHER driving-question candidate too', () => {
  let state = createInitialState('crawl-fz-eye');
  const history = [];
  for (const message of [
    '我想带中班孩子做醒狮',
    '园附近每年都有醒狮活动，孩子们其实见过，但只是看热闹',
    '我们去看了训练。孩子们问狮子的眼睛为什么会眨，还有人问能不能进到狮子里面；好几个孩子自发模仿马步，在狮头架前停留很久。',
  ]) {
    const r = stepAssert(state, history, message, 'fz-eye ' + message.slice(0, 8));
    history.push({ role: 'user', content: message }, { role: 'assistant', content: r.turn.reply_markdown });
    state = r.state;
  }
  const pick = stepAssert(state, history, '孩子们更想弄明白眼睛的机关，做一个会眨眼的狮头', 'fz-eye pick');
  assert.ok(pick.state.driving_question.text.includes('眨'), 'engineering candidate accepted and written');
  assert.equal(pick.state.stage, 2, 'stage 1→2 on pick');
  assert.ok(pick.turn.artifacts.some((a) => a.type === 'cycle_task' && a.title.includes('眼睛')), 'cycle task adapted to the pick');
});

test('crawler: optimize_existing reaches goals + evidence plan, then horizon', () => {
  const { state, turns } = walk('optimize_existing', [
    '我们班在做龙舟主题，想优化',
    '有主题网络，但孩子兴趣散，做了两周活动不知道下一步',
    '有孩子问龙舟为什么要有鼓，还有孩子说想自己做一条会浮的龙舟',
    '孩子们更想做会浮的小龙舟，就选第一个',
  ], (state) => Boolean(state.driving_question?.text)
    && Boolean(state.goals_assessment_axis?.core_understanding)
    && state.completed_nodes.includes('WF10')
    && state.completed_nodes.includes('WF16')
    && state.stage === 3);
  assert.ok(turns[3].reply_markdown.includes('过程性证据计划'), 'WF16 evidence plan pointer delivered');
});

test('crawler: story_export delivers the REAL expanded story, adjusts, then horizon', () => {
  const { state, turns, history } = walk('story_export', [
    '我有一堆照片想整理成课程故事',
    '主要是活动过程照片，还有孩子的作品和涂鸦，以及几段采访视频',
    '有孩子说这是我们一起做出来的，还有孩子说下次还想再做一遍',
    '完整案例版',
    '好的，请展开',
  ], (state, turns) => {
    const expand = turns[4];
    const frag = expand.artifacts.find((a) => a.type === 'story_fragment');
    return state.stage === 5
      && state.completed_nodes.includes('WF30')
      && state.completed_nodes.includes('WF32')
      && Boolean(frag)
      && (frag.data.chapters || []).length === 4
      && frag.data.chapters.every((c) => String(c.content || '').length >= 20)
      && frag.data.gaps.every((g) => g.includes('待补充'))
      && expand.evidence_refs.length === 4;
  });
  // WF30 must NOT be marked before the expansion actually happened.
  assert.ok(!turns[3].state_delta.completed_nodes, 'version-choice turn marks no nodes (WF30 not premature)');
  // Adjustment requests still work after the horizon — a real re-ordering.
  const adj = stepAssert(state, history, '换一下章节顺序', 'story adjust');
  assert.ok(!HORIZON_RE.test(adj.turn.reply_markdown), 'adjust is not the horizon');
  assert.ok(adj.turn.reply_markdown.includes('开场') || adj.turn.reply_markdown.includes('章眼'), 'genuinely adjusted variant');
});

test('crawler: mid_course gives a DIFFERENT second-round analysis, then horizon', () => {
  const { state, turns } = walk('mid_course', [
    '昨天孩子们做狮头卡住了，想聊聊下一步',
    '孩子们试了纸箱做狮头，卡在固定不住；最活跃的是小宇，一直在指挥别人；我想知道下一轮该分组还是集体',
    '好的',
    '第二轮分组试了，胶带组把狮头固定住了，小宇自己动手缠胶带，其他组说也要试',
  ], (state, turns) => (state.cycle_history || []).length >= 2
    && state.stage === 0
    && turns[3].evidence_refs.some((id) => id.startsWith('ev-mc2-')));
  assert.notEqual(turns[3].reply_markdown, turns[1].reply_markdown, 'second analysis differs from the first');
  assert.ok(turns[3].reply_markdown.includes('卡点破了'), 'second round is a progress read, not a rerun');
  assert.equal(state.child_participation_difference.length, 2, '小宇 tracked across both rounds');
});

test('crawler: material_support cycles three distinct variants, then horizon', () => {
  const { turns } = walk('material_support', [
    '我想要一份趁墟的亲子调查素材',
    '给家长的调查表',
    '再来一版',
    '还有别的吗',
  ], (state, turns) => {
    const three = [turns[1].reply_markdown, turns[2].reply_markdown, turns[3].reply_markdown];
    return new Set(three).size === 3;
  });
  assert.equal(turns[1].round_complete, true, 'first delivery closes the round');
});

test('crawler coverage: branches forked and steps walked', () => {
  // 5 main walks + 1 extra pick walk fork the chips of every questioning turn.
  assert.ok(coverage.branches >= 25, 'chip branches forked: ' + coverage.branches);
  assert.ok(coverage.steps >= 60, 'total steps walked: ' + coverage.steps);
  console.log('crawler coverage → steps:', coverage.steps, '· chip branches:', coverage.branches);
});
