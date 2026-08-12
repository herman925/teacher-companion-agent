// importer.test.mjs — the one-time JSON → PostgreSQL importer.
//
// The transform is tested here in full; the INSERTION tests skip without
// DATABASE_URL, and that is a correctness requirement rather than a convenience.
// There is no PostgreSQL on a developer machine in this project — the database
// runs only on the Lighthouse VM (ADR-0013 §1) — so a suite that tried to
// connect would fail everywhere this repository is developed, and a test that
// fails locally is a broken build, not a finding.
//
// That constraint is also why demo/scripts/import-json-to-pg.mjs separates the
// pure json-course-to-rows mapping from the writing: the mapping is where the
// two decisions of DATABASE.md open question 4d live, and it is the half that
// can actually be proved on the machine the code is written on.
//
// Every rule gets BOTH directions: a fixture that trips it and one that must
// pass untouched.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  stripEmptyPlan, evidenceRefProblems, courseToRows, userToRow, materialToRow,
  buildPlan, verifyTotals, verifyCourses, readDataDir,
  MESSAGE_ROLES, UNHANDLED_FILES, SKIPPED_FILES,
} from '../scripts/import-json-to-pg.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'scripts', 'import-json-to-pg.mjs');

const UID = '11111111-1111-4111-8111-111111111111';
const UID2 = '22222222-2222-4222-8222-222222222222';
const CID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CID2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** A pre-v2 course file: no subjects on the messages, no course_plan anywhere. */
function preV2Course(over = {}) {
  return {
    id: CID,
    user_id: UID,
    title: '醒狮',
    course_state: { course_id: CID, schema_version: 1, stage: 2, children_evidence: [] },
    state_version: 3,
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-09T00:00:00.000Z',
    next_message_id: 3,
    messages: [
      { id: 1, role: 'teacher', content: '我们班想做醒狮', created_at: '2026-05-01T00:01:00.000Z' },
      { id: 2, role: 'agent', content: '好的……', turn_contract: { evidence_refs: [] }, created_at: '2026-05-01T00:02:00.000Z' },
    ],
    snapshots: [
      { state_version: 1, state_delta: { stage: 1 }, course_state: { stage: 1 }, is_checkpoint: true, created_at: '2026-05-01T00:02:00.000Z' },
    ],
    ...over,
  };
}

// ===========================================================================
describe('decision 1 — an imported message is course-level', () => {
  test('a message written before subjects existed becomes 「course」', () => {
    const r = courseToRows(preV2Course(), { file: 'courses/a.json' });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.messages.map((m) => m.subject), ['course', 'course']);
    assert.equal(r.stats.subjects_defaulted, 2);
  });

  test('a message that already names a node keeps it — the tag is additive, not overwritten', () => {
    const raw = preV2Course();
    raw.messages[1].subject = '3.2.1';
    const r = courseToRows(raw, { file: 'courses/a.json' });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.messages.map((m) => m.subject), ['course', '3.2.1']);
    // Only the untagged one counts as defaulted.
    assert.equal(r.stats.subjects_defaulted, 1);
  });

  test('a blank or non-string subject is not treated as a node id', () => {
    const raw = preV2Course();
    raw.messages[0].subject = '   ';
    raw.messages[1].subject = 42;
    const r = courseToRows(raw, { file: 'courses/a.json' });
    assert.deepEqual(r.messages.map((m) => m.subject), ['course', 'course']);
  });
});

// ===========================================================================
describe('decision 2 — a pre-v2 course has NO course_plan, not an empty one', () => {
  test('absent stays absent', () => {
    const r = courseToRows(preV2Course(), { file: 'courses/a.json' });
    assert.equal('course_plan' in r.course.course_state, false);
    assert.equal(r.stats.plan_dropped, false);
    assert.equal(r.stats.has_plan, false);
  });

  test('an empty husk is dropped — a blank plan is a lie about the teacher\'s work', () => {
    const raw = preV2Course();
    raw.course_state.course_plan = { version: 2, roots: [], revision_log: [] };
    const r = courseToRows(raw, { file: 'courses/a.json' });
    assert.equal('course_plan' in r.course.course_state, false);
    assert.equal(r.stats.plan_dropped, true);
    assert.match(r.notes.join(' '), /empty course_plan/);
  });

  test('a course_plan with no roots array at all is also a husk', () => {
    const raw = preV2Course();
    raw.course_state.course_plan = { version: 1 };
    const r = courseToRows(raw, { file: 'courses/a.json' });
    assert.equal('course_plan' in r.course.course_state, false);
    assert.equal(r.stats.plan_dropped, true);
  });

  test('a real plan travels untouched — THE DIRECTION THAT MUST NOT FIRE', () => {
    const plan = {
      version: 4,
      roots: [{ id: '1', title: '第一阶段', status: 'confirmed', work_status: 'settled', children: [{ id: '1.1', title: '周1' }] }],
      revision_log: [{ v: 4, op: 'set', node_id: '1.1' }],
    };
    const raw = preV2Course();
    raw.course_state.course_plan = structuredClone(plan);
    const r = courseToRows(raw, { file: 'courses/a.json' });
    assert.deepEqual(r.course.course_state.course_plan, plan);
    assert.equal(r.stats.plan_dropped, false);
    assert.equal(r.stats.has_plan, true);
  });

  test('stripEmptyPlan never mutates its input — the file on disk is the backup', () => {
    const state = { course_plan: { version: 1, roots: [] }, stage: 2 };
    const before = structuredClone(state);
    stripEmptyPlan(state);
    assert.deepEqual(state, before);
  });

  test('the blueprint is deliberately NOT stripped — 4d decides course_plan only', () => {
    const raw = preV2Course();
    raw.course_state.course_plan_blueprint = { version: 0, modules: [] };
    const r = courseToRows(raw, { file: 'courses/a.json' });
    assert.deepEqual(r.course.course_state.course_plan_blueprint, { version: 0, modules: [] });
    assert.match(r.notes.join(' '), /blueprint/);
  });
});

// ===========================================================================
describe('message ids are renumbered, so evidence must not depend on them', () => {
  test('an ev- reference passes untouched', () => {
    assert.deepEqual(evidenceRefProblems({ turn_contract: { evidence_refs: ['ev-words-1'] } }), []);
  });

  test('a bare numeric reference is refused — it would silently re-point', () => {
    const problems = evidenceRefProblems({ messages: [{ turn_contract: { evidence_refs: ['7'] } }] });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /message id/);
  });

  test('a number, not just a numeric string, is caught', () => {
    assert.equal(evidenceRefProblems({ a: { evidence_refs: [12] } }).length, 1);
  });

  test('refs nested inside course_plan nodes are reached too', () => {
    const raw = preV2Course();
    raw.course_state.course_plan = { version: 1, roots: [{ id: '1', children: [{ id: '1.1', evidence_refs: ['3'] }] }] };
    const r = courseToRows(raw, { file: 'courses/a.json' });
    assert.equal(r.course, null);
    assert.match(r.errors.join(' '), /message id/);
  });

  test('a cyclic object terminates instead of hanging', () => {
    const a = { evidence_refs: ['ev-1'] };
    a.self = a;
    assert.deepEqual(evidenceRefProblems(a), []);
  });
});

// ===========================================================================
describe('message ordering and roles', () => {
  test('messages come out in original id order, whatever order the file holds', () => {
    const raw = preV2Course();
    raw.messages = [
      { id: 3, role: 'teacher', content: 'c' },
      { id: 1, role: 'teacher', content: 'a' },
      { id: 2, role: 'agent', content: 'b' },
    ];
    const r = courseToRows(raw, { file: 'courses/a.json' });
    assert.deepEqual(r.messages.map((m) => m.content), ['a', 'b', 'c']);
  });

  test('every allowed role passes', () => {
    const raw = preV2Course();
    raw.messages = MESSAGE_ROLES.map((role, i) => ({ id: i + 1, role, content: role }));
    const r = courseToRows(raw, { file: 'courses/a.json' });
    assert.deepEqual(r.errors, []);
    assert.equal(r.messages.length, MESSAGE_ROLES.length);
  });

  test('an unknown role stops the course rather than being mapped by guess', () => {
    const raw = preV2Course();
    raw.messages[1].role = 'assistant';
    const r = courseToRows(raw, { file: 'courses/a.json' });
    assert.equal(r.course, null);
    assert.match(r.errors.join(' '), /assistant/);
    assert.match(r.errors.join(' '), /No mapping is guessed/);
  });
});

// ===========================================================================
describe('snapshots — the audit trail arrives whole or the import stops', () => {
  test('a checkpoint with its document passes', () => {
    const r = courseToRows(preV2Course(), { file: 'courses/a.json' });
    assert.deepEqual(r.errors, []);
    assert.equal(r.snapshots.length, 1);
    assert.equal(r.snapshots[0].is_checkpoint, true);
    assert.deepEqual(r.snapshots[0].course_state, { stage: 1 });
  });

  test('a checkpoint with no document is refused — replay from it is impossible', () => {
    const raw = preV2Course();
    raw.snapshots[0].course_state = null;
    const r = courseToRows(raw, { file: 'courses/a.json' });
    assert.equal(r.course, null);
    assert.match(r.errors.join(' '), /checkpoint with no course_state/);
  });

  test('a document on a non-checkpoint row is nulled, matching how both stores write it', () => {
    const raw = preV2Course();
    raw.snapshots = [{ state_version: 2, state_delta: {}, course_state: { stage: 2 }, is_checkpoint: false }];
    const r = courseToRows(raw, { file: 'courses/a.json' });
    assert.deepEqual(r.errors, []);
    assert.equal(r.snapshots[0].course_state, null);
    assert.match(r.notes.join(' '), /non-checkpoint/);
  });

  test('two snapshots at one version are named here, not by a constraint mid-transaction', () => {
    const raw = preV2Course();
    raw.snapshots = [
      { state_version: 1, state_delta: {}, is_checkpoint: false },
      { state_version: 1, state_delta: {}, is_checkpoint: false },
    ];
    const r = courseToRows(raw, { file: 'courses/a.json' });
    assert.equal(r.course, null);
    assert.match(r.errors.join(' '), /share state_version 1/);
  });

  test('a missing state_delta becomes {} — the column is NOT NULL', () => {
    const raw = preV2Course();
    raw.snapshots = [{ state_version: 1, is_checkpoint: false }];
    const r = courseToRows(raw, { file: 'courses/a.json' });
    assert.deepEqual(r.snapshots[0].state_delta, {});
  });
});

// ===========================================================================
describe('course row shape', () => {
  test('a well-formed pre-v2 file maps cleanly', () => {
    const r = courseToRows(preV2Course(), { file: 'courses/a.json' });
    assert.deepEqual(r.errors, []);
    assert.equal(r.course.id, CID);
    assert.equal(r.course.user_id, UID);
    assert.equal(r.course.title, '醒狮');
    assert.equal(r.course.state_version, 3);
    assert.equal(r.course.class_id, null);          // no class existed pre-ADR-0011
    assert.equal(r.course.title_locked, false);
    assert.equal(r.course.workbench, null);
    assert.equal(r.course.created_at, '2026-05-01T00:00:00.000Z');
  });

  test('a non-uuid id is refused rather than coerced', () => {
    const r = courseToRows(preV2Course({ id: 'course-7' }), { file: 'courses/a.json' });
    assert.equal(r.course, null);
    assert.match(r.errors.join(' '), /course id is not a uuid/);
  });

  test('a missing course_state is refused — the column is NOT NULL', () => {
    const r = courseToRows(preV2Course({ course_state: null }), { file: 'courses/a.json' });
    assert.equal(r.course, null);
    assert.match(r.errors.join(' '), /course_state is missing/);
  });

  test('a missing title falls back to the tier\'s own default, and says so', () => {
    const r = courseToRows(preV2Course({ title: '  ' }), { file: 'courses/a.json' });
    assert.equal(r.course.title, '新课程');
    assert.match(r.notes.join(' '), /新课程/);
  });
});

// ===========================================================================
describe('users', () => {
  const jsonUser = (over = {}) => ({
    id: UID, username: 'uitester', display_name: 'UI Tester', role: 'teacher',
    status: 'active', password: 'scrypt$abc$def', must_change_password: false,
    display_name_changed_at: null, created_at: '2026-04-01T00:00:00.000Z',
    created_by: UID2, last_login_at: null, settings: { profile: { age_band: '中班' } },
    ...over,
  });

  test('the JSON `password` becomes `password_hash` — dropping it locks everyone out', () => {
    const { user, errors } = userToRow(jsonUser());
    assert.deepEqual(errors, []);
    assert.equal(user.password_hash, 'scrypt$abc$def');
    assert.equal('password' in user, false);
    assert.deepEqual(user.settings, { profile: { age_band: '中班' } });
    assert.equal(user.created_by, UID2);
  });

  test('a role or status outside the CHECK is refused, not coerced', () => {
    assert.match(userToRow(jsonUser({ role: 'superuser' })).errors.join(' '), /role/);
    assert.match(userToRow(jsonUser({ status: 'suspended' })).errors.join(' '), /status/);
  });

  test('「disabled」 is accepted and NOT rewritten to 「revoked」', () => {
    // Mapping it would start the retention clock and turn 「temporarily
    // disabled」 into 「erased in 12 months」 (pg-store.mjs, required schema).
    const { user, errors } = userToRow(jsonUser({ status: 'disabled' }));
    assert.deepEqual(errors, []);
    assert.equal(user.status, 'disabled');
    assert.equal(user.revoked_at, null);
  });

  test('a revoked user with no revoked_at is imported and flagged, never given a guessed date', () => {
    const { user, notes } = userToRow(jsonUser({ status: 'revoked' }));
    assert.equal(user.revoked_at, null);
    assert.match(notes.join(' '), /retention clock never started/);
  });

  test('settings defaults to {} rather than null — the column is NOT NULL', () => {
    assert.deepEqual(userToRow(jsonUser({ settings: undefined })).user.settings, {});
  });
});

// ===========================================================================
describe('materials — a lost row is a child photo nobody can delete', () => {
  const jsonMaterial = (over = {}) => ({
    id: MID, user_id: UID, course_id: CID, kind: 'photo',
    cos_key: 'courses/x/y.jpg', mime_type: 'image/jpeg', size_bytes: 12345,
    exif_stripped: true, contains_children: true, retention_until: '2027-01-01',
    created_at: '2026-05-02T00:00:00.000Z', ...over,
  });

  test('a complete row maps', () => {
    const { material, errors } = materialToRow(jsonMaterial());
    assert.deepEqual(errors, []);
    assert.equal(material.cos_key, 'courses/x/y.jpg');
    assert.equal(material.contains_children, true);
  });

  test('a course-less material is an ERROR, never a silent skip', () => {
    const { material, errors } = materialToRow(jsonMaterial({ course_id: null }));
    assert.equal(material, null);
    assert.match(errors.join(' '), /only handle on the stored object/);
  });

  test('a row with no cos_key is refused', () => {
    assert.match(materialToRow(jsonMaterial({ cos_key: '' })).errors.join(' '), /no cos_key/);
  });
});

// ===========================================================================
describe('buildPlan', () => {
  const users = [{ id: UID, username: 'a', display_name: 'A', role: 'teacher', status: 'active', password: 'h' }];

  test('counts what will be written, and how much of it is defaulted', () => {
    const plan = buildPlan({
      users,
      courses: [{ file: 'courses/a.json', raw: preV2Course() }],
    });
    assert.deepEqual(plan.errors, []);
    assert.deepEqual(plan.counts, {
      users: 1, courses: 1, messages: 2, snapshots: 1, materials: 0,
      subjects_defaulted: 2, plan_husks_dropped: 0, courses_with_plan: 0,
    });
  });

  test('a husk is counted so the report can show it was dropped', () => {
    const raw = preV2Course();
    raw.course_state.course_plan = { version: 1, roots: [] };
    const plan = buildPlan({ users, courses: [{ file: 'courses/a.json', raw }] });
    assert.equal(plan.counts.plan_husks_dropped, 1);
    assert.equal(plan.counts.courses_with_plan, 0);
  });

  test('the same course id in two files is refused', () => {
    const plan = buildPlan({
      users,
      courses: [
        { file: 'courses/a.json', raw: preV2Course() },
        { file: 'courses/b.json', raw: preV2Course() },
      ],
    });
    assert.match(plan.errors.join(' '), /appears in more than one file/);
    assert.equal(plan.counts.courses, 1);
  });

  test('two accounts sharing a display name are caught before the UNIQUE index sees them', () => {
    const plan = buildPlan({
      users: [
        { id: UID, username: 'a', display_name: 'Same', role: 'teacher', status: 'active', password: 'h' },
        { id: UID2, username: 'b', display_name: 'Same', role: 'teacher', status: 'active', password: 'h' },
      ],
    });
    assert.match(plan.errors.join(' '), /display name/);
  });

  test('a course whose owner is in neither the files nor (yet) the DB is flagged, not dropped', () => {
    const plan = buildPlan({ users: [], courses: [{ file: 'courses/a.json', raw: preV2Course() }] });
    // Not an error here: a rerun legitimately finds the owner already in the
    // database. importPlan resolves it there, before writing anything.
    assert.deepEqual(plan.errors, []);
    assert.equal(plan.orphanCourses.length, 1);
    assert.equal(plan.orphanCourses[0].kind, 'course');
    assert.equal(plan.orphanCourses[0].user_id, UID);
  });

  test('a course with an error contributes nothing at all — half a course is invisible damage', () => {
    const bad = preV2Course({ id: CID2 });
    bad.messages[0].role = 'assistant';
    const plan = buildPlan({
      users,
      courses: [
        { file: 'courses/good.json', raw: preV2Course() },
        { file: 'courses/bad.json', raw: bad },
      ],
    });
    assert.equal(plan.counts.courses, 1);
    assert.equal(plan.counts.messages, 2);           // only the good course's
    assert.match(plan.errors.join(' '), /courses\/bad\.json/);
  });
});

// ===========================================================================
describe('verification — the half that refuses to report success', () => {
  test('agreeing totals pass', () => {
    const v = verifyTotals({ users: 2, courses: 5, messages: 100 },
      { users: 4, courses: 12, messages: 340 },
      { users: 2, courses: 7, messages: 240 });
    assert.equal(v.ok, true);
    assert.deepEqual(v.problems, []);
  });

  test('one message short is a refusal, and says which count', () => {
    const v = verifyTotals({ users: 2, courses: 5, messages: 100 },
      { users: 4, courses: 12, messages: 339 },
      { users: 2, courses: 7, messages: 240 });
    assert.equal(v.ok, false);
    assert.equal(v.problems.length, 1);
    assert.match(v.problems[0], /^messages: expected 340/);
  });

  test('a rerun that inserts nothing still has to balance', () => {
    const same = { users: 4, courses: 12, messages: 340 };
    const v = verifyTotals(same, same, { users: 0, courses: 0, messages: 0 });
    assert.equal(v.ok, true);
  });

  test('per-course reconciliation passes when every file matches its rows', () => {
    const v = verifyCourses([
      { file: 'courses/a.json', id: CID, present: true, messages: 12, snapshots: 3, expected_messages: 12, expected_snapshots: 3 },
    ]);
    assert.equal(v.ok, true);
  });

  test('a half-imported course is caught even when the totals happen to balance', () => {
    const v = verifyCourses([
      { file: 'courses/a.json', id: CID, present: true, messages: 10, snapshots: 3, expected_messages: 12, expected_snapshots: 3 },
      { file: 'courses/b.json', id: CID2, present: true, messages: 14, snapshots: 1, expected_messages: 12, expected_snapshots: 1 },
    ]);
    assert.equal(v.ok, false);
    assert.equal(v.problems.length, 2);
  });

  test('a course that never arrived is named', () => {
    const v = verifyCourses([
      { file: 'courses/a.json', id: CID, present: false, messages: 0, snapshots: 0, expected_messages: 12, expected_snapshots: 3 },
    ]);
    assert.equal(v.ok, false);
    assert.match(v.problems[0], /is not in the database/);
  });
});

// ===========================================================================
describe('non-destructive — the JSON files are the backup', () => {
  test('the script imports only read APIs from node:fs/promises', async () => {
    const src = await readFile(SCRIPT, 'utf8');
    const m = src.match(/import \{([^}]*)\} from 'node:fs\/promises';/);
    assert.ok(m, 'expected a named import from node:fs/promises');
    const named = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    const readOnly = new Set(['readFile', 'readdir', 'stat', 'lstat', 'access', 'realpath', 'opendir']);
    for (const name of named) {
      assert.ok(readOnly.has(name),
        `${name} is not a read-only fs API; the importer must not be able to touch the backup`);
    }
  });

  test('reading a data directory leaves every file byte-identical', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'importer-'));
    await mkdir(path.join(base, 'courses'), { recursive: true });
    await mkdir(path.join(base, 'auth'), { recursive: true });
    const courseFile = path.join(base, 'courses', `${CID}.json`);
    const usersFile = path.join(base, 'auth', 'users.json');
    await writeFile(courseFile, JSON.stringify(preV2Course(), null, 2), 'utf8');
    await writeFile(usersFile, JSON.stringify(
      [{ id: UID, username: 'a', display_name: 'A', role: 'teacher', status: 'active', password: 'h' }], null, 2), 'utf8');

    const beforeCourse = await readFile(courseFile, 'utf8');
    const beforeUsers = await readFile(usersFile, 'utf8');
    const beforeStat = await stat(courseFile);

    const data = await readDataDir(base);
    const plan = buildPlan(data);
    assert.deepEqual(plan.errors, []);
    assert.equal(plan.counts.courses, 1);
    assert.equal(plan.counts.messages, 2);

    assert.equal(await readFile(courseFile, 'utf8'), beforeCourse);
    assert.equal(await readFile(usersFile, 'utf8'), beforeUsers);
    assert.equal((await stat(courseFile)).mtimeMs, beforeStat.mtimeMs);
  });

  test('an absent data directory reads as empty rather than throwing', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'importer-empty-'));
    const data = await readDataDir(base);
    assert.deepEqual(data.courses, []);
    assert.deepEqual(data.users, []);
    assert.deepEqual(data.unhandled, []);
  });

  test('a corrupt course file is an error, not a silent empty course', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'importer-bad-'));
    await mkdir(path.join(base, 'courses'), { recursive: true });
    await writeFile(path.join(base, 'courses', 'x.json'), '{ not json', 'utf8');
    await assert.rejects(() => readDataDir(base), /not valid JSON/);
  });
});

// ===========================================================================
describe('row files this script does not handle', () => {
  test('a non-empty unhandled file is reported with a reason', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'importer-facts-'));
    await mkdir(path.join(base, 'auth'), { recursive: true });
    await writeFile(path.join(base, 'facts.json'),
      JSON.stringify([{ id: '1', user_id: UID, scope: 'class', kind: 'equipment', body: '班上没有鼓' }]), 'utf8');
    const data = await readDataDir(base);
    assert.equal(data.unhandled.length, 1);
    assert.equal(data.unhandled[0].file, 'facts.json');
    assert.equal(data.unhandled[0].rows, 1);
    assert.match(data.unhandled[0].why, /memory/);
  });

  test('an EMPTY unhandled file is silent — the normal pre-v2 case', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'importer-nofacts-'));
    await writeFile(path.join(base, 'facts.json'), '[]', 'utf8');
    const data = await readDataDir(base);
    assert.deepEqual(data.unhandled, []);
  });

  test('the id-keyed vault file is counted by key, not treated as zero rows', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'importer-keys-'));
    await mkdir(path.join(base, 'auth'), { recursive: true });
    await writeFile(path.join(base, 'auth', 'keys.json'),
      JSON.stringify({ [UID]: { glm: 'ciphertext' } }), 'utf8');
    const data = await readDataDir(base);
    assert.equal(data.unhandled.length, 1);
    assert.equal(data.unhandled[0].rows, 1);
  });

  test('sessions and rate limits are skipped deliberately, with the reason stated', () => {
    const files = SKIPPED_FILES.map(([f]) => f);
    assert.ok(files.includes('auth/sessions.json'));
    for (const [, why] of SKIPPED_FILES) assert.ok(why.length > 20, 'every skip states a reason');
    for (const [, why] of UNHANDLED_FILES) assert.ok(why.length > 20, 'every refusal states a reason');
  });
});

// ===========================================================================
// INSERTION — skips without DATABASE_URL. See the header: there is no
// PostgreSQL on this machine, and a test that fails locally is a broken build.
// ===========================================================================

const skip = !process.env.DATABASE_URL
  && 'DATABASE_URL 未设置——本机没有 PostgreSQL，跳过（ADR-0013：数据库只在 Lighthouse 服务器上）';

describe('importPlan against a real database', { skip }, () => {
  // Run against a database that can be thrown away, as `postgres` or
  // `app_admin`, with 001–004 plus the auth-plane migration applied.
  const load = async () => import('../scripts/import-json-to-pg.mjs');
  const url = () => process.env.DATABASE_URL_ADMIN || process.env.DATABASE_URL;

  /** A course id nothing else uses, so a rerun of this suite is not itself a
   * test of idempotency by accident. */
  const freshPlan = () => {
    const uid = crypto.randomUUID();
    const cid = crypto.randomUUID();
    const raw = preV2Course({ id: cid, user_id: uid });
    return buildPlan({
      users: [{
        id: uid, username: `imp${uid.slice(0, 8)}`, display_name: `Importer ${uid.slice(0, 8)}`,
        role: 'teacher', status: 'active', password: 'scrypt$test$test',
      }],
      courses: [{ file: `courses/${cid}.json`, raw }],
    });
  };

  test('a first run inserts everything and verifies', async () => {
    const { importPlan } = await load();
    const plan = freshPlan();
    const report = await importPlan(plan, { connectionString: url(), log: () => {} });
    assert.deepEqual(report.problems, []);
    assert.equal(report.ok, true);
    assert.equal(report.inserted.users, 1);
    assert.equal(report.inserted.courses, 1);
    assert.equal(report.inserted.messages, 2);
    assert.equal(report.inserted.snapshots, 1);
  });

  test('a second run of the SAME plan inserts nothing and still verifies', async () => {
    const { importPlan } = await load();
    const plan = freshPlan();
    const first = await importPlan(plan, { connectionString: url(), log: () => {} });
    assert.equal(first.ok, true);

    const second = await importPlan(plan, { connectionString: url(), log: () => {} });
    assert.equal(second.ok, true, second.problems.join('; '));
    assert.equal(second.inserted.users, 0);
    assert.equal(second.inserted.courses, 0);
    assert.equal(second.inserted.messages, 0);
    assert.equal(second.skipped.courses, 1);
    // The counts did not move, which is the whole claim.
    assert.deepEqual(second.before, second.after);
  });

  test('a dry run writes nothing', async () => {
    const { importPlan } = await load();
    const plan = freshPlan();
    const report = await importPlan(plan, { connectionString: url(), dryRun: true, log: () => {} });
    assert.equal(report.ok, true);
    assert.equal(report.inserted.courses, 0);

    const verify = await importPlan(plan, { connectionString: url(), dryRun: true, log: () => {} });
    assert.deepEqual(verify.before, report.before);
  });

  test('a course whose owner exists in neither the files nor the DB is refused before any write', async () => {
    const { importPlan } = await load();
    const cid = crypto.randomUUID();
    const plan = buildPlan({
      users: [],
      courses: [{ file: `courses/${cid}.json`, raw: preV2Course({ id: cid, user_id: crypto.randomUUID() }) }],
    });
    const report = await importPlan(plan, { connectionString: url(), log: () => {} });
    assert.equal(report.ok, false);
    assert.equal(report.inserted.courses, 0);
    assert.match(report.problems.join(' '), /belongs to user/);
  });

  test('the imported messages are subject-tagged 「course」 in the database', async () => {
    const { importPlan } = await load();
    const plan = freshPlan();
    const report = await importPlan(plan, { connectionString: url(), log: () => {} });
    assert.equal(report.ok, true);

    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: url() });
    await client.connect();
    try {
      const { rows } = await client.query(
        'SELECT subject, count(*)::int AS n FROM messages WHERE course_id = $1 GROUP BY subject',
        [plan.courses[0].course.id],
      );
      assert.deepEqual(rows, [{ subject: 'course', n: 2 }]);
      const { rows: courseRows } = await client.query(
        "SELECT course_state ? 'course_plan' AS has_plan FROM courses WHERE id = $1",
        [plan.courses[0].course.id],
      );
      // Decision 2, checked where it actually matters: the stored document has
      // no course_plan key at all, not an empty one.
      assert.equal(courseRows[0].has_plan, false);
    } finally {
      await client.end();
    }
  });
});
