// scope-guard.test.mjs — the scope shell (ADR-0012 §3/§4).
//
// The false-PASS fixtures matter more than the false-block ones here: a wrongly
// refused teacher stops using the product, a wrongly allowed turn costs one
// call. Every "must pass" case below is load-bearing.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkScope, hasCourseSignal, offDomainRule, refusalTurn } from '../src/scope-guard.mjs';

const ON = { enforce: true };
const COURSE = { theme: '东乡龙舟', stage: 2 };
const FRESH = { stage: 0 };

// ---------- the pair ADR-0012 §4 is built around ----------

test('the governing pair: bare weather out, weather-about-an-activity in', () => {
  assert.equal(checkScope('长沙今天天气怎么样', FRESH, ON).refuse, true);
  // Same topic. Course reference present. This one MUST pass — it is the
  // fixture that a naive keyword filter fails.
  assert.equal(checkScope('明天下雨的话，周二那个户外龙舟活动怎么办', COURSE, ON).refuse, false);
});

// ---------- must pass ----------

test('a greeting on a brand-new course passes — no state, no keywords', () => {
  // Requiring a course signal would refuse a teacher's very first word.
  assert.equal(checkScope('你好', FRESH, ON).refuse, false);
  assert.equal(checkScope('在吗', FRESH, ON).refuse, false);
});

test('plain course work passes', () => {
  for (const msg of [
    '我想带中班的小朋友做东乡龙舟的主题探究活动',
    '改一下周二那个活动',
    '3.2.1 这个活动会不会太难',
    '帮我写给家长的一封信',
    '这周的材料清单里要准备什么',
    '孩子们对鼓声特别有反应，接下来怎么走',
  ]) {
    assert.equal(checkScope(msg, COURSE, ON).refuse, false, `must pass: ${msg}`);
  }
});

test('a teacher asking about rain for an outdoor plan passes even with no theme set', () => {
  assert.equal(checkScope('下周要户外活动，会不会下雨', FRESH, ON).refuse, false);
});

test('the theme name alone is enough of a signal', () => {
  assert.equal(checkScope('东乡龙舟今天天气', COURSE, ON).refuse, false);
});

// ---------- must refuse ----------

test('bare off-domain queries are refused', () => {
  const cases = [
    ['长沙今天天气怎么样', 'weather'],
    ['帮我写个 Python 脚本', 'code'],
    ['今天股票涨了吗', 'markets'],
    ['讲个笑话', 'chitchat'],
    ['帮我写一封辞职信', 'general_help'],
    ['昨天的球赛谁赢了', 'sport'],
  ];
  for (const [msg, rule] of cases) {
    const v = checkScope(msg, FRESH, ON);
    assert.equal(v.refuse, true, `must refuse: ${msg}`);
    assert.equal(v.rule, rule);
  }
});

// ---------- warn-only is the default ----------

test('warn-only by default: reports the verdict, blocks nothing', () => {
  const v = checkScope('长沙今天天气怎么样', FRESH);
  assert.equal(v.wouldRefuse, true, '判断照做');
  assert.equal(v.refuse, false, '默认不拦');
  assert.equal(v.enforced, false);
  assert.equal(v.rule, 'weather', '要记下命中哪条，否则无法审计误伤');
});

test('warn-only still reports clean for in-scope turns', () => {
  const v = checkScope('改一下周二那个活动', COURSE);
  assert.equal(v.wouldRefuse, false);
  assert.equal(v.rule, '');
});

// ---------- signals in isolation ----------

test('course signal: node ids and domain words both count', () => {
  assert.equal(hasCourseSignal('3.2.1 太难了', null), true);
  assert.equal(hasCourseSignal('孩子们喜欢', null), true);
  assert.equal(hasCourseSignal('东乡龙舟', { theme: '东乡龙舟' }), true);
  assert.equal(hasCourseSignal('今天天气怎么样', null), false);
  assert.equal(hasCourseSignal('', null), false);
});

test('off-domain rule returns the name that matched, or empty', () => {
  assert.equal(offDomainRule('今天天气怎么样'), 'weather');
  assert.equal(offDomainRule('改一下周二那个活动'), '');
});

// ---------- the refusal itself ----------

test('refusal is a normal turn: says what it does, offers the way back', () => {
  const t = refusalTurn(COURSE);
  assert.match(t.reply_markdown, /主题探究课程/, '要说明这个工具是做什么的');
  assert.match(t.reply_markdown, /东乡龙舟/, '有课程时要指回她的课程');
  assert.equal(t.round_complete, false);
  assert.deepEqual(t.state_delta, {}, '拒绝不改状态');
  assert.deepEqual(t.evidence_refs, []);
  // Register (DESIGN.md §7): no system-voice scolding.
  assert.doesNotMatch(t.reply_markdown, /请注意|系统提示|错误|不允许/);
});

test('refusal without a course offers a starting point instead of a dead end', () => {
  const t = refusalTurn(FRESH);
  assert.match(t.reply_markdown, /你想带孩子做什么主题/);
});
