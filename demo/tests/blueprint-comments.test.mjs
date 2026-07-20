// 蓝图批注 + chat chip + title-agent harness (spec 2026-07-20).
// Comments pack into ONE teacher message; the mock answers with a
// blueprint_delta that survives the real harness + engine; the title
// harness triggers deterministically and sanitizes model output.

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeBlueprint, countUnconfirmed, packBlueprintComments } from '../src/blueprint-util.mjs';
import { parseTurn, validateTurn } from '../src/harness.mjs';
import { createInitialState, applyDelta, absorbBlueprint, applyBlueprintDelta } from '../src/engine.mjs';
import { mockTurn, parseBlueprintComments } from '../src/mock.mjs';
import {
  shouldRegenTitle, buildTitleMessages, sanitizeTitle,
  TITLE_INTERVALS, TITLE_INTERVAL_DEFAULT, TITLE_MAX,
} from '../src/title-agent.mjs';
import { TITLE_MAX as STORE_TITLE_MAX } from '../src/store/json-store.mjs';

const blocking = (violations) => violations.filter((v) => v.action === 'block');

// ---------- packBlueprintComments (pure) ----------

test('packBlueprintComments: numbered lines quote node + id; empty → null', () => {
  const packed = packBlueprintComments([
    { id: 'cultural_translation', number: '1.2', title: '文化转译', text: '例子太广州，我们在沙田' },
    { id: 'week_plan', number: '3', title: '周计划', text: ' 想按两周排 ' },
  ]);
  assert.ok(packed.startsWith('【蓝图批注】\n'));
  assert.match(packed, /1\. 「1\.2 文化转译」\(id: cultural_translation\)：例子太广州，我们在沙田/);
  assert.match(packed, /2\. 「3 周计划」\(id: week_plan\)：想按两周排/);
  assert.equal(packBlueprintComments([]), null);
  assert.equal(packBlueprintComments([{ id: 'x', number: '1', title: 'X', text: '   ' }]), null);
});

test('packBlueprintComments hardening: newlines collapse, 「」 stripped from titles, still parseable', () => {
  const packed = packBlueprintComments([
    { id: 'week_plan', number: '3', title: '周计划「草案」', text: '第一行\n第二行\n\n第三行' },
  ]);
  assert.equal(packed.split('\n').length, 2, 'one comment stays one line');
  const rows = parseBlueprintComments(packed);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'week_plan');
  assert.equal(rows[0].text, '第一行 第二行 第三行');
});

test('parseBlueprintComments round-trips what packBlueprintComments emits', () => {
  const packed = packBlueprintComments([
    { id: 'network_map', number: '2', title: '网络图', text: '方向太多，收拢到三个' },
  ]);
  const rows = parseBlueprintComments(packed);
  assert.deepEqual(rows, [{ label: '2 网络图', id: 'network_map', text: '方向太多，收拢到三个' }]);
});

// ---------- countUnconfirmed (chip badge) ----------

test('countUnconfirmed counts every non-confirmed node, branch and leaf', () => {
  const { modules } = normalizeBlueprint({
    modules: [
      { id: 'a', title: 'A', status: 'confirmed', children: [{ id: 'a1', title: 'A1', status: 'ai_suggestion' }] },
      { id: 'b', title: 'B', status: 'hypothesis' },
    ],
  });
  assert.equal(countUnconfirmed(modules), 2);
});

// ---------- mock 批注 turn through the real pipeline ----------

function stateWithBlueprint() {
  let state = createInitialState('c-bp-comments');
  state = applyDelta(state, { teacher_mode: 'from_zero', completed_nodes: ['WF01', 'WF02'] }, { teacherTurn: true }).state;
  const turn = {
    artifacts: [{
      type: 'blueprint',
      title: '预设蓝图',
      data: {
        version: 'v0.1',
        modules: [
          { id: 'network_map', title: '网络图', status: 'ai_suggestion' },
          { id: 'week_plan', title: '周计划', status: 'hypothesis' },
        ],
      },
    }],
  };
  return absorbBlueprint(state, turn, { teacherTurn: true }).state;
}

test('mock 批注 turn: contract-valid, delta targets only annotated ids, engine applies it', () => {
  const state = stateWithBlueprint();
  const message = packBlueprintComments([
    { id: 'network_map', number: '1', title: '网络图', text: '收拢到孩子问过的方向' },
  ]);
  const parsed = parseTurn(mockTurn(state, [], message));
  assert.ok(parsed.turn, 'mock 批注 turn must parse');
  assert.equal(blocking(validateTurn(parsed.turn, state)).length, 0, '批注 turn passes the harness');
  assert.equal(parsed.turn.blueprint_delta.length, 1);
  assert.equal(parsed.turn.blueprint_delta[0].id, 'network_map');
  const after = applyBlueprintDelta(state, parsed.turn.blueprint_delta, { teacherTurn: true });
  assert.equal(after.violations.length, 0);
  const node = after.state.course_plan_blueprint.modules.find((m) => m.id === 'network_map');
  assert.equal(node.status, 'teacher_preset');
  assert.match(node.body, /收拢到孩子问过的方向/);
});

test('mock 批注 turn: unknown ids answer honestly with an empty delta', () => {
  const state = stateWithBlueprint();
  const parsed = parseTurn(mockTurn(state, [], '【蓝图批注】\n1. 「9 早没了」(id: ghost_node)：改一下'));
  assert.ok(parsed.turn);
  assert.equal(parsed.turn.blueprint_delta.length, 0);
  assert.match(parsed.turn.reply_markdown, /没有对上/);
});

// ---------- title-agent harness ----------

test('TITLE_MAX stays in sync with the store', () => {
  assert.equal(TITLE_MAX, STORE_TITLE_MAX);
});

test('shouldRegenTitle: fires only on exact multiples, off by default paths', () => {
  const base = { every: 10, enabled: true, titleLocked: false };
  assert.equal(shouldRegenTitle({ ...base, teacherTurns: 10 }), true);
  assert.equal(shouldRegenTitle({ ...base, teacherTurns: 20 }), true);
  assert.equal(shouldRegenTitle({ ...base, teacherTurns: 9 }), false);
  assert.equal(shouldRegenTitle({ ...base, teacherTurns: 0 }), false);
  assert.equal(shouldRegenTitle({ ...base, teacherTurns: 10, enabled: false }), false);
  assert.equal(shouldRegenTitle({ ...base, teacherTurns: 10, titleLocked: true }), false);
  assert.equal(shouldRegenTitle({ ...base, teacherTurns: 10, every: 7 }), false, 'off-menu interval never fires');
  assert.ok(TITLE_INTERVALS.includes(TITLE_INTERVAL_DEFAULT));
});

test('buildTitleMessages: last 6 rows, truncated, theme threaded in', () => {
  const history = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `消息${i}` + 'x'.repeat(300) }));
  const msgs = buildTitleMessages(history, { theme_resource: { name: '醒狮' } });
  assert.equal(msgs.length, 2);
  assert.match(msgs[0].content, /不超过12个字/);
  assert.match(msgs[1].content, /主题资源：醒狮/);
  assert.ok(!msgs[1].content.includes('消息3'), 'only the last 6 rows survive');
  assert.ok(msgs[1].content.includes('消息4'));
});

test('sanitizeTitle: strips quotes/markdown/punctuation, caps length, rejects junk', () => {
  assert.equal(sanitizeTitle('「中班醒狮探究」'), '中班醒狮探究');
  assert.equal(sanitizeTitle('# 醒狮之旅。\n第二行'), '醒狮之旅');
  assert.equal(sanitizeTitle('<think>推理</think>醒狮'), '醒狮');
  assert.equal(sanitizeTitle('x'.repeat(40)), 'x'.repeat(TITLE_MAX));
  assert.equal(sanitizeTitle('{"title":"nope"}'), null);
  assert.equal(sanitizeTitle('   '), null);
  assert.equal(sanitizeTitle(null), null);
});

test('sanitizeTitle: emoji-heavy titles cap on code points, never split surrogate pairs', () => {
  const t = sanitizeTitle('🦁'.repeat(20));
  assert.equal([...t].length, TITLE_MAX);
  assert.ok(!/�/.test(t));
  assert.ok(t.endsWith('🦁'), 'last code point intact');
});
