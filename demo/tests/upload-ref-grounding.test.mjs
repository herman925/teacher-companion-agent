// upload-ref-grounding.test.mjs — `upload_ref` as an evidence source, and the
// exact boundary of what it may ground.
//
// Until now an `upload_ref` grounded NOTHING: no caller passed a resolver, so
// engine.evidenceIsGrounded took the closed branch every time. Opening that
// channel means the resolver decides whether a claim about children counts as
// recorded — so the resolver IS the evidence rule, and it has to be wrong in
// the safe direction on every case that is not exactly right.
//
// The resolver under test is the one the server builds:
//     new Set(await store.listMaterialIds(userId, courseId))  →  set.has(ref)
// built here from the SAME store methods, so the ownership property is proved
// against real rows and real row-scoping rather than against a stub that agrees
// with itself.
//
// Four cases, and only the first may pass:
//   1. her own material, on THIS course        → grounds
//   2. her own material, on ANOTHER course     → does not (the quiet one)
//   3. another teacher's material              → does not (privacy + fabrication)
//   4. no resolver supplied at all             → does not (the closed default)
//
// Both appliers are checked on every case. L3 and applyDelta must reach the
// same verdict on the same row: a harness that grounds what applyDelta then
// marks reports a turn legal that the ledger will contradict.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { createJsonStore } from '../src/store/json-store.mjs';
import { parseTurn, validateTurn } from '../src/harness.mjs';
import { applyDelta, createInitialState, evidenceIsGrounded } from '../src/engine.mjs';

/** Two teachers, three courses, one material each. */
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'cst-uref-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createJsonStore({ baseDir: dir });
  const { user: a } = await store.createUser({ username: `uref_a_${Math.random().toString(36).slice(2, 7)}` });
  const { user: b } = await store.createUser({ username: `uref_b_${Math.random().toString(36).slice(2, 7)}` });
  const thisCourse = await store.createCourse(a.id, '醒狮');
  const otherCourse = await store.createCourse(a.id, '龙舟');   // same teacher, last term
  const bCourse = await store.createCourse(b.id, '客家围屋');
  const photo = (userId, courseId) => store.recordMaterial(userId, courseId, {
    kind: 'photo',
    mime_type: 'image/jpeg',
    cos_key: `courses/${courseId}/${randomUUID()}.jpg`,
    size_bytes: 1024,
    exif_stripped: true,
    contains_children: true,
  });
  return {
    store, a, b, thisCourse, otherCourse, bCourse,
    mine: await photo(a.id, thisCourse.id),
    minesElsewhere: await photo(a.id, otherCourse.id),
    hers: await photo(b.id, bCourse.id),
  };
}

/** The resolver exactly as the server builds it. */
async function resolverFor(store, userId, courseId) {
  const owned = new Set((await store.listMaterialIds(userId, courseId)).map(String));
  return (ref) => owned.has(String(ref));
}

/** A turn whose only claim about children rests on one uploaded file. */
const turnCiting = (ref) => parseTurn({
  reply_markdown: '孩子们发现龙舟要一起用力才划得动，这一点可以往下走。',
  state_delta: {
    children_evidence: [{
      id: 'ev-1', kind: 'photo', content: '孩子们发现龙舟要一起用力', upload_ref: ref, round: 1,
    }],
  },
  evidence_refs: ['ev-1'],
}).turn;

/** She said nothing that could ground this — the upload is the only candidate. */
const TEACHER_TEXT = '你看看这张照片。';

// An ungrounded row raises TWO fabrication violations, and both are correct:
// the row itself is refused, and the `evidence_refs` pointing at it is then
// pointing at nothing. The count is not the claim here — 「at least one, naming
// this row」 is, so the assertions do not pin a number that belongs to the
// harness rather than to this rule.
const fabrications = (violations) => violations.filter((v) => v.kind === 'fabrication');
const refusedTheRow = (violations) => fabrications(violations).some((v) => v.detail.includes('ev-1'));

test('her own material on THIS course grounds the evidence — L3 and applyDelta agree', async (t) => {
  const f = await fixture(t);
  const resolveUploadRef = await resolverFor(f.store, f.a.id, f.thisCourse.id);
  const turn = turnCiting(f.mine.id);

  assert.equal(evidenceIsGrounded(turn.state_delta.children_evidence[0], TEACHER_TEXT, { resolveUploadRef }), true);

  const v = validateTurn(turn, createInitialState('c1'), { teacherText: TEACHER_TEXT, resolveUploadRef });
  assert.deepEqual(fabrications(v), [], 'L3 放行');

  const applied = applyDelta(createInitialState('c1'), turn.state_delta, { teacherText: TEACHER_TEXT, resolveUploadRef });
  assert.deepEqual(fabrications(applied.violations), [], 'apply 也放行');
  assert.equal(applied.state.children_evidence[0].pending_validation, undefined, '不该被标成待核实');
});

test('her own material from ANOTHER course does not ground evidence here', async (t) => {
  const f = await fixture(t);
  // The quiet fabrication channel: same teacher, real file, real upload — just
  // not a record of anything that happened in THIS course.
  const resolveUploadRef = await resolverFor(f.store, f.a.id, f.thisCourse.id);
  const turn = turnCiting(f.minesElsewhere.id);

  assert.equal(evidenceIsGrounded(turn.state_delta.children_evidence[0], TEACHER_TEXT, { resolveUploadRef }), false);

  const v = validateTurn(turn, createInitialState('c1'), { teacherText: TEACHER_TEXT, resolveUploadRef });
  assert.ok(refusedTheRow(v), '上一门课的照片撑不起这门课的断言');

  const applied = applyDelta(createInitialState('c1'), turn.state_delta, { teacherText: TEACHER_TEXT, resolveUploadRef });
  assert.equal(applied.state.children_evidence[0].pending_validation, true);

  // …and it DOES ground on the course it actually belongs to, so the refusal
  // above is about the course rather than about the file being unreadable.
  const there = await resolverFor(f.store, f.a.id, f.otherCourse.id);
  assert.equal(there(f.minesElsewhere.id), true);
});

test('another teacher\'s material grounds nothing — ownership, not existence', async (t) => {
  const f = await fixture(t);
  const resolveUploadRef = await resolverFor(f.store, f.a.id, f.thisCourse.id);
  const turn = turnCiting(f.hers.id);

  assert.equal(evidenceIsGrounded(turn.state_delta.children_evidence[0], TEACHER_TEXT, { resolveUploadRef }), false);
  assert.ok(refusedTheRow(validateTurn(turn, createInitialState('c1'), { teacherText: TEACHER_TEXT, resolveUploadRef })));
  const applied = applyDelta(createInitialState('c1'), turn.state_delta, { teacherText: TEACHER_TEXT, resolveUploadRef });
  assert.equal(applied.state.children_evidence[0].pending_validation, true);

  // The store is the reason, not the resolver's arithmetic: B's row is not in
  // A's list at all, on any course of A's.
  assert.equal((await f.store.listMaterialIds(f.a.id, f.bCourse.id)).length, 0);
  assert.equal(await f.store.getMaterial(f.a.id, f.hers.id), null, '别人的素材连读都读不到');
});

test('an invented id grounds nothing, and neither does a missing resolver', async (t) => {
  const f = await fixture(t);
  const resolveUploadRef = await resolverFor(f.store, f.a.id, f.thisCourse.id);

  const invented = turnCiting(randomUUID());
  assert.equal(evidenceIsGrounded(invented.state_delta.children_evidence[0], TEACHER_TEXT, { resolveUploadRef }), false);

  // THE CLOSED DEFAULT. This is the behaviour every caller had before the
  // endpoint existed, and it is what a path with no course (the stateless
  // /api/chat branch) still gets. A resolver that is absent must never read as
  // a resolver that said yes.
  const real = turnCiting(f.mine.id);
  assert.equal(evidenceIsGrounded(real.state_delta.children_evidence[0], TEACHER_TEXT, {}), false);
  assert.ok(refusedTheRow(validateTurn(real, createInitialState('c1'), { teacherText: TEACHER_TEXT })));
  // A non-function is not a resolver either — a JSON body cannot carry one, and
  // a truthy value must not be mistaken for a verdict.
  assert.equal(evidenceIsGrounded(real.state_delta.children_evidence[0], TEACHER_TEXT, { resolveUploadRef: true }), false);
});
