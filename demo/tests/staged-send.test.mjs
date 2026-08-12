// Staged composer send (DESIGN.md §5c: the composer is the only mouth) plus the
// chat chip's unconfirmed count.
//
// Replaces demo/tests/blueprint-comments.test.mjs. The 批注 channel it tested is
// gone (ADR-0010 §3): per-node remarks are said in that node's own conversation
// now. What survives here is the packer that still has a job — card answers and
// free text — plus a test pinning the removal, because a half-removed channel
// (packer alive, surface dead) is exactly what the ADR warns against.

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeBlueprint, countUnconfirmed, packStagedMessage } from '../src/blueprint-util.mjs';
import * as blueprintUtil from '../src/blueprint-util.mjs';
import * as mock from '../src/mock.mjs';

// ---------- packStagedMessage ----------

test('packStagedMessage composes card answers + free text into one message', () => {
  const packed = packStagedMessage({
    cards: {
      questions: [{ text: '班里孩子见过龙舟吗' }, { text: '想排几周' }, { text: '园里有水域吗' }],
      answers: [
        { value: '大部分见过，端午有巡游', skipped: false, locked: true },
        { value: '', skipped: true, locked: true },
        { value: '还没想好', skipped: false, locked: false },
      ],
    },
    text: '另外材料预算不多',
  });
  const [cardSec, freeSec] = packed.split('\n\n');
  assert.ok(cardSec.startsWith('【问题卡回复】\n'));
  assert.match(cardSec, /1\. 「班里孩子见过龙舟吗」：大部分见过，端午有巡游/);
  assert.match(cardSec, /2\. 「想排几周」：（跳过）/, 'locked skip is an explicit 跳过');
  assert.match(cardSec, /3\. 「园里有水域吗」：（暂未回答）/, 'unlocked cards are honestly 暂未回答');
  assert.equal(freeSec, '另外材料预算不多');
});

test('packStagedMessage: no locked answers → no card section; nothing at all → null', () => {
  const onlyText = packStagedMessage({
    cards: { questions: [{ text: 'q' }], answers: [{ value: '写了但没锁', skipped: false, locked: false }] },
    text: '只发这句',
  });
  assert.equal(onlyText, '只发这句', 'unlocked answers never leak into the send');
  assert.equal(packStagedMessage({}), null);
  assert.equal(packStagedMessage({ text: '   ' }), null);
});

// ---------- the 批注 channel is gone on BOTH sides ----------
//
// Both directions matter. Above: the packer still does its surviving job.
// Here: nothing can put a 【蓝图批注】 section on the wire, and nothing on the
// model side is still listening for one. Leaving either half alive is how a
// removed surface comes back — the model would keep believing the channel
// exists and could invite the teacher to use it.

test('packStagedMessage has no comments channel left: a stray key changes nothing', () => {
  const packed = packStagedMessage({
    text: '就这些',
    comments: [{ id: 'week_plan', number: '3', title: '周计划', text: '按两周排' }],
  });
  assert.equal(packed, '就这些');
  assert.ok(!/蓝图批注/.test(packed ?? ''));
  assert.equal(blueprintUtil.packBlueprintComments, undefined, 'the packer is deleted, not just unused');
});

test('mock no longer parses or routes 【蓝图批注】', () => {
  assert.equal(mock.parseBlueprintComments, undefined, 'the parser is deleted');
  const src = String(mock.mockTurn);
  assert.ok(!src.includes('蓝图批注'), 'mockTurn has no 批注 routing branch');
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
