// title-agent harness: the auto-titler fires deterministically, builds a
// bounded prompt, and sanitizes whatever the model hands back. Lived in
// blueprint-comments.test.mjs until the 批注 channel it shared a file with was
// removed (ADR-0010 §3); the tests themselves are unchanged.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  shouldRegenTitle, buildTitleMessages, sanitizeTitle,
  TITLE_INTERVALS, TITLE_INTERVAL_DEFAULT, TITLE_MAX,
} from '../src/title-agent.mjs';
import { TITLE_MAX as STORE_TITLE_MAX } from '../src/store/json-store.mjs';

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
