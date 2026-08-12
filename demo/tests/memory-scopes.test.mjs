// memory-scopes.test.mjs — course / class / teacher facts (ADR-0011 §1, §2, §4).
//
// The must-PASS fixtures carry more weight than the must-trip ones throughout.
// A rule that fires too eagerly here does not fail loudly: it files a fact at
// teacher scope, or archives a constraint she set by hand, and the damage shows
// up weeks later as an activity proposing drums to a class that has none, with
// nothing on screen to explain where the belief came from.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCOPES, PROMPT_SCOPES, FACT_KINDS, MEMORY_COLUMNS, MEMORY_TSV_VERSION, DEFAULT_FACT_CAP,
  normalizeFacts, screenFacts, mergeFact, supersedeFact, capFacts, factsToTSV, widenScope,
} from '../src/memory-scopes.mjs';

/** Fixed clock. Every fixture carries its own `at` so nothing here reads the
 * real time — the curation policy is testable only if it is deterministic. */
const AT = (d) => `2026-09-${String(d).padStart(2, '0')}T09:00:00.000Z`;
const NOW = { now: AT(30) };

/** The fact ADR-0011 is written around: she said it once, inside a conversation
 * about an unrelated activity, and it must reach every future week.
 *
 * It sits at CLASS scope because she tapped widen — carrying the stamp
 * `widenScope` writes. Since the 2026-08 review these two fields are the only
 * proof of teacher provenance a stored row can offer: `source: 'teacher'` on
 * its own is now read as the machine's guess, because it is one field an
 * extractor controls and the clamp is the whole design. */
const WIDENED = { widened_from: 'course', widened_at: AT(1) };
const NO_DRUM = {
  id: 'f-drum', scope: 'class', kind: 'equipment', text: '班上没有鼓',
  quote: '我们班没有鼓，而且有几个孩子很怕大声', at: AT(1), source: 'teacher', ...WIDENED,
};
const LOUD = {
  id: 'f-loud', scope: 'class', kind: 'class_composition', text: '有几个孩子怕大声',
  quote: '我们班没有鼓，而且有几个孩子很怕大声', at: AT(1), source: 'teacher', ...WIDENED,
};
/** The same constraint before she widened it: what auto-extraction can write. */
const DRUM_COURSE = {
  id: 'f-drum-c', scope: 'course', kind: 'equipment', text: '班上没有鼓',
  quote: '我们班没有鼓，而且有几个孩子很怕大声', at: AT(1), source: 'auto',
};
const THEME = {
  id: 'f-theme', scope: 'course', kind: 'schedule', text: '这门课每周只有周三下午',
  quote: '我们每周三下午才有整块时间', at: AT(2), source: 'auto',
};

const idsOf = (facts) => facts.map((f) => f.id);
const live = (facts) => facts.filter((f) => !f.archived);
const byId = (facts, id) => facts.find((f) => f.id === id);

// ---------- normalize ----------

test('normalize: the safe shape is always complete', () => {
  const [f] = normalizeFacts({ kind: 'equipment', text: '班上没有鼓' }, NOW);
  for (const k of ['kind', 'scope', 'text', 'quote', 'at', 'id']) assert.ok(k in f, `缺字段：${k}`);
  assert.equal(f.at, AT(30), '没有时间戳时用传入的 now，不读真实时钟');
  assert.equal(f.quote, '', '没有原话就是空字符串，不是 undefined');
});

test('normalize: an unknown scope defaults narrow, never broad', () => {
  // Default narrow: filing too broadly follows her into every future course.
  assert.equal(normalizeFacts({ kind: 'equipment', text: 'x', scope: 'kindergarten' }, NOW)[0].scope, 'course');
  assert.equal(normalizeFacts({ kind: 'equipment', text: 'x', scope: '' }, NOW)[0].scope, 'course');
  assert.equal(normalizeFacts({ kind: 'equipment', text: 'x' }, NOW)[0].scope, 'course');
});

test('normalize: node scope is accepted, never invented', () => {
  // Node memory is generated elsewhere. Rewriting an existing node fact down to
  // course would move it somewhere its owner never looks.
  assert.equal(normalizeFacts({ kind: 'equipment', text: 'x', scope: 'node', source: 'teacher' }, NOW)[0].scope, 'node');
  assert.ok(SCOPES.includes('node'));
});

test('normalize: a fact with no text is dropped, not filed empty', () => {
  const out = normalizeFacts([{ kind: 'equipment', text: '   ' }, { kind: 'equipment', text: '' }, {}, null, 'nonsense', { kind: 'equipment', text: '真的事实' }], NOW);
  assert.equal(out.length, 1, '空行会渲染成 - 并被模型读成一条事实');
  assert.equal(out[0].text, '真的事实');
});

test('normalize: ids are stable across reloads, and never collide', () => {
  const a = normalizeFacts({ kind: 'equipment', text: '班上没有鼓' }, NOW)[0].id;
  const b = normalizeFacts({ kind: 'equipment', text: '班上没有鼓' }, NOW)[0].id;
  assert.equal(a, b, 'id 要能让 superseded_by 指针在重新加载后依然有效');
  const dup = normalizeFacts([{ id: 'x', kind: 'equipment', text: 'a' }, { id: 'x', kind: 'equipment', text: 'b' }], NOW);
  assert.notEqual(dup[0].id, dup[1].id);
});

test('normalize: curation bookkeeping survives a round trip through storage', () => {
  const stored = {
    id: 'f1', scope: 'class', kind: 'equipment', text: 'x', quote: 'q', at: AT(1), source: 'teacher',
    archived: true, archived_at: AT(5), archive_reason: 'superseded', superseded_by: 'f2',
    supersedes: 'f0', used_at: AT(4), widened_from: 'course', widened_at: AT(3), restated: 2,
  };
  const [f] = normalizeFacts(stored, NOW);
  assert.equal(f.archived, true);
  assert.equal(f.archived_at, AT(5));
  assert.equal(f.superseded_by, 'f2');
  assert.deepEqual(f.supersedes, ['f0'], '单个 id 也接受，统一成数组');
  assert.equal(f.widened_from, 'course');
  assert.equal(f.restated, 2);
});

test('normalize: an ordinary fact stays lean', () => {
  // Bookkeeping fields appear only when they happened, so storage and the
  // export stay readable.
  const [f] = normalizeFacts({ kind: 'equipment', text: 'x', at: AT(1) }, NOW);
  assert.deepEqual(Object.keys(f).sort(), ['at', 'id', 'kind', 'quote', 'scope', 'source', 'text']);
});

// ---------- the invariant: auto-extraction never writes above course ----------

test('INVARIANT: auto-extraction claiming class scope lands at course', () => {
  const [f] = normalizeFacts({ kind: 'equipment', text: '班上没有鼓', scope: 'class', source: 'auto' }, NOW);
  assert.equal(f.scope, 'course', '自动抽取只能写 course');
});

test('INVARIANT: auto-extraction claiming teacher scope lands at course', () => {
  const [f] = normalizeFacts({ kind: 'teacher_preference', text: '她喜欢先看整月', scope: 'teacher', source: 'auto' }, NOW);
  assert.equal(f.scope, 'course');
});

test('INVARIANT: an unlabelled fact is treated as the machine guessing', () => {
  // No `source` means unknown origin. Assuming 'teacher' would let one
  // mislabelled row sit at teacher scope forever.
  const [f] = normalizeFacts({ kind: 'equipment', text: '班上没有鼓', scope: 'teacher' }, NOW);
  assert.equal(f.source, 'auto');
  assert.equal(f.scope, 'course');
});

test('INVARIANT: the clamp bites on reload too, not only on first write', () => {
  // A corrupt or over-eager stored row is repaired rather than trusted.
  const stored = [{ id: 'f1', scope: 'teacher', kind: 'equipment', text: '班上没有鼓', at: AT(1), source: 'auto' }];
  assert.equal(normalizeFacts(stored, NOW)[0].scope, 'course');
});

test('INVARIANT: no curation function can widen — only widenScope can', () => {
  const claim = { id: 'f-new', scope: 'teacher', kind: 'equipment', text: '班上没有鼓', at: AT(3), source: 'auto' };
  assert.equal(mergeFact([], claim, NOW).facts[0].scope, 'course');
  assert.equal(supersedeFact([], claim, NOW).facts[0].scope, 'course');
  assert.equal(capFacts([claim], 10, NOW).facts[0].scope, 'course');
  assert.equal(widenScope([claim], 'f-new', 'class', NOW).facts[0].scope, 'class', '只有这一条路能变宽');
});

// CHANGED BY THE 2026-08 REVIEW (was: 「a fact she stated herself may be filed
// wide directly」). `source: 'teacher'` used to be accepted from input and to
// bypass the clamp outright — one field the extractor controls, and the whole
// narrow-by-default asymmetry went with it. Provenance is engine-set now:
// `widenScope` writes it, and its `widened_at` stamp is the proof.
test('INVARIANT: an incoming fact cannot mint teacher provenance for itself', () => {
  const [f] = normalizeFacts({ kind: 'equipment', text: '班上没有鼓', scope: 'class', source: 'teacher' }, NOW);
  assert.equal(f.source, 'auto', '自称是她说的不算数——只有 widenScope 能写 teacher');
  assert.equal(f.scope, 'course', '夹回 course：绕不过去的才叫夹');
});

test('INVARIANT: a stored fact she widened keeps its scope and its provenance', () => {
  // The must-pass half: the clamp must not eat her deliberate tap on reload.
  const [f] = normalizeFacts(NO_DRUM, NOW);
  assert.equal(f.scope, 'class');
  assert.equal(f.source, 'teacher');
});

// ---------- a fact is a constraint, not a claim about children ----------
//
// ADR-0013 §9's STRUCTURAL guard. The ADR is explicit that a keyword heuristic
// was the wrong answer — it 「would give false confidence exactly where the
// product cannot afford it」 — and the proof is its own example: 「孩子们对鼓声
// 特别有反应」 does not match CHILD_CLAIM_RE (有反应 is not in that list), so
// under the old design that exact sentence filed as an ordinary live fact and
// rode every prompt under a settled-looking header. What closes it is that a
// child observation has no `kind` to be filed under.

test('INVARIANT: a child observation has no kind to be filed under, and is REFUSED', () => {
  // The ADR's own sentence, and the one the keyword belt cannot see.
  const observation = { text: '孩子们对鼓声特别有反应', quote: '他们对鼓声特别有反应' };
  const { facts, rejected } = screenFacts(observation, NOW);
  assert.deepEqual(facts, [], '没有 kind 的东西根本不是事实，不能进记忆');
  assert.deepEqual(rejected.map((r) => r.reason), ['missing_kind']);
  // Refused, not archived: archiving would keep it in the store as 「a fact we
  // decided not to send」, which is a different and weaker claim.
  const r = mergeFact([NO_DRUM], observation, NOW);
  assert.equal(r.action, 'refused');
  assert.equal(r.reason, 'missing_kind');
  assert.deepEqual(idsOf(r.facts), ['f-drum'], '被拒的输入什么都没留下');
});

test('INVARIANT: a kind outside the five is refused too — the taxonomy is closed', () => {
  for (const kind of ['child_observation', 'theme', 'progress', 'note', '  ']) {
    const { facts, rejected } = screenFacts({ kind, text: '孩子们学会了划桨' }, NOW);
    assert.deepEqual(facts, [], `不该被接受的 kind：${kind}`);
    assert.ok(['missing_kind', 'unknown_kind'].includes(rejected[0].reason));
  }
  // Every one of the five IS accepted — otherwise this test would also pass
  // against a module that refuses everything.
  for (const kind of FACT_KINDS) {
    assert.equal(screenFacts({ kind, text: '一条真的约束' }, NOW).facts[0].kind, kind);
  }
});

test('MUST PASS — an equipment fact 「班上没有鼓」 is accepted unchanged', () => {
  const { facts, rejected } = screenFacts({ kind: 'equipment', text: '班上没有鼓' }, NOW);
  assert.deepEqual(rejected, []);
  assert.equal(facts[0].kind, 'equipment');
  assert.equal(facts[0].scope, 'course');
  assert.ok(factsToTSV(facts, 'course').includes('班上没有鼓'));
});

test('INVARIANT: supersede refuses an unclassifiable contradiction rather than acting on it', () => {
  // A fact that cannot be classified cannot retire one that was.
  const r = supersedeFact([NO_DRUM], { id: 'f-x', text: '孩子们对鼓声特别有反应', supersedes: 'f-drum' }, { ...NOW, byTeacher: true });
  assert.equal(byId(r.facts, 'f-drum').archived, undefined, '她亲手放宽的约束不能被一条不成立的输入抹掉');
  assert.deepEqual(r.archived, []);
  assert.deepEqual(r.refused, [{ id: 'f-x', reason: 'missing_kind' }]);
});

test('INVARIANT: a stored row with no kind is dropped on reload, not trusted', () => {
  // The write path refuses these, so a row on disk without a kind is corrupt
  // rather than legacy — and reading it back as data would trust exactly the
  // corruption the guard exists to stop.
  const corrupt = [{ id: 'f-old', scope: 'class', text: '孩子们已经理解了轮流', at: AT(1), source: 'teacher', ...WIDENED }];
  assert.deepEqual(normalizeFacts(corrupt, NOW), []);
  assert.ok(!factsToTSV(corrupt, 'class').includes('轮流'));
});

test('INVARIANT: the keyword belt still fires — but it is the second lock, not the first', () => {
  // A child claim wearing a FORGED classification: the taxonomy accepts it and
  // CHILD_CLAIM_RE catches it. Kept and visible in the export (archiving is not
  // deleting), never rendered into the prompt.
  const [f] = normalizeFacts({ kind: 'class_composition', text: '孩子们已经学会了划桨的动作', quote: '（模型编的）' }, NOW);
  assert.equal(f.archived, true);
  assert.equal(f.archive_reason, 'child_claim');
  assert.ok(!factsToTSV([f], 'course').includes('划桨'), '不能进提示词');
  assert.ok(factsToTSV([f], 'course').includes('0 条'));
});

test('MUST PASS — an ordinary class constraint is untouched by that screen', () => {
  // The fixture that matters: 「班上没有鼓」 mentions no child reaction and must
  // ride every turn exactly as before. A screen that ate real constraints would
  // recreate the failure the whole module exists to prevent.
  const [f] = normalizeFacts(NO_DRUM, NOW);
  assert.equal(f.archived, undefined);
  assert.ok(factsToTSV([f], 'class').includes('班上没有鼓'));
  const [loud] = normalizeFacts({ kind: 'class_composition', text: '有几个孩子很怕大声' }, NOW);
  assert.equal(loud.archived, undefined, '说孩子怕大声是班级约束，不是「孩子们已经理解了」');
});

// ---------- merge ----------

// The incoming rows below are what auto-extraction can actually produce —
// course scope, `source: 'auto'` — because since the 2026-08 review nothing
// arriving from an extractor can claim more than that. The restatement rule
// itself is unchanged.
test('merge: a restatement updates the timestamp instead of appending', () => {
  const again = { scope: 'course', kind: 'equipment', text: '班上没有鼓。', quote: '跟你说过我们班没有鼓', at: AT(9) };
  const r = mergeFact([DRUM_COURSE, LOUD], again, NOW);
  assert.equal(r.action, 'merged');
  assert.equal(r.facts.length, 2, '不追加近似重复');
  assert.equal(byId(r.facts, 'f-drum-c').at, AT(9), '时间戳跟着更新');
  assert.equal(byId(r.facts, 'f-drum-c').restated, 1);
});

test('merge: the merged row keeps the original id and quote', () => {
  const again = { scope: 'course', kind: 'equipment', text: '班上没有鼓', quote: '又说了一遍', at: AT(9) };
  const f = byId(mergeFact([DRUM_COURSE], again, NOW).facts, 'f-drum-c');
  assert.equal(f.id, 'f-drum-c', 'id 变了，指向它的 superseded_by 就断了');
  assert.equal(f.quote, DRUM_COURSE.quote, '原话是产生这条事实的那句，不是复述它的那句');
});

test('merge: punctuation and spacing do not make a new fact', () => {
  for (const text of ['班上没有鼓', '班上没有鼓，', '班上 没有鼓。', '班上没有鼓！']) {
    const r = mergeFact([DRUM_COURSE], { scope: 'course', kind: 'equipment', text, at: AT(9) }, NOW);
    assert.equal(r.action, 'merged', `应合并：${text}`);
  }
});

test('merge: an extracted restatement never reaches the class fact she widened', () => {
  // The cost of the trust boundary, pinned rather than hidden: her class row
  // and a fresh course row now coexist. A duplicate line she can delete is the
  // documented direction to fail in; the alternative is an extractor writing
  // into rows she personally widened.
  const r = mergeFact([NO_DRUM], { scope: 'class', kind: 'equipment', text: '班上没有鼓', at: AT(9), source: 'teacher' }, NOW);
  assert.equal(r.action, 'added');
  assert.deepEqual(live(r.facts).map((f) => f.scope).sort(), ['class', 'course']);
});

// --- must NOT merge ---

test('merge: a different fact in the same scope is added, not folded in', () => {
  const r = mergeFact([NO_DRUM], { ...LOUD, id: undefined }, { ...NOW, byTeacher: true });
  assert.equal(r.action, 'added');
  assert.equal(live(r.facts).length, 2, '两条不同的约束不能变成一条');
});

test('merge: the same words at a different scope are a different claim', () => {
  // 「这门课不用鼓」 and 「这个班没有鼓」 have different reach. Folding them together
  // would silently widen or narrow one of them.
  const courseCopy = { scope: 'course', kind: 'equipment', text: '班上没有鼓', at: AT(9) };
  const r = mergeFact([NO_DRUM], courseCopy, NOW);
  assert.equal(r.action, 'added');
  assert.deepEqual([...new Set(live(r.facts).map((f) => f.scope))].sort(), ['class', 'course']);
});

test('merge: a paraphrase is added — the deliberate direction to fail in', () => {
  // Documented limitation, not an oversight. A missed merge costs one duplicate
  // line she can delete; a false merge silently loses a distinct constraint.
  // Canonicalizing the wording belongs upstream, where a model reads meaning.
  const r = mergeFact([NO_DRUM], { scope: 'class', kind: 'equipment', text: '我们班没有鼓', at: AT(9), source: 'teacher' }, NOW);
  assert.equal(r.action, 'added');
});

test('merge: an archived fact is not a merge target', () => {
  // She changed her mind back. That is a live new fact, and the archived row
  // must keep saying what was believed when.
  const retired = { ...NO_DRUM, archived: true, archived_at: AT(5), archive_reason: 'superseded' };
  const r = mergeFact([retired], { scope: 'class', kind: 'equipment', text: '班上没有鼓', at: AT(9), source: 'teacher' }, NOW);
  assert.equal(r.action, 'added');
  assert.equal(byId(r.facts, 'f-drum').archived, true, '归档的那条原样不动');
  assert.equal(live(r.facts).length, 1);
});

test('merge: input with no text is ignored, and says it was', () => {
  const r = mergeFact([NO_DRUM], { text: '  ' }, NOW);
  assert.equal(r.action, 'ignored', '什么都没加却报 added 就是在说谎');
  assert.equal(r.facts.length, 1);
});

// ---------- supersede ----------

test('supersede: the old fact is archived with a pointer, never deleted', () => {
  const bought = {
    id: 'f-bought', scope: 'class', kind: 'equipment', text: '园里买了两个鼓', quote: '园里上周买了两个鼓',
    at: AT(20), source: 'teacher', supersedes: 'f-drum',
  };
  // `byTeacher` is the tap: trust travels in the call, not in a field on the
  // fact, so a contradiction she states herself can still retire her own row.
  const r = supersedeFact([NO_DRUM, LOUD], bought, { ...NOW, byTeacher: true });
  const old = byId(r.facts, 'f-drum');
  assert.equal(old.archived, true);
  assert.equal(old.archived_at, AT(20));
  assert.equal(old.archive_reason, 'superseded');
  assert.equal(old.superseded_by, 'f-bought', '指针在，才查得出当时信的是什么');
  assert.equal(r.facts.length, 3, '归档不是删除');
  assert.deepEqual(idsOf(r.archived), ['f-drum']);
  assert.deepEqual(idsOf(live(r.facts)).sort(), ['f-bought', 'f-loud']);
});

test('supersede: an unrelated fact at the same scope is untouched', () => {
  const bought = { id: 'f-bought', scope: 'class', kind: 'equipment', text: '园里买了两个鼓', at: AT(20), source: 'teacher', supersedes: 'f-drum' };
  const r = supersedeFact([NO_DRUM, LOUD], bought, { ...NOW, byTeacher: true });
  assert.equal(byId(r.facts, 'f-loud').archived, undefined, '怕大声跟有没有鼓是两回事');
});

// --- must NOT supersede ---

test('supersede: with no pointer, nothing is archived and both stay live', () => {
  // Contradiction is a semantic judgement this module cannot make, and a
  // heuristic would archive real constraints on a coin flip.
  const r = supersedeFact([NO_DRUM], { scope: 'class', kind: 'equipment', text: '园里买了两个鼓', at: AT(20), source: 'teacher' }, NOW);
  assert.deepEqual(r.archived, []);
  assert.equal(live(r.facts).length, 2);
});

test('supersede: an automatic judgement cannot retire a deliberate one', () => {
  // The clamp pins this incoming fact to course scope; it must not then archive
  // the class fact she widened by hand.
  const guess = { id: 'f-guess', scope: 'class', kind: 'equipment', text: '园里买了两个鼓', at: AT(20), source: 'auto', supersedes: 'f-drum' };
  const r = supersedeFact([NO_DRUM], guess, NOW);
  assert.equal(byId(r.facts, 'f-drum').archived, undefined, '她亲手放宽的事实不能被自动抽取抹掉');
  assert.deepEqual(r.archived, []);
  assert.deepEqual(r.refused, [{ id: 'f-drum', reason: 'auto_cannot_archive_wider' }]);
  assert.equal(live(r.facts).length, 2, '两条都留着，让她自己决定');
});

test('supersede: she can retire her own class fact by hand', () => {
  const hers = { id: 'f-hers', scope: 'class', kind: 'equipment', text: '园里买了两个鼓', at: AT(20), source: 'teacher', supersedes: 'f-drum' };
  assert.equal(byId(supersedeFact([NO_DRUM], hers, { ...NOW, byTeacher: true }).facts, 'f-drum').archived, true);
});

test('supersede: the same words WITHOUT her tap cannot retire her class fact', () => {
  // The other direction of the same rule: an extractor that merely claims to be
  // her leaves both rows live and says why.
  const claimed = { id: 'f-x', scope: 'class', kind: 'equipment', text: '园里买了两个鼓', at: AT(20), source: 'teacher', supersedes: 'f-drum' };
  const r = supersedeFact([NO_DRUM], claimed, NOW);
  assert.equal(byId(r.facts, 'f-drum').archived, undefined);
  assert.deepEqual(r.refused, [{ id: 'f-drum', reason: 'auto_cannot_archive_wider' }]);
});

test('supersede: auto may retire an equally narrow fact', () => {
  const newSchedule = { id: 'f-t2', scope: 'course', kind: 'schedule', text: '改成每周二下午', at: AT(20), source: 'auto', supersedes: 'f-theme' };
  const r = supersedeFact([THEME], newSchedule, NOW);
  assert.equal(byId(r.facts, 'f-theme').archived, true, '同一层级的替换是正常工作');
});

test('supersede: an already-archived or missing target is reported, not silent', () => {
  const retired = { ...NO_DRUM, archived: true, archived_at: AT(5), archive_reason: 'cap' };
  const next = { id: 'f-x', scope: 'class', kind: 'equipment', text: '有鼓了', at: AT(20), source: 'teacher', supersedes: ['f-drum', 'f-ghost'] };
  const r = supersedeFact([retired], next, NOW);
  assert.deepEqual(r.refused.map((x) => x.reason).sort(), ['already_archived', 'not_found']);
  assert.equal(byId(r.facts, 'f-drum').archive_reason, 'cap', '不覆盖原来的归档原因');
});

// ---------- cap ----------

const many = (n, from = 1) => Array.from({ length: n }, (_, i) => ({
  id: `f${i + from}`, scope: 'course', kind: 'equipment', text: `事实${i + from}`, at: AT(i + from), source: 'auto',
}));

test('cap: under the cap nothing moves and nothing is said', () => {
  const facts = many(5);
  const r = capFacts(facts, 10, NOW);
  assert.deepEqual(r.archived, []);
  assert.equal(r.notice, '', '没归档就不要吵');
  assert.equal(live(r.facts).length, 5);
});

test('cap: exactly at the cap is not over it', () => {
  assert.deepEqual(capFacts(many(5), 5, NOW).archived, []);
});

test('cap: over the cap archives the overflow and says so', () => {
  const r = capFacts(many(8), 5, NOW);
  assert.equal(live(r.facts).length, 5);
  assert.equal(r.facts.length, 8, '归档不是删除');
  assert.equal(r.archived.length, 3);
  assert.match(r.notice, /3 条/, '静默截断是被禁止的，必须说出来');
  assert.match(r.notice, /归档不是删除/);
  assert.ok(r.notice.includes('事实1'), '要说清是哪几条走了');
});

test('cap: oldest-UNUSED goes first, not oldest', () => {
  // A fact she keeps hitting outranks one she stated last week and never
  // touched again.
  const facts = [
    { id: 'old-but-used', scope: 'course', kind: 'equipment', text: '常用的老事实', at: AT(1), used_at: AT(28), source: 'auto' },
    { id: 'newer-unused', scope: 'course', kind: 'equipment', text: '没再用过', at: AT(5), source: 'auto' },
    { id: 'newest', scope: 'course', kind: 'equipment', text: '最新的', at: AT(9), source: 'auto' },
  ];
  const r = capFacts(facts, 2, NOW);
  assert.deepEqual(idsOf(r.archived), ['newer-unused']);
  assert.equal(byId(r.facts, 'old-but-used').archived, undefined);
});

test('cap: archived facts do not count toward the cap', () => {
  // They already stopped riding the prompt, so they must not push live facts out.
  const facts = [
    ...many(3),
    { id: 'gone', scope: 'course', kind: 'equipment', text: '早就归档了', at: AT(1), source: 'auto', archived: true, archived_at: AT(2), archive_reason: 'cap' },
  ];
  const r = capFacts(facts, 3, NOW);
  assert.deepEqual(r.archived, []);
  assert.equal(r.notice, '');
});

test('cap: archiving records why and when', () => {
  const r = capFacts(many(3), 2, NOW);
  assert.equal(r.archived[0].archive_reason, 'cap');
  assert.equal(r.archived[0].archived_at, AT(30));
});

test('cap: a missing or nonsense cap falls back to the documented default', () => {
  assert.deepEqual(capFacts(many(3), undefined, NOW).archived, [], `默认上限是 ${DEFAULT_FACT_CAP}`);
  assert.deepEqual(capFacts(many(3), 'lots', NOW).archived, []);
  assert.equal(capFacts(many(DEFAULT_FACT_CAP + 2), undefined, NOW).archived.length, 2);
});

test('cap: never widens a fact on the way through', () => {
  const r = capFacts([...many(3), { id: 'w', scope: 'class', kind: 'equipment', text: '想变宽', at: AT(9), source: 'auto' }], 10, NOW);
  assert.equal(byId(r.facts, 'w').scope, 'course');
});

// ---------- widen ----------

test('widen: course to class is her deliberate act, and is recorded as hers', () => {
  const r = widenScope([THEME], 'f-theme', 'class', NOW);
  assert.equal(r.widened, true);
  assert.equal(r.reason, '');
  const f = byId(r.facts, 'f-theme');
  assert.equal(f.scope, 'class');
  assert.equal(f.source, 'teacher', '放宽是她点的，之后重新加载不能被夹回 course');
  assert.equal(f.widened_from, 'course');
  assert.equal(f.widened_at, AT(30));
});

test('widen: a widened fact survives normalizeFacts on reload', () => {
  const widened = widenScope([THEME], 'f-theme', 'class', NOW).facts;
  assert.equal(normalizeFacts(widened, NOW)[0].scope, 'class', '存一次读一次就掉回去，等于没放宽');
});

test('widen: class to teacher is the second rung', () => {
  const r = widenScope([NO_DRUM], 'f-drum', 'teacher', NOW);
  assert.equal(r.widened, true);
  assert.equal(byId(r.facts, 'f-drum').scope, 'teacher');
});

test('widen: two taps record where the fact originally sat', () => {
  const once = widenScope([THEME], 'f-theme', 'class', NOW).facts;
  const twice = widenScope(once, 'f-theme', 'teacher', NOW).facts;
  assert.equal(byId(twice, 'f-theme').scope, 'teacher');
  assert.equal(byId(twice, 'f-theme').widened_from, 'course', '要看得出它本来只是一门课的事实');
});

// --- must NOT widen ---

test('widen: skipping a rung is refused', () => {
  // 「我带的每个班每一年都这样」 is a much bigger claim than 「这个班就是这样」, and one
  // tap should not assert both.
  const r = widenScope([THEME], 'f-theme', 'teacher', NOW);
  assert.equal(r.widened, false);
  assert.equal(r.reason, 'illegal_step');
  assert.equal(byId(r.facts, 'f-theme').scope, 'course', '原样不动');
});

test('widen: narrowing is refused — a function named widen must not do it', () => {
  const r = widenScope([NO_DRUM], 'f-drum', 'course', NOW);
  assert.equal(r.widened, false);
  assert.equal(r.reason, 'illegal_step');
  assert.equal(byId(r.facts, 'f-drum').scope, 'class');
});

test('widen: an archived fact is not promoted', () => {
  const retired = { ...THEME, archived: true, archived_at: AT(5), archive_reason: 'superseded' };
  const r = widenScope([retired], 'f-theme', 'class', NOW);
  assert.equal(r.widened, false);
  assert.equal(r.reason, 'archived');
});

test('widen: node scope is not this module to promote', () => {
  const nodeFact = { id: 'n1', scope: 'node', kind: 'equipment', text: '因为孩子提了这个问题', at: AT(1), source: 'teacher' };
  assert.equal(widenScope([nodeFact], 'n1', 'course', NOW).reason, 'illegal_step');
});

test('widen: nothing above teacher scope, and a no-op says so', () => {
  const top = { id: 't1', scope: 'teacher', kind: 'teacher_preference', text: '她喜欢先看整月', at: AT(1), source: 'teacher', ...WIDENED };
  assert.equal(widenScope([top], 't1', 'teacher', NOW).reason, 'already');
  assert.equal(widenScope([top], 't1', 'kindergarten', NOW).reason, 'illegal_step');
});

test('widen: an unknown id changes nothing and reports why', () => {
  const r = widenScope([THEME], 'f-ghost', 'class', NOW);
  assert.equal(r.widened, false);
  assert.equal(r.reason, 'not_found');
  assert.equal(r.facts.length, 1);
});

// ---------- the TSV block ----------

const BLOCK = [NO_DRUM, LOUD, THEME];

test('tsv: the header carries the version and the exact column order', () => {
  const lines = factsToTSV(BLOCK, 'class').split('\n');
  assert.ok(lines[0].startsWith('# memory '), '第一行是版本标记');
  assert.ok(lines[0].includes(MEMORY_TSV_VERSION));
  assert.ok(lines[0].includes('scope=class'));
  assert.deepEqual(lines[1].split('\t'), MEMORY_COLUMNS);
});

test('tsv: never emits an empty cell', () => {
  const bare = [{ id: 'f1', scope: 'course', kind: 'equipment', text: '没有原话的事实', at: AT(1), source: 'auto' }];
  for (const rows of [factsToTSV(BLOCK).split('\n').slice(2), factsToTSV(bare).split('\n').slice(2)]) {
    for (const row of rows) {
      const cells = row.split('\t');
      assert.equal(cells.length, MEMORY_COLUMNS.length, `列数必须固定：${row}`);
      for (const c of cells) assert.ok(c.length > 0, `空格子会让模型串列：${row}`);
    }
  }
});

test('tsv: filters to one scope, and renders all scopes without one', () => {
  const classOnly = factsToTSV(BLOCK, 'class');
  assert.ok(classOnly.includes('班上没有鼓'));
  assert.ok(!classOnly.includes('周三下午'), 'course 的事实不该混进 class 块');
  assert.equal(factsToTSV(BLOCK).split('\n').length, 2 + BLOCK.length);
  assert.ok(factsToTSV(BLOCK, 'nonsense').includes('scope=all'));
});

test('tsv: archived facts never ride the prompt', () => {
  // Not sending them is the entire point of archiving.
  const retired = { ...NO_DRUM, archived: true, archived_at: AT(5), archive_reason: 'superseded', superseded_by: 'f-x' };
  const tsv = factsToTSV([retired, LOUD], 'class');
  assert.ok(!tsv.includes('班上没有鼓'), '已被推翻的说法不能再进提示词');
  assert.ok(tsv.includes('有几个孩子怕大声'));
  assert.ok(tsv.includes('1 条'));
});

test('tsv: an empty block still emits the header', () => {
  // So the assembler assertion (ADR-0011 §5) can tell 「a new class has no
  // facts」 from 「a refactor stopped appending memory」.
  const tsv = factsToTSV([], 'class');
  assert.ok(tsv.includes('scope=class'));
  assert.ok(tsv.includes('0 条'));
  assert.equal(tsv.split('\n').length, 2);
});

test('tsv: the source column tells the model how firm the fact is', () => {
  const row = factsToTSV(BLOCK, 'course').split('\n')[2];
  assert.ok(row.endsWith('\tauto'), '没经她确认的事实要看得出来');
  assert.ok(factsToTSV(BLOCK, 'class').split('\n')[2].endsWith('\tteacher'));
});

test('tsv: timestamps render as the date alone', () => {
  // Time of day has never decided whether a class owns a drum; the full value
  // stays in the store and in the export.
  assert.ok(factsToTSV(BLOCK, 'course').includes('2026-09-02'));
  assert.ok(!factsToTSV(BLOCK, 'course').includes('T09:00:00'));
});

// CHANGED BY THE 2026-08 REVIEW (was: 「prose is clipped rather than allowed to
// bloat every turn」). The block used to cut text at 60 characters — the exact
// operation prompt-builder refuses on a node summary, because a row ending
// 「…这一条是我的猜测」 arrives at the model as a flat assertion once the qualifier
// is cut off. Over-length rows now render whole and are counted in the header.
test('tsv: an over-length fact is reported, never truncated mid-qualifier', () => {
  const wordy = [{
    id: 'f1', scope: 'course', at: AT(1), source: 'auto',
    kind: 'equipment', text: `${'很长的事实'.repeat(20)}，这一条是我的猜测，还没问过她`,
    quote: '很长的原话'.repeat(40),
  }];
  const out = factsToTSV(wordy, 'course');
  assert.ok(out.includes('还没问过她'), '限定语必须活着到达模型');
  assert.ok(!out.includes('…'), '不做静默截断');
  assert.ok(out.split('\n')[0].includes('1 条超出建议长度'), '超长要说出来，不能只是变短');
});

test('MUST PASS — a short fact renders exactly as before', () => {
  const row = factsToTSV([THEME], 'course').split('\n')[2].split('\t');
  assert.deepEqual(row, ['f-theme', 'schedule', 'course', '这门课每周只有周三下午', '我们每周三下午才有整块时间', '2026-09-02', 'auto']);
});

test('tsv: a tab or newline inside a fact cannot break alignment', () => {
  const nasty = [{ id: 'f1', scope: 'course', kind: 'equipment', text: '班上\t没有鼓\n还怕大声', quote: 'a\tb', at: AT(1), source: 'auto' }];
  const row = factsToTSV(nasty, 'course').split('\n')[2];
  assert.equal(row.split('\t').length, MEMORY_COLUMNS.length);
  assert.ok(row.includes('班上 没有鼓 还怕大声'), '制表符被压成空格，不是被丢掉');
});

// ---------- the walkthrough ADR-0011 is written around ----------

test('the drum story: one sentence in 活动 3.2.1 reaches 周3 two days later', () => {
  // Auto-extraction files it at course scope; she taps widen because it is
  // true of the class, not the theme; two days later the class block still
  // carries it, with her own words attached.
  const heard = { kind: 'equipment', text: '班上没有鼓', quote: '我们班没有鼓，而且有几个孩子很怕大声', at: AT(1), source: 'auto', scope: 'class' };
  const added = mergeFact([], heard, NOW);
  assert.equal(added.action, 'added');
  assert.equal(added.facts[0].scope, 'course', '自动抽取到此为止');

  const promoted = widenScope(added.facts, added.facts[0].id, 'class', NOW);
  assert.equal(promoted.widened, true);

  const block = factsToTSV(promoted.facts, 'class');
  assert.ok(block.includes('班上没有鼓'));
  assert.ok(block.includes('我们班没有鼓'), '原话跟着走，错抽取才查得出来');
  assert.ok(block.includes('teacher'), '放宽是她的决定，模型该知道');
});

// ---------- which scopes ride the prompt ----------

test('PROMPT_SCOPES: widest first, and node is deliberately not in it', () => {
  // The order is the tail-loss order — if anything is ever cut, it must be the
  // narrowest claim, not the one that binds every class she teaches.
  assert.deepEqual([...PROMPT_SCOPES], ['teacher', 'class', 'course']);
  assert.ok(!PROMPT_SCOPES.includes('node'), 'node memory is generated and reaches the model as the focus band');
  for (const s of PROMPT_SCOPES) assert.ok(SCOPES.includes(s), `${s} must be a real scope`);
});

test('PROMPT_SCOPES: every scope on the list renders its own block, and each one can hold facts', () => {
  // MUST PASS in every direction at once: a scope on the list that `factsToTSV`
  // filtered to nothing would be a band that silently drops her widened facts.
  const one = (scope) => ({ id: `f-${scope}`, kind: 'space', scope, text: `${scope} 作用域的一条约束`, at: AT(1), source: scope === 'course' ? 'auto' : 'teacher', widened_at: AT(2) });
  const all = PROMPT_SCOPES.map(one);
  for (const scope of PROMPT_SCOPES) {
    const block = factsToTSV(all, scope);
    assert.ok(block.includes(`scope=${scope}`), `${scope} header`);
    assert.ok(block.includes(`${scope} 作用域的一条约束`), `${scope} row`);
    assert.ok(block.includes('1 条'), `${scope} counts exactly its own`);
  }
});
