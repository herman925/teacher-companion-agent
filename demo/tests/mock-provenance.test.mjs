// The demo script must never put words in the teacher's mouth or children's.
// Two defects this pins, both found in a real pilot session (2026-07-21):
//   1. The direction-pick gate read the RAW message, so the literal 「问题」 in
//      the 【问题卡回复】 packaging header confirmed 主题预设网络图 on the
//      teacher's behalf — the one judgment ADR-0003 says is hers alone.
//   2. Every children_evidence row the script invents (named children, dwell
//      points, quotes) landed in course_state indistinguishable from evidence
//      the teacher actually reported, and an example chip let her attest to it
//      in one click.

import test from 'node:test';
import assert from 'node:assert/strict';

import { mockTurn } from '../src/mock.mjs';
import { parseTurn, validateTurn } from '../src/harness.mjs';
import { createInitialState, applyDelta } from '../src/engine.mjs';

const PLAN_MSG = '我想带中班孩子做醒狮';

/** Drive round 1 (blueprint v0.1) and return the state round 2 starts from. */
function afterRound1(label) {
  const state = createInitialState(label);
  const r1 = mockTurn(state, [], PLAN_MSG);
  return {
    state: applyDelta(state, r1.state_delta).state,
    history: [{ role: 'assistant', content: r1.reply_markdown }],
  };
}

function networkMapStatus(turn) {
  const bp = turn.artifacts.find((a) => a.type === 'blueprint');
  return bp.data.modules.find((m) => m.id === 'network_map').status;
}

// ---------- 1. direction-pick gate: packaging must not vote for the teacher ----------

test('direction gate STAYS SHUT when the packaging header is the only match', () => {
  const { state, history } = afterRound1('t-dir-shut');
  // Verbatim shape of a real packaged reply: the header and the quoted question
  // titles carry 问题/资源, the ANSWERS carry no direction at all.
  const packed = [
    '【问题卡回复】',
    '1. 「用大白话说说，为什么想带孩子做醒狮」：园附近每年都有醒狮活动，孩子们其实见过，但只是看热闹',
    '2. 「园里或周边有哪些能用上的醒狮资源」：附近有醒狮队/传承人，可以约参观',
    '3. 「这个主题你打算做多久」：做一个月',
  ].join('\n');
  const { turn } = parseTurn(mockTurn(state, history, packed));

  assert.notEqual(networkMapStatus(turn), 'confirmed',
    'answering intake cards is NOT a direction pick — the map may not self-confirm');
  assert.equal(networkMapStatus(turn), 'teacher_preset');
  assert.ok(turn.questions.some((q) => q.id === 'q-bp-directions'),
    'the teacher is still asked to make the one judgment only she can make');
  assert.equal(blockingOf(turn, state).length, 0);
});

test('direction gate OPENS when the teacher actually names directions', () => {
  const { state, history } = afterRound1('t-dir-open');
  // The direction card answered — packaged exactly the same way.
  const packed = '【问题卡回复】\n1. 「网络图的方向里，先聚焦哪 2–3 个」：来源与故事＋真实场景';
  const { turn } = parseTurn(mockTurn(state, history, packed));

  assert.equal(networkMapStatus(turn), 'confirmed', 'a real pick still confirms the map');
  assert.ok(!turn.questions.some((q) => q.id === 'q-bp-directions'),
    'no need to ask again once she has picked');
});

test('direction gate opens on a free-text pick too (no packaging involved)', () => {
  const { state, history } = afterRound1('t-dir-free');
  const { turn } = parseTurn(mockTurn(state, history, '我想先做制作与材料这条线，孩子最爱动手'));
  assert.equal(networkMapStatus(turn), 'confirmed');
});

function blockingOf(turn, state) {
  return validateTurn(turn, state).filter((v) => v.action === 'block');
}

// ---------- 2. every invented evidence row is stamped as a demo sample ----------

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
};

/** Collect every children_evidence row the script writes across a flow. */
function evidenceFrom(script, label) {
  let state = createInitialState(label);
  const history = [];
  const rows = [];
  for (const message of script) {
    const raw = mockTurn(state, history, message);
    const { turn } = parseTurn(raw);
    rows.push(...(turn.state_delta?.children_evidence ?? []));
    state = applyDelta(state, turn.state_delta, { roundComplete: turn.round_complete, teacherTurn: true }).state;
    history.push({ role: 'user', content: message }, { role: 'assistant', content: turn.reply_markdown });
  }
  return rows;
}

test('every evidence row the demo script invents is stamped source: demo_sample', () => {
  let total = 0;
  for (const [flow, script] of Object.entries(SCRIPTS)) {
    const rows = evidenceFrom(script, `t-ev-${flow}`);
    total += rows.length;
    for (const row of rows) {
      assert.equal(row.source, 'demo_sample',
        `${flow}: 「${row.content}」 must be marked as demo sample, not passed off as reported evidence`);
    }
  }
  assert.ok(total >= 10, `the flows still demonstrate the evidence ledger (got ${total} rows)`);
});

test('the ingest turn does not offer one-click attestation of sample content', () => {
  const script = SCRIPTS.from_zero;
  let state = createInitialState('t-attest');
  const history = [];
  let ingest = null;
  for (const message of script) {
    const { turn } = parseTurn(mockTurn(state, history, message));
    if ((turn.state_delta?.children_evidence ?? []).some((e) => e.kind === 'child_words')) { ingest = turn; break; }
    state = applyDelta(state, turn.state_delta, { roundComplete: turn.round_complete, teacherTurn: true }).state;
    history.push({ role: 'user', content: message }, { role: 'assistant', content: turn.reply_markdown });
  }
  assert.ok(ingest, 'the from_zero flow reaches an evidence-ingest turn');
  const examples = (ingest.questions ?? []).flatMap((q) => q.examples ?? []);
  for (const ex of examples) {
    assert.ok(!/都是原话/.test(ex),
      `an example chip must not attest to unverified content on the teacher's behalf: 「${ex}」`);
  }
});
