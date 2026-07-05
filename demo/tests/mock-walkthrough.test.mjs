// The scripted mock walkthrough must itself survive the runtime harness —
// every canned turn passes L2/L3 and every delta applies without violations.
// If a validator tightens or the mock drifts, this fails before a human demo does.

import test from 'node:test';
import assert from 'node:assert/strict';

import { mockTurn } from '../src/mock.mjs';
import { parseTurn, validateTurn } from '../src/harness.mjs';
import { createInitialState, applyDelta } from '../src/engine.mjs';

const SCRIPT = [
  '我想带中班孩子做醒狮',
  '园附近每年都有醒狮活动，孩子们见过但只是看热闹，我希望他们多一点真实接触',
  '我们去看了训练。孩子们问狮子的眼睛为什么会眨，还有人问能不能进到狮子里面；好几个孩子自发模仿马步，在狮头架前停留很久。',
  '孩子们投票选了排小醒狮给弟弟妹妹看，最想解决怎么配合',
  '想把前面这段整理成课程故事的开头',
];

test('mock walkthrough: every scripted turn is contract-compliant and gate-legal', () => {
  let state = createInitialState('walkthrough');
  const history = [];
  const stages = [];

  for (const [i, message] of SCRIPT.entries()) {
    const raw = mockTurn(state, history, message);
    const { turn, violations: parseV } = parseTurn(raw);
    assert.ok(turn, `turn ${i + 1} parses`);
    assert.equal(parseV.length, 0, `turn ${i + 1} parse clean`);

    const v = validateTurn(turn, state).filter((x) => x.action === 'block');
    assert.deepEqual(v, [], `turn ${i + 1} has no blocking violations: ${JSON.stringify(v)}`);

    const applied = applyDelta(state, turn.state_delta, { roundComplete: turn.round_complete, teacherTurn: true });
    assert.deepEqual(
      applied.violations.filter((x) => x.kind === 'illegal_stage_jump'),
      [], `turn ${i + 1} proposes only legal stage moves`,
    );
    state = applied.state;
    stages.push(state.stage);
    history.push({ role: 'user', content: message }, { role: 'assistant', content: turn.reply_markdown });
  }

  // The walkthrough must actually progress the course, produce evidence, and
  // end with a story fragment backed by real (scripted) evidence.
  assert.ok(state.stage >= 2, `course advanced past intake (stage=${state.stage})`);
  assert.ok(state.children_evidence.length >= 5, 'evidence ledger populated');
  assert.ok(state.driving_question?.text, 'driving question chosen');
  assert.ok(state.story_materials?.gaps?.length, 'story fragment lists honest gaps');
  assert.equal(state.awaiting_feedback, true, 'last scripted turn closes a round');
});
