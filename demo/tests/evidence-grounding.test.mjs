// evidence-grounding.test.mjs — non-negotiable #1 at its narrowest point.
//
// `evidenceIsGrounded` is the single function that decides whether a
// `children_evidence` row counts as a RECORD of what children did or as the
// model's own assertion. Both the engine (applyDelta) and the runtime harness
// (validateTurn) route through it, so every gate that depends on evidence —
// stage 2, stage 5, the fabrication verdict, the ledger's
// `pending_validation` stamp — inherits whatever it answers.
//
// Two exemptions used to be free and are not any more; each is pinned here in
// BOTH directions, because a rule that only ever sees its violating fixture is
// a rule nobody has proved is silent when it should be.
//
//   `demo_sample` — a published enum value in course-state.schema.json, so a
//   real vendor turn can emit it. It may only ground when the payload came out
//   of mockTurn().
//
//   `upload_ref` — grounded on any truthy value while no upload pipeline
//   existed. It may only ground when a resolver confirms the reference names a
//   material row this teacher owns on this course.

import test from 'node:test';
import assert from 'node:assert/strict';

import { evidenceIsGrounded, applyDelta, createInitialState, stageGateError } from '../src/engine.mjs';

const quoted = { id: 'ev-1', content: '孩子们把龙舟推到水边', quote: '他们把龙舟推到水边' };
const sampled = { id: 'ev-2', content: '孩子们发现龙舟要一起用力', source: 'demo_sample' };
const uploaded = { id: 'ev-3', content: '孩子们发现龙舟要一起用力', upload_ref: 'mat-7' };

const SAID = '今天他们把龙舟推到水边，笑得很大声。';

// ------------------------------------------------------------ the quote path
// Unchanged behaviour, asserted so the two fixes below cannot be mistaken for a
// general tightening that also broke the ordinary case.

test('MUST PASS — a quote the teacher actually said grounds, mock or not', () => {
  assert.equal(evidenceIsGrounded(quoted, SAID), true);
  assert.equal(evidenceIsGrounded(quoted, SAID, { mock: true }), true);
});

test('a quote she never said does not ground', () => {
  assert.equal(evidenceIsGrounded({ id: 'ev-x', quote: '孩子们学会了打鼓' }, SAID), false);
});

// -------------------------------------------------------------- demo_sample

test('demo_sample from a real provider is NOT grounded — one turn cannot mint its own permission slip', () => {
  assert.equal(evidenceIsGrounded(sampled, SAID), false, 'no ctx at all is the strict answer');
  assert.equal(evidenceIsGrounded(sampled, SAID, {}), false);
  assert.equal(evidenceIsGrounded(sampled, SAID, { mock: false }), false);
  // A truthy-but-not-true value must not buy the exemption either: the flag is
  // set by exactly two call sites and both pass a boolean.
  assert.equal(evidenceIsGrounded(sampled, SAID, { mock: 'yes' }), false);
});

test('MUST PASS — demo_sample from the scripted walkthrough still grounds', () => {
  assert.equal(evidenceIsGrounded(sampled, SAID, { mock: true }), true);
  // …and with no teacher message at all, which is the walkthrough's own case.
  assert.equal(evidenceIsGrounded(sampled, '', { mock: true }), true);
});

// --------------------------------------------------------------- upload_ref

test('upload_ref grounds nothing without a resolver', () => {
  assert.equal(evidenceIsGrounded(uploaded, SAID), false);
  assert.equal(evidenceIsGrounded(uploaded, SAID, { mock: true }), false, 'mock does not unlock uploads');
});

test('MUST PASS — an upload_ref the resolver recognizes grounds', () => {
  const owned = (ref) => ref === 'mat-7';
  assert.equal(evidenceIsGrounded(uploaded, SAID, { resolveUploadRef: owned }), true);
});

test("another teacher's material id does not ground", () => {
  const owned = (ref) => ref === 'mat-7';
  const stolen = { id: 'ev-4', content: '孩子们发现龙舟要一起用力', upload_ref: 'mat-999' };
  assert.equal(evidenceIsGrounded(stolen, SAID, { resolveUploadRef: owned }), false);
  // A resolver that answers anything other than `true` is not an answer.
  assert.equal(evidenceIsGrounded(uploaded, SAID, { resolveUploadRef: () => 'sure' }), false);
});

// ------------------------------------------------- what it costs the ledger

// Stage 1, because the ordinal rule owns 0 → 2 and this pair is about the
// EVIDENCE branch of the gate, not about jumping two stages.
const atStageOne = (id) => ({ ...createInitialState(id), stage: 1 });

test('a demo_sample row from a vendor turn is stamped pending_validation and opens no gate', () => {
  const state = atStageOne('c-1');
  const r = applyDelta(state, { children_evidence: [sampled] }, { teacherText: SAID, mock: false });
  const row = r.state.children_evidence.find((e) => e.id === 'ev-2');
  assert.equal(row.pending_validation, true, 'the row is KEPT — dropping it would lose teacher content');
  assert.ok(r.violations.some((v) => v.kind === 'fabrication'));
  // The gate is the consequence that matters: a marked row buys no advance.
  assert.ok(stageGateError(r.state, 2), 'stage 2 must stay shut on unmarked-nothing');
});

test('MUST PASS — the same row on the mock path is clean and does open the gate', () => {
  const state = atStageOne('c-2');
  const r = applyDelta(state, { children_evidence: [sampled] }, { teacherText: SAID, mock: true });
  const row = r.state.children_evidence.find((e) => e.id === 'ev-2');
  assert.equal(row.pending_validation, undefined);
  assert.equal(r.violations.filter((v) => v.kind === 'fabrication').length, 0);
  assert.equal(stageGateError(r.state, 2), null);
});
