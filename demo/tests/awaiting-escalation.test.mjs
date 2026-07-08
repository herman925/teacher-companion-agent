// AWAITING ESCALATION — a teacher who never types the "right" words must
// still reach the end of every flow. The waiting gates (原话/现场反馈 heuristics)
// nudge at most MAX_NUDGES times, then accept whatever the teacher sends and
// keep the script moving（筛选对准模型，不对准老师）. This walks every flow with
// nothing but generic replies through the REAL pipeline and asserts:
//   · every turn parses with zero blocking violations and applies clean;
//   · no waiting text ever appears three times in a row;
//   · every flow reaches the 演示边界 horizon within a bounded turn budget.

import test from 'node:test';
import assert from 'node:assert/strict';

import { mockTurn } from '../src/mock.mjs';
import { parseTurn, validateTurn } from '../src/harness.mjs';
import { createInitialState, applyDelta } from '../src/engine.mjs';

const HORIZON_RE = /演示脚本到这里|演示的边界/;
const GENERIC = ['好的', 'ok', '嗯', '然后呢', '還有呢？', '继续'];
const MAX_TURNS = 14;

const ENTRIES = {
  from_zero: '我想带中班孩子做醒狮',
  optimize_existing: '我们班在做龙舟主题，想优化',
  story_export: '我有一堆照片想整理成课程故事',
  mid_course: '昨天孩子们做狮头卡住了，想聊聊下一步',
  material_support: '我想要一份趁墟的亲子调查素材',
};

function stepClean(state, history, message, label) {
  const raw = mockTurn(state, history, message);
  const { turn, violations: pv } = parseTurn(raw);
  assert.ok(turn, label + ' parses');
  assert.equal(pv.length, 0, label + ' parse clean');
  const blocking = validateTurn(turn, state).filter((v) => v.action === 'block');
  assert.deepEqual(blocking, [], label + ' blocking: ' + JSON.stringify(blocking));
  const applied = applyDelta(state, turn.state_delta, { roundComplete: turn.round_complete, teacherTurn: true });
  const dirty = applied.violations.filter((v) => ['illegal_stage_jump', 'bad_delta', 'node_prerequisite'].includes(v.kind));
  assert.deepEqual(dirty, [], label + ' delta clean: ' + JSON.stringify(dirty));
  return { turn, state: applied.state };
}

for (const [flow, entry] of Object.entries(ENTRIES)) {
  test(`escalation: ${flow} reaches the horizon on generic replies alone`, () => {
    let state = createInitialState('esc-' + flow);
    const history = [];
    const replies = [];
    let horizonAt = 0;

    const messages = [entry, ...Array.from({ length: MAX_TURNS - 1 }, (_, i) => GENERIC[i % GENERIC.length])];
    for (const [i, message] of messages.entries()) {
      const label = flow + ' generic turn ' + (i + 1);
      const r = stepClean(state, history, message, label);
      history.push({ role: 'user', content: message }, { role: 'assistant', content: r.turn.reply_markdown });
      state = r.state;
      replies.push(r.turn.reply_markdown);
      if (HORIZON_RE.test(r.turn.reply_markdown)) { horizonAt = i + 1; break; }
    }

    assert.ok(horizonAt > 0, flow + ' reached the horizon within ' + MAX_TURNS + ' generic turns (last reply: ' + replies[replies.length - 1].slice(0, 60) + '…)');

    // Never three identical replies in a row anywhere along the way.
    for (let i = 2; i < replies.length; i += 1) {
      assert.ok(!(replies[i] === replies[i - 1] && replies[i] === replies[i - 2]), flow + ' repeats the same reply three times at turn ' + (i + 1));
    }
  });
}

test('escalation: waiting turns now carry example chips (2+ examples each)', () => {
  // A stuck teacher must always see clickable examples showing what to send.
  let state = createInitialState('esc-chips');
  const history = [];
  for (const message of ['我想带中班孩子做醒狮', '园附近每年都有醒狮活动，孩子们其实见过，但只是看热闹']) {
    const r = stepClean(state, history, message, 'chips setup');
    history.push({ role: 'user', content: message }, { role: 'assistant', content: r.turn.reply_markdown });
    state = r.state;
  }
  const nudge = stepClean(state, history, '還有呢？', 'awaiting nudge');
  assert.ok(nudge.turn.question, 'awaiting nudge carries a question');
  assert.ok(nudge.turn.question.examples.length >= 2, 'nudge question has 2+ example chips');
  // Each example chip must actually unlock the gate (never a dead chip).
  for (const example of nudge.turn.question.examples) {
    const fork = stepClean(structuredClone(state), structuredClone(history), example, 'chip「' + example.slice(0, 10) + '…」');
    assert.ok(!/把进度摊开|我还在这里，随时接得住/.test(fork.turn.reply_markdown), 'chip「' + example.slice(0, 10) + '…」does not loop back to the nudge');
  }
});
