// 蓝图批注 + chat chip + title-agent harness (spec 2026-07-20).
// Comments pack into ONE teacher message; the mock answers with a
// blueprint_delta that survives the real harness + engine; the title
// harness triggers deterministically and sanitizes model output.

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeBlueprint, countUnconfirmed, packBlueprintComments, packStagedMessage } from '../src/blueprint-util.mjs';
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

// ---------- packStagedMessage (§5c: the composer is the only mouth) ----------

test('packStagedMessage composes card answers + 批注 + free text into one message', () => {
  const packed = packStagedMessage({
    cards: {
      questions: [{ text: '班里孩子见过龙舟吗' }, { text: '想排几周' }, { text: '园里有水域吗' }],
      answers: [
        { value: '大部分见过，端午有巡游', skipped: false, locked: true },
        { value: '', skipped: true, locked: true },
        { value: '还没想好', skipped: false, locked: false },
      ],
    },
    comments: [{ id: 'week_plan', number: '3', title: '周计划', text: '按两周排' }],
    text: '另外材料预算不多',
  });
  const [cardSec, commentSec, freeSec] = packed.split('\n\n');
  assert.ok(cardSec.startsWith('【问题卡回复】\n'));
  assert.match(cardSec, /1\. 「班里孩子见过龙舟吗」：大部分见过，端午有巡游/);
  assert.match(cardSec, /2\. 「想排几周」：（跳过）/, 'locked skip is an explicit 跳过');
  assert.match(cardSec, /3\. 「园里有水域吗」：（暂未回答）/, 'unlocked cards are honestly 暂未回答');
  assert.ok(commentSec.startsWith('【蓝图批注】\n'));
  assert.equal(freeSec, '另外材料预算不多');
});

test('packStagedMessage: no locked answers → no card section; nothing at all → null', () => {
  const onlyText = packStagedMessage({
    cards: { questions: [{ text: 'q' }], answers: [{ value: '写了但没锁', skipped: false, locked: false }] },
    comments: [],
    text: '只发这句',
  });
  assert.equal(onlyText, '只发这句', 'unlocked answers never leak into the send');
  assert.equal(packStagedMessage({}), null);
  assert.equal(packStagedMessage({ text: '   ' }), null);
});

test('packStagedMessage sections stay mock-parseable (蓝图批注 mid-message)', () => {
  const packed = packStagedMessage({
    cards: { questions: [{ text: '想排几周' }], answers: [{ value: '两周', skipped: false, locked: true }] },
    comments: [{ id: 'network_map', number: '2', title: '网络图', text: '收拢到三个方向' }],
  });
  assert.ok(/^【蓝图批注】/m.test(packed), 'per-line anchor still matches after a card section');
  const rows = parseBlueprintComments(packed.split('\n\n')[1]);
  assert.equal(rows[0].id, 'network_map');
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

// A §5c one-mouth send can pack a 【问题卡回复】 card section AND a 【蓝图批注】
// section. turnBlueprintComments answers 批注 only, so routing a combined send
// there silently drops the card answers — including 儿童原话 the teacher typed.
// Both directions: 批注-only still refines; combined must NOT take the same path.
test('§5c combined send is not routed into the 批注-only path that drops card answers', () => {
  const state = stateWithBlueprint();
  const comments = [{ id: 'network_map', number: '1', title: '网络图', text: '收拢到孩子问过的方向' }];
  const commentOnly = packBlueprintComments(comments);
  const combined = packStagedMessage({
    cards: {
      questions: [{ text: '昨天孩子说了什么' }],
      answers: [{ value: '一个孩子说「龙的胡须会不会动」', skipped: false, locked: true }],
    },
    comments,
  });
  const bpTurn = parseTurn(mockTurn(state, [], commentOnly)).turn;
  const combinedTurn = parseTurn(mockTurn(state, [], combined)).turn;
  // Other direction: 批注-only still takes the refinement path.
  assert.ok(bpTurn.blueprint_delta.length >= 1, '批注-only send still refines the blueprint');
  // The fix: a combined send falls through to a normal flow, so it cannot be the
  // identical 批注-only turn. Reverting the guard (matching 批注 regardless of a
  // card section) makes both messages route to turnBlueprintComments and this
  // deep-equal fails.
  assert.notDeepEqual(combinedTurn, bpTurn, 'combined send must not resolve to the 批注-only reply');
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
