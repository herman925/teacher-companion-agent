// memory-capture.test.mjs — the fact WRITE path, every guard, both directions.
//
// These run against a REAL store (a scratch JSON tier) and the REAL prompt
// builder, not against doubles, because every claim here is a claim about what
// actually reaches the model and what actually reaches the table. A guard
// tested against a stub proves the stub.
//
// The rule that matters most and is easiest to half-test: a fact asserting a
// realized child reaction must be archived on arrival AND must not appear in
// the band handed to the model. Checking only the archive flag would pass while
// the sentence still rode every prompt — archived-and-still-injected is the
// failure, not archived-and-forgotten.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createJsonStore } from '../src/store/json-store.mjs';
import { captureMemoryFacts, loadFacts, rawMemoryFacts, MEMORY_FACTS_PER_TURN } from '../src/memory-capture.mjs';
import { buildPromptParts, memoryBandText } from '../src/prompt-builder.mjs';
import { createInitialState } from '../src/engine.mjs';

/** One scratch store + one teacher + one course. */
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'cst-memcap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createJsonStore({ baseDir: dir });
  const { user } = await store.createUser({ username: `mem_${Math.random().toString(36).slice(2, 8)}` });
  const course = await store.createCourse(user.id, '醒狮');
  return { store, user, course };
}

const capture = (store, user, course, teacherText, candidates) => captureMemoryFacts(store, {
  userId: user.id,
  courseId: course.id,
  classId: null,
  teacherText,
  candidates,
  facts: [],
});

// ---------------------------------------------------------------- the quote

test('a fact whose quote is in this turn is filed; one whose quote is not is refused', async (t) => {
  const { store, user, course } = await fixture(t);

  const said = '我们班没有鼓，而且有几个孩子很怕大声。';
  const out = await capture(store, user, course, said, [
    { kind: 'equipment', text: '班上没有鼓', quote: '我们班没有鼓' },
    // The fabrication direction: a plausible constraint she never said. Nothing
    // else on this path can catch it — the taxonomy accepts it, the child-claim
    // pattern does not match it, and once filed it would ride every prompt from
    // now until someone deleted it by hand.
    { kind: 'space', text: '户外场地在装修', quote: '操场这个月封了' },
  ]);

  assert.equal(out.recorded.length, 1, 'exactly the one she actually said');
  assert.equal(out.recorded[0].text, '班上没有鼓');
  assert.equal(out.recorded[0].action, 'added');
  assert.deepEqual(out.refused.map((r) => r.reason), ['quote_not_found']);

  const stored = await store.listFacts(user.id, { courseId: course.id });
  assert.deepEqual(stored.map((f) => f.text), ['班上没有鼓'], '只有引得到原话的那条落了库');
});

test('punctuation and spacing are not a citation difference, but paraphrase is', async (t) => {
  const { store, user, course } = await fixture(t);
  // She typed it with full-width punctuation; the model echoes it without.
  const out = await capture(store, user, course, '我们班，没有鼓。', [
    { kind: 'equipment', text: '班上没有鼓', quote: '我们班没有鼓' },
  ]);
  assert.equal(out.recorded.length, 1, '标点和空格不算引用差异');

  const { store: s2, user: u2, course: c2 } = await fixture(t);
  const para = await capture(s2, u2, c2, '我们班一个鼓都没有。', [
    { kind: 'equipment', text: '班上没有鼓', quote: '我们班没有鼓' },
  ]);
  assert.equal(para.recorded.length, 0, '改写过的「原话」不算原话');
  assert.equal(para.refused[0].reason, 'quote_not_found');
});

test('a fact with no quote at all is refused', async (t) => {
  const { store, user, course } = await fixture(t);
  const out = await capture(store, user, course, '我们班没有鼓', [
    { kind: 'equipment', text: '班上没有鼓' },
  ]);
  assert.equal(out.recorded.length, 0);
  assert.equal(out.refused[0].reason, 'no_quote');
});

test('a one-particle quote grounds nothing — 「在她的消息里」 alone is not a citation', async (t) => {
  const { store, user, course } = await fixture(t);
  // The hole this floor closes, in the form it was actually demonstrated in:
  // an innocuous message, a fabricated claim about children, and a quote short
  // enough to occur in almost anything a teacher types. `class_composition` is
  // a legal kind (the taxonomy is about children by design) and 有兴趣 is not in
  // CHILD_CLAIM_RE, so without the floor this row files and then rides every
  // future prompt under a header that reads 「quote 是老师的原话」.
  const said = '今天的活动挺顺利的，谢谢你。';
  const out = await capture(store, user, course, said, [
    { kind: 'class_composition', text: '班上有几个孩子对龙舟特别有兴趣', quote: '的' },
    { kind: 'teacher_preference', text: '她想先看看', quote: '了' },
  ]);
  assert.equal(out.recorded.length, 0, '一个字的「原话」不是原话');
  assert.deepEqual(out.refused.map((r) => r.reason), ['quote_too_short', 'quote_too_short']);
  assert.deepEqual(await store.listFacts(user.id, { courseId: course.id, includeArchived: true }), []);
});

test('a long quote about something else grounds nothing either', async (t) => {
  const { store, user, course } = await fixture(t);
  // The other half of the same attack: pass the length floor by quoting a real
  // clause, then attach it to a fact it has nothing to do with.
  const said = '今天的活动挺顺利的，谢谢你。';
  const out = await capture(store, user, course, said, [
    { kind: 'class_composition', text: '班上有几个孩子对龙舟特别有兴趣', quote: '今天的活动挺顺利' },
  ]);
  assert.equal(out.recorded.length, 0);
  assert.deepEqual(out.refused.map((r) => r.reason), ['quote_unrelated']);
});

test('the floors do not punish an extractor for canonicalizing her wording', async (t) => {
  const { store, user, course } = await fixture(t);
  // MUST-PASS direction. ADR-0011 §4 puts canonicalization at the extractor, so
  // 星期三 → 周三 is correct behaviour; the overlap floor is set where a
  // rephrasing still shares words with the sentence it came from.
  const said = '我们星期三下午都排了体能课，只剩半小时。';
  const out = await capture(store, user, course, said, [
    { kind: 'schedule', text: '周三下午只剩半小时', quote: '星期三下午都排了体能课' },
  ]);
  assert.deepEqual(out.refused, [], out.refused.map((r) => r.reason).join(','));
  assert.equal(out.recorded.length, 1);
  assert.equal(out.recorded[0].action, 'added');
});

// ------------------------------------------------------------ the taxonomy

test('the closed taxonomy refuses a child observation — it has no kind to be filed under', async (t) => {
  const { store, user, course } = await fixture(t);
  const said = '今天孩子们对鼓声特别有反应，我们班没有鼓。';
  const out = await capture(store, user, course, said, [
    // ADR-0013 §9's own example. It does NOT match CHILD_CLAIM_RE (有反应 is not
    // in the pattern), so the taxonomy is the only thing standing between this
    // sentence and a permanent place in every future prompt.
    { kind: 'child_observation', text: '孩子们对鼓声特别有反应', quote: '孩子们对鼓声特别有反应' },
    { kind: 'equipment', text: '班上没有鼓', quote: '我们班没有鼓' },
  ]);
  assert.deepEqual(out.refused.map((r) => r.reason), ['unknown_kind']);
  assert.deepEqual(out.recorded.map((r) => r.text), ['班上没有鼓']);

  const stored = await store.listFacts(user.id, { courseId: course.id, includeArchived: true });
  assert.equal(stored.length, 1, '被拒的那条一行都没写进去');
});

test('a fact with no kind at all is refused, on the way in and on reload', async (t) => {
  const { store, user, course } = await fixture(t);
  const out = await capture(store, user, course, '我们班没有鼓', [
    { text: '班上没有鼓', quote: '我们班没有鼓' },
  ]);
  assert.deepEqual(out.refused.map((r) => r.reason), ['missing_kind']);
  assert.equal(out.recorded.length, 0);
});

// ------------------------------------------------- the child-claim second belt

test('a realized child reaction is archived on arrival AND never reaches the prompt band', async (t) => {
  const { store, user, course } = await fixture(t);
  // This one DOES match CHILD_CLAIM_RE and carries a legal kind, so the
  // taxonomy lets it through and the second belt has to catch it. Its quote is
  // genuinely in her message, so the citation guard does not save us either —
  // this is the case where only the archive-on-arrival rule stands.
  const said = '上次活动之后孩子们都学会了敲鼓的节奏，另外我们班没有鼓。';
  const out = await capture(store, user, course, said, [
    { kind: 'class_composition', text: '孩子们都学会了敲鼓的节奏', quote: '孩子们都学会了敲鼓的节奏' },
    { kind: 'equipment', text: '班上没有鼓', quote: '我们班没有鼓' },
  ]);

  // HALF ONE: archived, with its reason, and still on record.
  assert.equal(out.archived.length, 1);
  assert.equal(out.archived[0].reason, 'child_claim');
  assert.match(out.archived[0].message, /现场证据/);
  assert.ok(!out.recorded.some((r) => r.text.includes('学会')), '它不算「记住了」');

  const all = await store.listFacts(user.id, { courseId: course.id, includeArchived: true });
  const claim = all.find((f) => f.text.includes('学会'));
  assert.ok(claim, '归档不是删除——这条要留得住，导出和记忆页都看得到');
  assert.equal(claim.archived, true);
  assert.equal(claim.archive_reason, 'child_claim');

  // HALF TWO, the one that actually matters: it is not in what the model reads.
  const live = await loadFacts(store, user.id, course.id, null);
  assert.deepEqual(live.map((f) => f.text), ['班上没有鼓'], '默认读取不带归档的');
  const band = memoryBandText(live);
  assert.ok(band.includes('班上没有鼓'), '真正的约束还在band里');
  assert.ok(!band.includes('学会'), '孩子已经做到的事，一个字都不许进提示词');

  const { stateNote } = await buildPromptParts(
    createInitialState('c-1'),
    () => '（测试用提示词）',
    { facts: live },
  );
  assert.ok(stateNote.includes('班上没有鼓'));
  assert.ok(!stateNote.includes('学会'), '整条 state note 里也不许有');
});

// ------------------------------------------------------------- volume limits

test('at most three facts per turn; the excess is refused and counted, never dropped', async (t) => {
  const { store, user, course } = await fixture(t);
  // Every quote here is a whole clause, because the citation floors are a
  // different test: this one is about the counter, and a fixture that tripped
  // over the quote rules would pass or fail for the wrong reason.
  const said = '我们班没有鼓。也没有场地。周三时间很短。班上二十八个人。我不喜欢排练。';
  const out = await capture(store, user, course, said, [
    { kind: 'equipment', text: '班上没有鼓', quote: '我们班没有鼓' },
    { kind: 'space', text: '没有场地', quote: '也没有场地' },
    { kind: 'schedule', text: '周三时间很短', quote: '周三时间很短' },
    { kind: 'class_composition', text: '班上二十八个人', quote: '班上二十八个人' },
    { kind: 'teacher_preference', text: '我不喜欢排练', quote: '我不喜欢排练' },
  ]);
  assert.equal(out.recorded.length, MEMORY_FACTS_PER_TURN);
  assert.equal(out.refused.length, 2);
  assert.ok(out.refused.every((r) => r.reason === 'per_turn_cap'));
  assert.equal((await store.listFacts(user.id, { courseId: course.id })).length, 3);
});

test('a restatement merges instead of appending a second row', async (t) => {
  const { store, user, course } = await fixture(t);
  await capture(store, user, course, '我们班没有鼓', [
    { kind: 'equipment', text: '班上没有鼓', quote: '我们班没有鼓' },
  ]);
  const existing = await loadFacts(store, user.id, course.id, null);
  const again = await captureMemoryFacts(store, {
    userId: user.id, courseId: course.id, classId: null,
    teacherText: '再说一次，我们班没有鼓',
    candidates: [{ kind: 'equipment', text: '班上没有鼓', quote: '我们班没有鼓' }],
    facts: existing,
  });
  assert.equal(again.recorded[0].action, 'merged');
  assert.equal((await store.listFacts(user.id, { courseId: course.id })).length, 1, '同一条约束只有一行');
});

// ------------------------------------------------------------- provenance

test('provenance is engine-set: a payload claiming teacher scope is clamped to course/auto', async (t) => {
  const { store, user, course } = await fixture(t);
  const out = await capture(store, user, course, '我们班没有鼓', [
    // The laundering attempt: the model asks for the widest possible reach and
    // the most trusted provenance. Both must be ignored — a fact filed at
    // teacher scope follows her invisibly into every future course.
    { kind: 'equipment', text: '班上没有鼓', quote: '我们班没有鼓', scope: 'teacher', source: 'teacher' },
  ]);
  assert.equal(out.recorded.length, 1);
  const [row] = await store.listFacts(user.id, { courseId: course.id });
  assert.equal(row.scope, 'course', '自动抽取一律落在这门课上');
  assert.equal(row.source, 'auto', '「老师说的」只能由她的动作产生');
});

// --------------------------------------------------------- read-failure shape

test('a failed memory read files nothing and says so — it is not an empty memory', async (t) => {
  const { store, user, course } = await fixture(t);
  const out = await captureMemoryFacts(store, {
    userId: user.id, courseId: course.id, classId: null,
    teacherText: '我们班没有鼓',
    candidates: [{ kind: 'equipment', text: '班上没有鼓', quote: '我们班没有鼓' }],
    facts: null, // loadFacts could not read
  });
  assert.equal(out.recorded.length, 0);
  assert.equal(out.refused[0].reason, 'memory_unavailable');
  assert.equal((await store.listFacts(user.id, { courseId: course.id })).length, 0);
});

test('loadFacts returns null when the read throws, and the band is then omitted entirely', async (t) => {
  const broken = { async listFacts() { throw new Error('RLS: no rows for an unset app.user_id'); } };
  const facts = await loadFacts(broken, 'u1', 'c1', null);
  assert.equal(facts, null, 'null, never [] — see the comment that explains why');
  assert.equal(memoryBandText(facts), '', 'band 整块不出现');
  // And the difference is visible: an empty array still renders the headers, so
  // 「this class has nothing recorded」 stays distinguishable from 「memory could
  // not be read」.
  assert.notEqual(memoryBandText([]), '');
});

// ------------------------------------------------------------- the channel

test('rawMemoryFacts reads the field off a raw payload, string or object, and never throws', async () => {
  assert.deepEqual(rawMemoryFacts({ memory_facts: [{ kind: 'equipment', text: 'x' }] }), [{ kind: 'equipment', text: 'x' }]);
  assert.deepEqual(rawMemoryFacts('```json\n{"memory_facts":[{"kind":"space","text":"y"}]}\n```'), [{ kind: 'space', text: 'y' }]);
  assert.deepEqual(rawMemoryFacts('not json at all'), []);
  assert.deepEqual(rawMemoryFacts({ memory_facts: 'nope' }), []);
  assert.deepEqual(rawMemoryFacts(null), []);
});
