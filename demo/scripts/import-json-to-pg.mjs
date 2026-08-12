#!/usr/bin/env node
// import-json-to-pg.mjs — the ONE-TIME importer: JSON files on disk → PostgreSQL.
//
// ADR-0013 §5 moves teacher data off disk files into Postgres. There are 24 real
// course files on the public instance and 9 on dev, all written before subjects,
// the plan tree and typed facts existed. This script carries them across, along
// with the accounts, the uploaded materials, the admin audit trail and the
// per-account key vault.
//
// ============================================================================
// THE TWO DECISIONS DATABASE.md OPEN QUESTION 4d MAKES, AND WHY
// ============================================================================
//
// 1. AN IMPORTED MESSAGE'S SUBJECT IS 'course'.
//    Not a guess at which node it was about — a guess would be a fabricated
//    claim about the teacher's own conversation. 'course' is the safe default,
//    and it is the reason the tag was designed to be additive (ADR-0010 §1):
//    every message written before subjects existed reads back as course-level,
//    so there is no migration to get wrong. normalizeSubject() is imported from
//    json-store rather than reimplemented, because that default IS the contract
//    and a second copy is a second thing to drift.
//
// 2. A PRE-V2 COURSE HAS NO course_plan. NOT AN EMPTY ONE.
//    An empty plan renders as a plan that exists and is blank — a lie about the
//    teacher's work, and the sort of lie non-negotiable #1 exists to stop.
//    So: an absent course_plan stays absent, and an EMPTY husk
//    ({ roots: [] }, or a course_plan with no roots array at all) is dropped on
//    the way in and counted in the report. A plan with real nodes travels
//    untouched. The JSON files keep whatever they had — see 「non-destructive」.
//
// ============================================================================
// WHY MESSAGE IDS CHANGE, AND WHY THAT IS SAFE
// ============================================================================
// The JSON tier numbers messages per course, starting at 1, so ids collide
// across courses. `messages.id` in Postgres is GENERATED ALWAYS AS IDENTITY and
// globally unique, so imported messages are RENUMBERED. That is only safe
// because nothing points at a message id:
//
//   * `evidence_refs` resolve against `course_state.children_evidence`, whose
//     entries carry their own string ids ('ev-…'). The whole course_state
//     document travels as one JSONB value, so every reference inside it is
//     preserved by construction (harness/schema/course-state.schema.json).
//   * `course_snapshots.message_id` — 「the turn that proposed it」 — was never
//     recorded by the JSON tier, so there is nothing to map. It is imported as
//     NULL. Inventing a link would fabricate a row in the audit trail that the
//     evidence rules resolve against.
//
// That reasoning is load-bearing, so it is CHECKED rather than trusted:
// evidenceRefProblems() walks the whole course record and refuses any
// evidence_ref that is shaped like a bare message id. If the real dataset ever
// carries one, this script stops instead of silently re-pointing a citation at
// a different turn.
//
// Message ORDER is preserved: rows are sorted by their original per-course id
// and inserted sequentially on one connection, so the identity sequence keeps
// them in reading order. Global ordering is what proves 「she asked about 3.2.1
// BEFORE she edited 周2」 (ADR-0010 §1); losing it would lose that proof.
//
// ============================================================================
// THE AUDIT TRAIL AND THE KEY VAULT — THE KEY CHOSEN FOR EACH, AND WHY
// ============================================================================
// Both travel. Leaving either behind is loss nobody would notice until it
// mattered: an admin action with no record, or a teacher whose model access
// silently stopped existing.
//
// auth/keys.json → user_keys. NATURAL KEY: (user_id, provider), which is the
//   table's own PRIMARY KEY. `ON CONFLICT (user_id, provider) DO NOTHING`, and
//   DO NOTHING rather than DO UPDATE on purpose: a row already in the database
//   was written by the running server and is NEWER than the file, so overwriting
//   it would undo a key the teacher rotated after this file was last written.
//   The ciphertext is carried VERBATIM — not decrypted, not re-encrypted, not
//   trimmed, never logged. It is AES-256-GCM (`v1$iv$tag$ct`, key-vault.mjs), so
//   a single changed byte fails the auth tag and reads as 未配置 — and the
//   teacher finds out when a turn fails, not now. That is why the reconciliation
//   below re-reads every row and compares the string byte for byte.
//   NOT CARRIED: `updated_at`. The JSON vault records no timestamp at all, so
//   the column takes its DEFAULT now() — the honest value for 「when this row was
//   written here」. Nothing reads it; contrast admin_audit.created_at below,
//   where the timestamp IS the record.
//
// auth/audit.json → admin_audit. NO NATURAL KEY EXISTS. The file's `id` is a
//   per-file counter (json-store: `rows.length + 1`) and `admin_audit.id` is
//   GENERATED ALWAYS AS IDENTITY, so audit rows are renumbered exactly as
//   messages are. Nothing points at an audit row, so that is safe.
//   Re-running stays safe WITHOUT a key: rows are grouped by the tuple that is
//   actually imported — (admin_id, action, target_user, detail, created_at) —
//   and each group inserts only the SHORTFALL between the rows the file holds
//   and the rows the database already holds. One identical row already present
//   inserts nothing; two identical rows in the file and one in the database
//   inserts one. So a second run writes nothing, and a genuine repeated action
//   is not swallowed as if it were a re-import. `detail` is compared as jsonb,
//   which is key-order-independent, and grouping canonicalizes it the same way
//   so the two agree.
//   The ASSUMPTION this rests on, stated rather than hidden: two rows are 「the
//   same row」 only if all five fields match, and created_at is compared as
//   written. One writer at millisecond precision (json-store's nowISO) makes a
//   collision between two different actions effectively impossible; if one ever
//   happened the reconciliation reports a mismatch and stops, which is loud
//   rather than silent.
//   TIMESTAMPS AND ACTORS ARE PRESERVED EXACTLY. `created_at` is never
//   defaulted — a row with no usable timestamp is a REFUSAL, not a row stamped
//   with the import time, because an audit trail that says everything happened
//   during the migration is worthless. `admin_id` and `target_user` travel as
//   they are, including when they name somebody who is no longer in `users`:
//   005_auth_plane.sql puts NO foreign key on either column precisely so
//   accountability outlives the admin's own erasure. Unknown ids are REPORTED,
//   never dropped.
//
// ----------------------------------------------------------------------------
// THE 'console' ACTOR — admin_id NULL, and the label kept in `detail`
// ----------------------------------------------------------------------------
// The real trail does not hold a uuid in every `admin_id`. serve.mjs writes the
// literal string 'console' for every action taken through the shared
// ADMIN_TOKEN path (`store.audit('console', …)`, a dozen call sites), and the
// first real dry-run refused all 27 rows on exactly that.
//
// The refusal was right and it stays. What changes is that ONE known sentinel
// now has a decided meaning:
//
//   * 'console' is NOT A PERSON. It is an operator holding a shared token, with
//     no named admin account behind it. ADR-0013 §8 says this in as many words:
//     the console 「is gated by a shared password today (adminAuthorized compares
//     a token, RESOLVING NO USER)」, and until that becomes session + role,
//     「attribution is impossible」. demo/tests/admin-access.test.mjs asserts the
//     same thing from the other side.
//   * So the honest uuid is NULL. Minting a synthetic uuid for it would
//     FABRICATE accountability — the trail would assert a named actor that never
//     existed. That is the same class of error as fabricating child evidence,
//     pointed at us instead of at a teacher, and it is worse than a null because
//     a null is visibly unknown while a uuid looks like an answer.
//   * NULL is already in this column's vocabulary. 005_auth_plane.sql declares
//     `admin_id uuid` with no NOT NULL and no foreign key, and eraseUser nulls
//     `target_user` on the same principle — the migration's own comment calls
//     that 「the same rule read from the other side」. No migration is needed for
//     any of this, and none is added: the column already permits NULL and
//     `detail` is already jsonb.
//   * The label is NOT LOST. `{"actor_label": "console"}` is merged into the
//     row's existing `detail`, so a reader sees both facts: no named admin, and
//     the actor was the console token. That is more true than a coerced uuid and
//     more true than a dropped row.
//
// NAMED EXCEPTION, NOT A COERCION RULE. Only the exact string 'console' maps to
// NULL. Every other non-uuid `admin_id` still REFUSES with the original message.
// The moment this became general, a corrupt value would import silently as
// 「actor unknown」 — which is precisely the failure the refusal exists to catch.
// `target_user` gets NO exception at all: 'console' is a thing that acts, never
// a thing that is acted upon, so a console in that column is a corrupt row.
//
// The merge happens INSIDE auditToRow, i.e. BEFORE grouping, so the tuple that
// decides 「same row」 already contains the merged `detail` and a second run still
// matches and inserts nothing. That ordering is load-bearing and is tested.
//
// ============================================================================
// THE THREE PROPERTIES THIS SCRIPT PROMISES
// ============================================================================
// IDEMPOTENT — keyed on the ids that already exist. Users, courses and
//   materials carry uuids from the JSON files and go in with
//   `ON CONFLICT (id) DO NOTHING`; vault rows key on (user_id, provider).
//   Messages and snapshots have no natural key, so they ride their course: one
//   transaction per course inserts the course row and its children together, and
//   a course that is already present is skipped whole. Audit rows have no key at
//   all and use the shortfall rule above. A second run therefore inserts nothing
//   and reports so.
//
// VERIFYING — users, courses, messages, audit rows and vault rows are counted
//   before and after, and the deltas must equal what was inserted. Then every
//   planned course is reconciled row by row: it must be present, with exactly
//   the message and snapshot counts its file holds. Every audit group must be
//   present in at least the number the file holds, with its own timestamp. Every
//   vault row must be present with byte-identical ciphertext. If anything
//   disagrees the script REFUSES to report success and exits non-zero. This is
//   the reason it exists at all — 「it ran without errors」 is not evidence that
//   the data arrived.
//
// NON-DESTRUCTIVE — it never deletes or modifies the JSON files. THEY ARE THE
//   BACKUP, and ADR-0013's open questions record that nothing else backs this
//   data up. Only read APIs are imported from node:fs/promises below, and
//   demo/tests/importer.test.mjs asserts that, so the promise cannot rot into a
//   comment. Nothing is written to the .data directory, including a receipt.
//
// ============================================================================
// PRECONDITIONS
// ============================================================================
//   * Migrations 001–005 applied. 005_auth_plane.sql is not optional here: it is
//     what creates `admin_audit` and `user_keys`, and the account columns on
//     `users`. The script checks for the columns it needs and names the missing
//     ones rather than failing on the first INSERT.
//   * A connection that may write across teachers: `postgres` (superuser) or
//     `app_admin`. Under app_rw's policies a cross-teacher write is refused, and
//     as `app_owner` FORCE ROW LEVEL SECURITY makes it match nothing at all —
//     demo/migrations/README.md 「Operating notes」 says so in as many words. The
//     script checks the role it got and refuses rather than half-importing.
//   * The service is STOPPED. The count-before / count-after check assumes
//     nothing else is writing; a live server would make a correct import look
//     like a failed one, or the reverse.
//
// Usage:
//   node demo/scripts/import-json-to-pg.mjs --dry-run
//   DATABASE_URL_ADMIN=postgresql://app_admin:…@localhost/teacher_platform \
//     node demo/scripts/import-json-to-pg.mjs --data demo/.data
//
// ============================================================================
// WHAT WAS NOT VERIFIED
// ============================================================================
// Written on a machine with no PostgreSQL (ADR-0013 §1: the database runs only
// on the Lighthouse VM). Every statement below is reasoned from the migrations
// and the pg documentation; none has been executed. The pure transform is
// covered by demo/tests/importer.test.mjs; the insertion tests there SKIP
// without DATABASE_URL, so 「the tests pass」 on a laptop says nothing about the
// SQL. Run --dry-run against the real database first, and read the report.
//
// That applies in full to the audit and vault statements added later: the
// grouping, the shortfall arithmetic and the byte-for-byte comparison are
// covered by tests that run everywhere, and the SQL underneath them is not. The
// vault round trip in particular is only PROVEN once a real database has read a
// ciphertext back — which is the first thing to look at in the real report.

// READ-ONLY ON PURPOSE. No writeFile, no unlink, no rename, no mkdir: the JSON
// files are the backup and this script must not be able to touch them even by
// mistake. demo/tests/importer.test.mjs asserts this import list.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// normalizeSubject IS decision 1 (absent/blank → 'course'). Imported rather
// than copied so the importer and the store cannot disagree about it.
import { normalizeSubject, COURSE_SUBJECT } from '../src/store/json-store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.join(HERE, '..', '.data');

/** DATABASE.md §2: `messages.role` CHECK. Nothing outside this list is mapped
 * onto something inside it — a guessed role is a guessed speaker, and 「who said
 * this」 is exactly what the evidence rules read. An unknown value stops the
 * course instead. */
export const MESSAGE_ROLES = Object.freeze(['teacher', 'agent', 'system']);

/** users.role — DATABASE.md §2 (§4 contradicts it and drops 'leader'; §2 plus
 * ADR-0013 is authoritative, as 001_schema.sql records). */
export const USER_ROLES = Object.freeze(['teacher', 'admin', 'leader']);

/** users.status — ADR-0013 §11's three states plus 'disabled', the legacy
 * spelling the console button still writes. pg-store's required-schema note
 * widens the CHECK to the same four, and explains why 'disabled' must NOT be
 * mapped onto 'revoked': that mapping would start the retention clock and turn
 * 「temporarily disabled」 into 「erased in 12 months」. */
export const USER_STATUSES = Object.freeze(['active', 'revoked', 'erased', 'disabled']);

export const MATERIAL_KINDS = Object.freeze(['photo', 'observation', 'document', 'generated']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

/** jsonb bind value. Stringified at the call site and cast with $n::jsonb,
 * because node-postgres renders a JS array as a Postgres ARRAY literal rather
 * than as JSON — an array-shaped delta would fail or, worse, coerce. */
const jsonb = (v) => (v == null ? null : JSON.stringify(v));

/** An ISO string, or null so the column's DEFAULT now() takes over. Never a
 * guessed timestamp: a course whose created_at we invented would sort wrong in
 * the history rail forever. */
const stamp = (v) => (typeof v === 'string' && v.trim() ? v : null);

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// ===========================================================================
// PURE TRANSFORM — everything above the database line
// ===========================================================================
// Kept separate from the insertion so it can be tested on a machine with no
// PostgreSQL, which is every machine this repository is developed on.

/**
 * Decision 2. An EMPTY plan is removed; a real one is untouched; an absent one
 * stays absent.
 *
 * 「Empty」 means no node would render: `course_plan` is not an object, or its
 * `roots` is missing / not an array / has no entries. The plan tree is also the
 * theme map (CONTEXT.md) — there is no second diagram — so a husk here is a
 * blank theme map presented to a teacher as her plan.
 *
 * Never mutates its input: the caller still holds the object it read from the
 * file, and that file is the backup.
 *
 * @param {Object|null|undefined} courseState
 * @returns {{state: Object, dropped: boolean}}
 */
export function stripEmptyPlan(courseState) {
  const state = isPlainObject(courseState) ? { ...courseState } : {};
  if (!('course_plan' in state)) return { state, dropped: false };
  const plan = state.course_plan;
  const hasNodes = isPlainObject(plan) && Array.isArray(plan.roots) && plan.roots.length > 0;
  if (hasNodes) return { state, dropped: false };
  delete state.course_plan;
  return { state, dropped: true };
}

/**
 * Refuse any evidence reference shaped like a bare message id.
 *
 * Message ids are renumbered on import (see the header). That is safe only
 * while every evidence_ref points into `course_state.children_evidence` by its
 * own string id. A numeric ref would survive the import LOOKING correct and
 * resolve to a different turn — a citation that silently changes what it cites
 * is precisely the failure non-negotiable #1 exists to stop, and it arrives
 * with no error to catch.
 *
 * Walks the whole course record — messages, course_state, blueprint nodes, plan
 * nodes, workbench — because evidence_refs appear at several depths. Iterative,
 * so a hand-edited file with a deep tree cannot blow the stack.
 *
 * @param {unknown} root
 * @returns {Array<string>} human-readable problems; empty means clean
 */
export function evidenceRefProblems(root) {
  const problems = [];
  const seen = new Set();
  const stack = [{ node: root, at: '$' }];
  while (stack.length) {
    const { node, at } = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node)) continue;          // a cycle would otherwise never end
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((v, i) => stack.push({ node: v, at: `${at}[${i}]` }));
      continue;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'evidence_refs' && Array.isArray(value)) {
        for (const ref of value) {
          const numeric = typeof ref === 'number'
            || (typeof ref === 'string' && /^\d+$/.test(ref.trim()));
          if (numeric) {
            problems.push(`${at}.evidence_refs cites ${JSON.stringify(ref)}, which is shaped `
              + 'like a message id — message ids are renumbered on import, so this reference '
              + 'would silently point at a different turn');
          }
        }
      }
      stack.push({ node: value, at: `${at}.${key}` });
    }
  }
  return problems;
}

/**
 * One JSON course file → the rows DATABASE.md §2 wants.
 *
 * Returns rows AND problems rather than throwing: the report has to be able to
 * say 「23 of 24 courses are ready, this one is not, here is why」. A course with
 * any error is not imported at all — half a course is worse than none, because
 * the missing half is invisible.
 *
 * @param {Object} raw the parsed course file
 * @param {{file?: string}} [opts]
 * @returns {{
 *   file: string,
 *   course: Object|null,
 *   messages: Array<Object>,
 *   snapshots: Array<Object>,
 *   errors: Array<string>,
 *   notes: Array<string>,
 *   stats: {subjects_defaulted: number, plan_dropped: boolean, has_plan: boolean},
 * }}
 */
export function courseToRows(raw, opts = {}) {
  const file = opts.file ?? '(unnamed)';
  const errors = [];
  const notes = [];
  const messages = [];
  const snapshots = [];
  let subjectsDefaulted = 0;

  if (!isPlainObject(raw)) {
    return {
      file, course: null, messages, snapshots, stats: { subjects_defaulted: 0, plan_dropped: false, has_plan: false },
      errors: ['not a JSON object'], notes,
    };
  }

  if (!isUuid(raw.id)) errors.push(`course id is not a uuid: ${JSON.stringify(raw.id)}`);
  if (!isUuid(raw.user_id)) errors.push(`user_id is not a uuid: ${JSON.stringify(raw.user_id)}`);
  if (!isPlainObject(raw.course_state)) errors.push('course_state is missing or not an object (the column is NOT NULL)');

  // The evidence guard runs over the WHOLE record, before anything is shaped.
  for (const p of evidenceRefProblems(raw)) errors.push(p);

  const { state, dropped } = stripEmptyPlan(raw.course_state);
  if (dropped) {
    notes.push('dropped an empty course_plan — a pre-v2 course has NO plan, not a blank one '
      + '(DATABASE.md open question 4d). The JSON file is untouched.');
  }
  // The blueprint is deliberately NOT given the same treatment. Open question 4d
  // decides course_plan and says nothing about course_plan_blueprint, and
  // extending a recorded decision to a field it does not name would be guessing.
  // Flagged, not fixed.
  if (isPlainObject(state.course_plan_blueprint)
      && !(state.course_plan_blueprint.modules?.length)) {
    notes.push('course_plan_blueprint is present but empty. Carried through unchanged: '
      + 'open question 4d decides course_plan only, and widening it here would be a guess.');
  }

  let title = String(raw.title ?? '').trim();
  if (!title) {
    title = '新课程';
    notes.push('no title in the file; imported as 新课程, the tier\'s own default (the column is NOT NULL)');
  }

  const stateVersion = Number.isInteger(raw.state_version) && raw.state_version >= 0
    ? raw.state_version
    : 0;
  if (raw.state_version != null && stateVersion !== raw.state_version) {
    errors.push(`state_version is not a non-negative integer: ${JSON.stringify(raw.state_version)}`);
  }

  // ---- messages ----
  const rawMessages = Array.isArray(raw.messages) ? raw.messages : [];
  // Sort by the ORIGINAL per-course id. Postgres assigns identity ids in insert
  // order, so this sort is what carries the ordering across — and the ordering
  // is the thing that proves what was asked when (ADR-0010 §1).
  const ordered = rawMessages
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const ai = Number(a.m?.id);
      const bi = Number(b.m?.id);
      if (Number.isFinite(ai) && Number.isFinite(bi) && ai !== bi) return ai - bi;
      return a.i - b.i;                       // file order, for rows with no id
    })
    .map(({ m }) => m);

  for (const m of ordered) {
    if (!isPlainObject(m)) { errors.push('a message is not an object'); continue; }
    const role = String(m.role ?? '');
    if (!MESSAGE_ROLES.includes(role)) {
      errors.push(`message ${JSON.stringify(m.id)} has role ${JSON.stringify(m.role)}, which is `
        + `not one of ${MESSAGE_ROLES.join(' / ')}. No mapping is guessed: if the real dataset `
        + 'uses another spelling, decide it deliberately and add it to MESSAGE_ROLES.');
      continue;
    }
    // DECISION 1, applied here and nowhere else. A message written before
    // subjects existed carries no `subject` field at all, and normalizeSubject
    // turns that into 'course' — which is exactly why the tag was designed to be
    // additive. Counted so the report can say how much of the import is
    // course-level by default rather than by choice.
    const hadSubject = typeof m.subject === 'string' && m.subject.trim() !== '';
    if (!hadSubject) subjectsDefaulted += 1;
    const subject = normalizeSubject(m.subject);
    messages.push({
      source_id: m.id ?? null,               // report only; never written to the database
      role,
      subject,
      content: typeof m.content === 'string' ? m.content : String(m.content ?? ''),
      turn_contract: m.turn_contract ?? null,
      provider: m.provider ?? null,
      provider_label: m.provider_label ?? null,
      usage: m.usage ?? null,
      stage_name: m.stage_name ?? null,
      cache: m.cache ?? null,
      guards: m.guards ?? null,
      created_at: stamp(m.created_at),
    });
  }

  // ---- snapshots ----
  const rawSnapshots = Array.isArray(raw.snapshots) ? raw.snapshots : [];
  const versionsSeen = new Set();
  for (const s of [...rawSnapshots].sort((a, b) => (a?.state_version ?? 0) - (b?.state_version ?? 0))) {
    if (!isPlainObject(s)) { errors.push('a snapshot is not an object'); continue; }
    if (!Number.isInteger(s.state_version)) {
      errors.push(`a snapshot has a non-integer state_version: ${JSON.stringify(s.state_version)}`);
      continue;
    }
    if (versionsSeen.has(s.state_version)) {
      // UNIQUE (course_id, state_version) would abort the transaction anyway;
      // catching it here names the file instead of a constraint.
      errors.push(`two snapshots share state_version ${s.state_version}`);
      continue;
    }
    versionsSeen.add(s.state_version);
    const isCheckpoint = Boolean(s.is_checkpoint);
    if (isCheckpoint && !isPlainObject(s.course_state)) {
      // Reconstruction is 「nearest checkpoint <= V, then replay deltas
      // forward」. A checkpoint with no document breaks every version after it,
      // and the audit trail is what evidence claims resolve against
      // (DATABASE.md §1.2). Stop and let a person look.
      errors.push(`snapshot v${s.state_version} is a checkpoint with no course_state document; `
        + 'replay from it would be impossible');
      continue;
    }
    if (!isCheckpoint && isPlainObject(s.course_state)) {
      notes.push(`snapshot v${s.state_version} carries a document on a non-checkpoint row; `
        + 'imported as NULL, matching how both stores write it');
    }
    snapshots.push({
      state_version: s.state_version,
      state_delta: isPlainObject(s.state_delta) || Array.isArray(s.state_delta) ? s.state_delta : {},
      course_state: isCheckpoint ? s.course_state : null,
      is_checkpoint: isCheckpoint,
      created_at: stamp(s.created_at),
    });
  }

  const course = errors.length ? null : {
    id: raw.id,
    user_id: raw.user_id,
    class_id: null,                          // no class existed before ADR-0011
    title,
    course_state: state,
    state_version: stateVersion,
    title_locked: Boolean(raw.title_locked),
    workbench: isPlainObject(raw.workbench) ? raw.workbench : null,
    created_at: stamp(raw.created_at),
    updated_at: stamp(raw.updated_at) ?? stamp(raw.created_at),
  };

  return {
    file,
    course,
    messages: course ? messages : [],
    snapshots: course ? snapshots : [],
    errors,
    notes,
    stats: {
      subjects_defaulted: subjectsDefaulted,
      plan_dropped: dropped,
      has_plan: Boolean(course && course.course_state.course_plan),
    },
  };
}

/**
 * One JSON user row → the `users` row.
 *
 * The rename that matters: the JSON tier stores the scrypt hash in `password`,
 * the table calls it `password_hash`. Dropping it silently would lock every
 * teacher out of an account that still exists, which looks like a login bug for
 * as long as it takes someone to check the column.
 *
 * @param {Object} raw
 * @returns {{user: Object|null, errors: Array<string>, notes: Array<string>}}
 */
export function userToRow(raw) {
  const errors = [];
  const notes = [];
  if (!isPlainObject(raw)) return { user: null, errors: ['not a JSON object'], notes };
  if (!isUuid(raw.id)) errors.push(`user id is not a uuid: ${JSON.stringify(raw.id)}`);

  const role = String(raw.role ?? 'teacher');
  if (!USER_ROLES.includes(role)) errors.push(`role ${JSON.stringify(raw.role)} is outside ${USER_ROLES.join(' / ')}`);
  const status = String(raw.status ?? 'active');
  if (!USER_STATUSES.includes(status)) errors.push(`status ${JSON.stringify(raw.status)} is outside ${USER_STATUSES.join(' / ')}`);

  const displayName = String(raw.display_name ?? '').trim() || String(raw.username ?? '').trim();
  if (!displayName) errors.push('no display_name and no username (display_name is NOT NULL)');

  const hash = raw.password ?? raw.password_hash ?? null;
  if (!hash) {
    notes.push(`user ${raw.username ?? raw.id} has no stored password; imported with a NULL `
      + 'password_hash, so login will need an admin reset');
  }
  if (status === 'revoked' && !raw.revoked_at) {
    // json-store's isDueForErasure treats this as a data defect and never marks
    // the row due, rather than guessing a date and erasing early. Carried across
    // as-is, and said out loud so it is visible in the console afterwards.
    notes.push(`user ${raw.username ?? raw.id} is revoked with no revoked_at; the retention `
      + 'clock never started and the row will never come due for erasure');
  }

  const user = errors.length ? null : {
    id: raw.id,
    username: raw.username ?? null,
    display_name: displayName,
    password_hash: hash,
    role,
    status,
    revoked_at: stamp(raw.revoked_at),
    must_change_password: Boolean(raw.must_change_password),
    display_name_changed_at: stamp(raw.display_name_changed_at),
    settings: isPlainObject(raw.settings) ? raw.settings : {},
    created_at: stamp(raw.created_at),
    last_login_at: stamp(raw.last_login_at),
    // Applied in a second pass: created_by references users(id), and the admin
    // who provisioned an account is not guaranteed to sort before it.
    created_by: isUuid(raw.created_by) ? raw.created_by : null,
  };
  return { user, errors, notes };
}

/**
 * One JSON material row → the `materials` row.
 *
 * A material that cannot be imported is not a cosmetic loss: the row is the only
 * record of the object key, and an object nobody recorded is a child photo
 * nobody can find to delete (ADR-0013 §6). So a bad row is an ERROR, never a
 * skip.
 */
export function materialToRow(raw) {
  const errors = [];
  if (!isPlainObject(raw)) return { material: null, errors: ['not a JSON object'] };
  if (!isUuid(raw.id)) errors.push(`material id is not a uuid: ${JSON.stringify(raw.id)}`);
  if (!isUuid(raw.user_id)) errors.push(`material ${raw.id}: user_id is not a uuid`);
  if (!isUuid(raw.course_id)) {
    // materials.course_id is NOT NULL in DATABASE.md §2. The JSON tier allowed a
    // course-less material, so this is a real shape difference and not a typo.
    errors.push(`material ${raw.id} has no course; materials.course_id is NOT NULL, so this row `
      + 'cannot be imported as it stands. Do NOT drop it — its cos_key is the only handle on the '
      + 'stored object (ADR-0013 §6). Attach it to a course, or delete the object first.');
  }
  if (!MATERIAL_KINDS.includes(String(raw.kind ?? ''))) errors.push(`material ${raw.id}: kind ${JSON.stringify(raw.kind)} is outside the allowlist`);
  if (!String(raw.cos_key ?? '').trim()) errors.push(`material ${raw.id}: no cos_key`);
  if (!String(raw.mime_type ?? '').trim()) errors.push(`material ${raw.id}: no mime_type`);

  const material = errors.length ? null : {
    id: raw.id,
    course_id: raw.course_id,
    user_id: raw.user_id,
    kind: String(raw.kind),
    cos_key: String(raw.cos_key).trim(),
    mime_type: String(raw.mime_type),
    size_bytes: Number(raw.size_bytes ?? 0) || 0,
    exif_stripped: Boolean(raw.exif_stripped),
    contains_children: Boolean(raw.contains_children),
    retention_until: raw.retention_until ?? null,
    created_at: stamp(raw.created_at),
  };
  return { material, errors };
}

/** The one non-uuid `admin_id` with a decided meaning: the shared-token console
 * path, which ADR-0013 §8 records as 「resolving no user」. Exact match only —
 * see 「THE 'console' ACTOR」 in the header for why this is a named exception and
 * must never become a general coercion rule. */
export const CONSOLE_ACTOR = 'console';

/** Where the console label goes inside `detail`. One constant, because the
 * importer writes it and a reader has to know what to look for. */
export const ACTOR_LABEL_KEY = 'actor_label';

/**
 * One JSON audit row → the `admin_audit` row.
 *
 * The timestamp and the two actor ids are the record. `created_at` is REQUIRED:
 * a row imported with the column's DEFAULT would claim the action happened
 * during the migration, and an audit trail that says that is worthless. So a
 * missing or unparseable timestamp is an ERROR — a person decides, not this
 * script.
 *
 * `admin_id` / `target_user` are carried as they are. A uuid naming somebody who
 * is no longer in `users` is NOT a defect here: 005_auth_plane.sql puts no
 * foreign key on either column so that accountability survives that admin's own
 * erasure (ADR-0013 §11). Unknown ids are reported by importPlan, never dropped.
 *
 * The single exception is `admin_id === 'console'` → NULL, with
 * `{actor_label: 'console'}` merged into `detail`. Everything else non-uuid
 * still refuses. The merge happens HERE, before grouping, so the idempotency
 * tuple already carries it.
 *
 * @param {Object} raw
 * @param {{index?: number}} [opts]
 * @returns {{row: Object|null, errors: Array<string>, notes: Array<string>}}
 */
export function auditToRow(raw, opts = {}) {
  const errors = [];
  const notes = [];
  const at = `row ${opts.index != null ? opts.index + 1 : '?'}`;
  if (!isPlainObject(raw)) return { row: null, errors: [`${at}: not a JSON object`], notes };

  const action = String(raw.action ?? '').trim();
  if (!action) errors.push(`${at}: no action (the column is NOT NULL). An audit row that does not `
    + 'say what was done records nothing.');

  // The console sentinel, and ONLY the console sentinel.
  const isConsole = raw.admin_id === CONSOLE_ACTOR;
  if (raw.admin_id != null && !isUuid(raw.admin_id) && !isConsole) {
    errors.push(`${at}: admin_id is ${JSON.stringify(raw.admin_id)}, which is not a uuid and not `
      + 'null. The column is uuid; no value is coerced, because the actor is the point of the row.');
  }
  // No exception on the other side: 'console' acts, it is never acted upon, so a
  // console here is a corrupt row rather than a known sentinel.
  if (raw.target_user != null && !isUuid(raw.target_user)) {
    errors.push(`${at}: target_user is ${JSON.stringify(raw.target_user)}, which is not a uuid and `
      + 'not null. The column is uuid; no value is coerced, because the subject is the point of the '
      + 'row. There is no console exception here — the console acts, it is not acted upon.');
  }

  // detail, plus the actor label when the actor was the shared token. Merged
  // rather than replaced: `detail` is what the action said about itself and this
  // adds to it, never overwrites it.
  let detail = raw.detail === undefined ? null : raw.detail;
  if (isConsole) {
    if (detail == null) {
      detail = { [ACTOR_LABEL_KEY]: CONSOLE_ACTOR };
    } else if (isPlainObject(detail)) {
      const existing = detail[ACTOR_LABEL_KEY];
      if (existing !== undefined && existing !== CONSOLE_ACTOR) {
        // Overwriting a recorded actor would be the fabrication this whole
        // exception exists to avoid, so it stops instead.
        errors.push(`${at}: admin_id is 'console' but detail.${ACTOR_LABEL_KEY} already says `
          + `${JSON.stringify(existing)}. The label is not overwritten — two claims about who acted `
          + 'is something a person resolves.');
      } else {
        detail = { ...detail, [ACTOR_LABEL_KEY]: CONSOLE_ACTOR };
      }
    } else {
      // jsonb accepts an array or a scalar, and there is no way to add a key to
      // one without reshaping a record. Reshaping an audit row silently is worse
      // than stopping, and json-store only ever writes an object or null here.
      errors.push(`${at}: admin_id is 'console' but detail is ${Array.isArray(detail) ? 'an array' : typeof detail}, `
        + `not an object, so the ${ACTOR_LABEL_KEY} has nowhere to go without reshaping the record. `
        + 'Resolve this row by hand.');
    }
  }

  const created = stamp(raw.created_at);
  if (!created) {
    errors.push(`${at} (action ${JSON.stringify(action || raw.action)}) has no created_at. It is NOT `
      + 'imported with the current time: an audit trail that says every action happened during the '
      + 'migration is worthless. Restore the timestamp in the file, or decide deliberately to drop '
      + 'the row.');
  } else if (!Number.isFinite(Date.parse(created))) {
    errors.push(`${at}: created_at ${JSON.stringify(created)} is not a timestamp anything can parse`);
  }

  const row = errors.length ? null : {
    source_id: raw.id ?? null,               // report only; admin_audit.id is an identity column
    // NULL for the console: an operator with a shared token is not a person, and
    // a minted uuid would look like an answer where there is none.
    admin_id: isUuid(raw.admin_id) ? raw.admin_id : null,
    action,
    target_user: isUuid(raw.target_user) ? raw.target_user : null,
    // `detail` is jsonb and nullable. Carried as it stands — plus the actor
    // label above when there was no named admin — because it is what the
    // action said about itself.
    detail,
    // Report only, like source_id: nothing writes this to a column. It is what
    // lets the plan say how many rows arrived actor-less instead of leaving an
    // operator to find that out from the table later.
    actor_label: isConsole ? CONSOLE_ACTOR : null,
    created_at: created,
  };
  return { row, errors, notes };
}

/** Stable JSON: object keys sorted, recursively. Used ONLY to group identical
 * audit rows. jsonb equality in Postgres ignores key order, so the grouping has
 * to as well, or one row would be planned as two and the reconciliation would
 * report a mismatch that is not there. */
function stableJson(v) {
  if (v === null || v === undefined || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
}

/** The tuple that decides whether two audit rows are the same row. The file's
 * own `id` is deliberately absent: it is a per-file counter, not an identity. */
export function auditGroupKey(row) {
  return stableJson([row.admin_id ?? null, row.action, row.target_user ?? null,
    row.detail ?? null, row.created_at]);
}

/**
 * Group identical audit rows, keeping first-seen order.
 *
 * This is what makes an unkeyed table re-runnable: the insert writes the
 * SHORTFALL per group, so a row already present is skipped and a genuinely
 * repeated action is still written the number of times it happened.
 *
 * @param {Array<Object>} rows
 * @returns {Array<{key: string, row: Object, count: number}>}
 */
export function groupAuditRows(rows) {
  const groups = new Map();
  for (const r of rows ?? []) {
    const key = auditGroupKey(r);
    const g = groups.get(key);
    if (g) g.count += 1;
    else groups.set(key, { key, row: r, count: 1 });
  }
  return [...groups.values()];
}

/**
 * auth/keys.json → `user_keys` rows.
 *
 * The file is `{ userId: { provider: ciphertext } }` — id-keyed, not an array.
 * The ciphertext is AES-256-GCM under KEYS_SECRET (ADR-0005) and this script is
 * the wrong place to understand it: it is copied as a string, byte for byte, and
 * never appears in a log line or an error message. A corrupted blob fails its
 * auth tag and reads as 未配置, which the teacher discovers when a turn fails.
 *
 * @param {Object} parsed
 * @returns {{rows: Array<Object>, errors: Array<string>, notes: Array<string>}}
 */
export function keysToRows(parsed) {
  const errors = [];
  const notes = [];
  const rows = [];
  if (parsed == null) return { rows, errors, notes };
  if (!isPlainObject(parsed)) {
    return { rows, errors: ['not an object keyed by user id (the vault file is `{ userId: { provider: ciphertext } }`)'], notes };
  }

  for (const [userId, providers] of Object.entries(parsed)) {
    if (!isUuid(userId)) {
      errors.push(`${JSON.stringify(userId)} is not a uuid, so the vault entry under it has no `
        + 'account to attach to. Resolve it — a dropped entry logs a teacher out of her own model access.');
      continue;
    }
    if (!isPlainObject(providers)) {
      errors.push(`the vault entry for ${userId} is not an object of provider → ciphertext`);
      continue;
    }
    for (const [provider, blob] of Object.entries(providers)) {
      const name = String(provider ?? '').trim();
      if (!name) { errors.push(`${userId}: a vault entry has no provider name`); continue; }
      if (typeof blob !== 'string' || blob === '') {
        // No value is printed here, and none is guessed at either.
        errors.push(`${userId}/${name}: the stored value is not a non-empty string`);
        continue;
      }
      // Shape check only — a NOTE, never an error. Refusing an unrecognised
      // blob would strand it on disk; flagging it tells the operator that this
      // one teacher will have to re-enter her key whatever we do.
      const parts = blob.split('$');
      if (parts.length !== 4 || parts[0] !== 'v1' || parts.some((p) => !p)) {
        notes.push(`${userId}/${name}: the stored blob is not shaped like a v1 vault ciphertext `
          + '(key-vault.mjs). Carried across verbatim — it is not this script\'s to repair — but it '
          + 'will read as 未配置 and the teacher will have to save her key again.');
      }
      rows.push({ user_id: userId, provider: name, ciphertext: blob });
    }
  }
  // Deterministic order, so the report reads the same way twice.
  rows.sort((a, b) => (a.user_id === b.user_id
    ? a.provider.localeCompare(b.provider)
    : a.user_id.localeCompare(b.user_id)));
  return { rows, errors, notes };
}

/**
 * Everything read from the data directory → one import plan.
 *
 * @param {{users?: Array<Object>, courses?: Array<{file: string, raw: Object}>,
 *          materials?: Array<Object>, audit?: Array<Object>, keys?: Object}} input
 * @returns {Object} the plan; `errors` non-empty means nothing should be written
 */
export function buildPlan(input = {}) {
  const errors = [];
  const notes = [];

  // ---- users ----
  const users = [];
  const userIds = new Set();
  for (const raw of input.users ?? []) {
    const { user, errors: e, notes: n } = userToRow(raw);
    for (const msg of e) errors.push(`users.json: ${msg}`);
    for (const msg of n) notes.push(`users.json: ${msg}`);
    if (!user) continue;
    if (userIds.has(user.id)) { errors.push(`users.json: duplicate user id ${user.id}`); continue; }
    userIds.add(user.id);
    users.push(user);
  }
  // Display names are unique in the table (idx_users_display_name). Two datasets
  // merged into one database is exactly how a collision arrives, and finding out
  // at INSERT time means finding out halfway through.
  const byName = new Map();
  for (const u of users) {
    if (byName.has(u.display_name)) {
      errors.push(`users.json: two accounts share the display name ${JSON.stringify(u.display_name)} `
        + `(${byName.get(u.display_name)} and ${u.id}); display_name is UNIQUE`);
    } else byName.set(u.display_name, u.id);
  }

  // ---- courses ----
  const courses = [];
  const courseIds = new Set();
  const orphanCourses = [];
  for (const { file, raw } of input.courses ?? []) {
    const shaped = courseToRows(raw, { file });
    for (const msg of shaped.errors) errors.push(`${file}: ${msg}`);
    for (const msg of shaped.notes) notes.push(`${file}: ${msg}`);
    if (!shaped.course) continue;
    if (courseIds.has(shaped.course.id)) {
      errors.push(`${file}: course id ${shaped.course.id} appears in more than one file`);
      continue;
    }
    courseIds.add(shaped.course.id);
    if (!userIds.has(shaped.course.user_id)) {
      // Not an error YET: a rerun imports courses whose owner is already in the
      // database. importPlan resolves these against `users` before writing.
      orphanCourses.push({ kind: 'course', file, course_id: shaped.course.id, user_id: shaped.course.user_id });
    }
    courses.push(shaped);
  }

  // ---- materials ----
  const materials = [];
  const materialIds = new Set();
  for (const raw of input.materials ?? []) {
    const { material, errors: e } = materialToRow(raw);
    for (const msg of e) errors.push(`materials.json: ${msg}`);
    if (!material) continue;
    if (materialIds.has(material.id)) { errors.push(`materials.json: duplicate id ${material.id}`); continue; }
    materialIds.add(material.id);
    if (!courseIds.has(material.course_id)) {
      orphanCourses.push({
        kind: 'material', file: 'materials.json',
        course_id: material.course_id, user_id: material.user_id,
      });
    }
    materials.push(material);
  }

  // ---- admin audit ----
  // Sorted by the file's own id first, exactly as messages are: admin_audit.id
  // is an identity column, so insert order is the only thing that carries the
  // reading order of the trail across.
  const audit = [];
  if (input.audit != null && !Array.isArray(input.audit)) {
    errors.push('auth/audit.json: not an array of rows. It holds something, and this script will '
      + 'not report 「0 rows」 for a file that is not empty.');
  }
  const rawAudit = Array.isArray(input.audit) ? input.audit : [];
  const orderedAudit = rawAudit
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const ai = Number(a.r?.id);
      const bi = Number(b.r?.id);
      if (Number.isFinite(ai) && Number.isFinite(bi) && ai !== bi) return ai - bi;
      return a.i - b.i;
    });
  for (const { r, i } of orderedAudit) {
    const { row, errors: e, notes: n } = auditToRow(r, { index: i });
    for (const msg of e) errors.push(`auth/audit.json: ${msg}`);
    for (const msg of n) notes.push(`auth/audit.json: ${msg}`);
    if (row) audit.push(row);
  }
  const auditConsole = audit.filter((r) => r.actor_label === CONSOLE_ACTOR).length;
  if (auditConsole) {
    notes.push(`auth/audit.json: ${auditConsole} row(s) were taken through the shared-token console `
      + `and name no admin account. They import with admin_id NULL and `
      + `${JSON.stringify({ [ACTOR_LABEL_KEY]: CONSOLE_ACTOR })} merged into detail — ADR-0013 §8 `
      + 'records that this path resolves no user, so a uuid here would be invented accountability.');
  }
  const auditGroups = groupAuditRows(audit);
  const repeated = auditGroups.filter((g) => g.count > 1).length;
  if (repeated) {
    notes.push(`auth/audit.json: ${repeated} group(s) of rows are identical in every imported field. `
      + 'They are imported the number of times they appear — the insert writes the shortfall against '
      + 'what the database already holds, so a re-run is still a no-op.');
  }
  // Actors who are in no users.json. NOT an error and NOT dropped: admin_audit
  // carries no foreign key precisely so a row outlives the person it names
  // (005_auth_plane.sql §5). Reported here; importPlan checks the database too
  // before saying anything out loud.
  const auditUnknownUsers = [];
  for (const row of audit) {
    for (const [field, id] of [['admin_id', row.admin_id], ['target_user', row.target_user]]) {
      if (id && !userIds.has(id)) auditUnknownUsers.push({ field, id, action: row.action });
    }
  }

  // ---- key vault ----
  const { rows: keys, errors: keyErrors, notes: keyNotes } = keysToRows(input.keys);
  for (const msg of keyErrors) errors.push(`auth/keys.json: ${msg}`);
  for (const msg of keyNotes) notes.push(`auth/keys.json: ${msg}`);
  for (const k of keys) {
    if (!userIds.has(k.user_id)) {
      // Same treatment as an orphan course: not an error yet, because a re-run
      // legitimately finds the account already in the database. user_keys.user_id
      // IS a foreign key, so importPlan resolves this before writing anything.
      orphanCourses.push({ kind: 'key', file: 'auth/keys.json', user_id: k.user_id, provider: k.provider });
    }
  }

  const counts = {
    users: users.length,
    courses: courses.length,
    messages: courses.reduce((n, c) => n + c.messages.length, 0),
    snapshots: courses.reduce((n, c) => n + c.snapshots.length, 0),
    materials: materials.length,
    audit: audit.length,
    audit_console_actor: auditConsole,
    keys: keys.length,
    subjects_defaulted: courses.reduce((n, c) => n + c.stats.subjects_defaulted, 0),
    plan_husks_dropped: courses.filter((c) => c.stats.plan_dropped).length,
    courses_with_plan: courses.filter((c) => c.stats.has_plan).length,
  };

  return {
    users, courses, materials, audit, auditGroups, auditUnknownUsers, keys,
    orphanCourses, errors, notes, counts,
  };
}

/**
 * Do the three headline counts add up? Pure, so the verification itself is
 * testable without a database — which matters, because this function is the
 * only thing standing between 「the import ran」 and 「the data arrived」.
 *
 * A count absent from all three objects reads as 0 on both sides and balances,
 * which is how a caller that only knows about the original three keys keeps
 * working.
 *
 * @param {{users:number,courses:number,messages:number,audit?:number,keys?:number}} before
 * @param {{users:number,courses:number,messages:number,audit?:number,keys?:number}} after
 * @param {{users:number,courses:number,messages:number,audit?:number,keys?:number}} inserted
 * @returns {{ok: boolean, problems: Array<string>}}
 */
export function verifyTotals(before, after, inserted) {
  const problems = [];
  for (const key of ['users', 'courses', 'messages', 'audit', 'keys']) {
    const expected = (before?.[key] ?? 0) + (inserted?.[key] ?? 0);
    const found = after?.[key] ?? 0;
    if (found !== expected) {
      problems.push(`${key}: expected ${expected} (${before?.[key] ?? 0} before + `
        + `${inserted?.[key] ?? 0} inserted), found ${found}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Per-course reconciliation: the stronger check, and the one that catches a
 * half-import left behind by something other than this script. Aggregate deltas
 * can balance while one course is short and another is long.
 *
 * @param {Array<{file: string, id: string, present: boolean,
 *                messages: number, snapshots: number,
 *                expected_messages: number, expected_snapshots: number}>} rows
 * @returns {{ok: boolean, problems: Array<string>}}
 */
export function verifyCourses(rows) {
  const problems = [];
  for (const r of rows ?? []) {
    if (!r.present) {
      problems.push(`${r.file}: course ${r.id} is not in the database after the import`);
      continue;
    }
    if (r.messages !== r.expected_messages) {
      problems.push(`${r.file}: course ${r.id} holds ${r.messages} messages, the file has ${r.expected_messages}`);
    }
    if (r.snapshots !== r.expected_snapshots) {
      problems.push(`${r.file}: course ${r.id} holds ${r.snapshots} snapshots, the file has ${r.expected_snapshots}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Audit reconciliation: every group of identical rows must be represented in the
 * database at least as many times as the file holds it, with its own timestamp.
 *
 * 「At least」 rather than 「exactly」 because the database may legitimately hold a
 * matching row this import did not write. The no-extras side of the question is
 * the count delta in verifyTotals; this is the did-it-arrive side.
 *
 * `created_at_found` is the timestamp the database actually holds for this
 * action, and is null when there is nothing to report — either the instants
 * agree or the row is not there at all. A non-null value that differs is the
 * 「stamped at import time」 failure and is named before the count is.
 *
 * @param {Array<{action: string, created_at: string, found: number, expected: number,
 *                created_at_found: string|null}>} rows
 * @returns {{ok: boolean, problems: Array<string>}}
 */
export function verifyAudit(rows) {
  const problems = [];
  for (const r of rows ?? []) {
    // The wrong timestamp is checked FIRST, because it is also a shortfall — the
    // row is there and its instant is not — and 「it arrived stamped with the
    // import time」 is the more useful of the two things to be told.
    if (r.created_at_found != null && Date.parse(r.created_at_found) !== Date.parse(r.created_at)) {
      problems.push(`auth/audit.json: the audit row 「${r.action}」 is in the database with `
        + `created_at ${r.created_at_found}, the file says ${r.created_at}. A trail that says `
        + 'every action happened during the migration is worthless.');
      continue;
    }
    if (r.found < r.expected) {
      problems.push(`auth/audit.json: the audit row 「${r.action}」 of ${r.created_at} is in the `
        + `database ${r.found} time(s), the file has it ${r.expected}. An admin action with no `
        + 'record is the thing this trail exists to prevent.');
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Vault reconciliation: every row present, and its ciphertext byte-identical to
 * the file's.
 *
 * NO CIPHERTEXT APPEARS IN A PROBLEM STRING — problems are printed to a console
 * and copied into tickets. A byte-level difference is reported as a difference
 * and nothing more; ADR-0005's whole point is that the value stays where it is.
 *
 * @param {Array<{user_id: string, provider: string, present: boolean,
 *                matches: boolean, inserted: boolean}>} rows
 * @returns {{ok: boolean, problems: Array<string>}}
 */
export function verifyKeys(rows) {
  const problems = [];
  for (const r of rows ?? []) {
    if (!r.present) {
      problems.push(`auth/keys.json: ${r.user_id}/${r.provider} is not in the database after the `
        + 'import. That teacher silently loses her own model access.');
      continue;
    }
    if (r.matches) continue;
    problems.push(r.inserted
      ? `auth/keys.json: ${r.user_id}/${r.provider} was written but does not read back byte for `
        + 'byte. The blob is AES-256-GCM, so a changed byte fails its auth tag and reads as 未配置 '
        + '— the teacher would only find out when a turn fails. (No value is printed here.)'
      : `auth/keys.json: ${r.user_id}/${r.provider} was ALREADY in the database with different `
        + 'ciphertext, so the database\'s value was kept — it is the newer one — and the file\'s was '
        + 'not imported. Decide which one is meant to survive. (No value is printed here.)');
  }
  return { ok: problems.length === 0, problems };
}

// ===========================================================================
// READING THE DATA DIRECTORY — reads only
// ===========================================================================

/**
 * Row files this script does NOT import. Each one is REPORTED when it holds
 * rows, and holding rows is a refusal by default: silently leaving a teacher's
 * memory or an admin audit trail behind on a disk we are about to stop reading
 * is data loss that nobody would notice until it mattered.
 */
export const UNHANDLED_FILES = Object.freeze([
  ['facts.json', 'typed memory facts (ADR-0011). Pre-v2 data has none. If this has rows, extend the importer — do not lose a teacher\'s memory.'],
  ['classes.json', 'named classes (ADR-0011 §3). A class outlives a course, so losing one loses 「班上没有鼓」 for every future course.'],
  ['interaction-signals.json', 'the observations behind the interaction axes (ADR-0009 §3).'],
  ['auth/scope-log.json', 'scope-shell verdicts (ADR-0012 §3). Warn-only mode is only worth running if these rows survive to be read.'],
]);
// auth/audit.json and auth/keys.json used to be on that list. They are imported
// now — see 「THE AUDIT TRAIL AND THE KEY VAULT」 in the header — so they are not
// unhandled and must not make the script refuse.

/**
 * Files deliberately left behind, with the reason stated rather than assumed.
 */
export const SKIPPED_FILES = Object.freeze([
  ['auth/sessions.json', 'live bearer tokens. Everyone logs in again; carrying sessions across a storage swap hands out credentials minted under the old one.'],
  ['auth/rate-limits.json', 'a counter blob keyed by identifier, with its own expiry window. It rebuilds itself.'],
]);

/** Rows in a file that may be an array or an id-keyed object (keys.json). */
function rowCount(parsed) {
  if (Array.isArray(parsed)) return parsed.length;
  if (isPlainObject(parsed)) return Object.keys(parsed).length;
  return 0;
}

/**
 * Read one JSON file. A missing file is `fallback`; a CORRUPT file is an error,
 * never a silent fallback — 「the file would not parse」 and 「the file is not
 * there」 are different facts and only one of them is fine.
 */
async function readJson(file, fallback) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return { value: fallback, missing: true };
    throw e;
  }
  try {
    return { value: JSON.parse(text), missing: false };
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${e.message}`);
  }
}

/**
 * Read a `.data` directory. Opens files; writes nothing, creates nothing.
 *
 * @param {string} baseDir
 * @returns {Promise<{users: Array<Object>, courses: Array<{file: string, raw: Object}>,
 *                    materials: Array<Object>, unhandled: Array<{file: string, rows: number, why: string}>,
 *                    skipped: Array<{file: string, rows: number, why: string}>}>}
 */
export async function readDataDir(baseDir) {
  const courseDir = path.join(baseDir, 'courses');
  let files = [];
  try {
    files = (await readdir(courseDir)).filter((f) => f.endsWith('.json')).sort();
  } catch (e) {
    if (e?.code !== 'ENOENT') throw e;
  }

  const courses = [];
  for (const f of files) {
    const { value } = await readJson(path.join(courseDir, f), null);
    if (value == null) continue;
    courses.push({ file: `courses/${f}`, raw: value });
  }

  const { value: users } = await readJson(path.join(baseDir, 'auth', 'users.json'), []);
  const { value: materials } = await readJson(path.join(baseDir, 'materials.json'), []);
  const { value: audit } = await readJson(path.join(baseDir, 'auth', 'audit.json'), []);
  // The vault file is keyed by user id, not an array — `{}` is its empty shape.
  const { value: keys } = await readJson(path.join(baseDir, 'auth', 'keys.json'), {});

  const unhandled = [];
  for (const [rel, why] of UNHANDLED_FILES) {
    const { value, missing } = await readJson(path.join(baseDir, rel), null);
    if (missing) continue;
    const rows = rowCount(value);
    if (rows > 0) unhandled.push({ file: rel, rows, why });
  }
  const skipped = [];
  for (const [rel, why] of SKIPPED_FILES) {
    const { value, missing } = await readJson(path.join(baseDir, rel), null);
    if (missing) continue;
    skipped.push({ file: rel, rows: rowCount(value), why });
  }

  return {
    users: Array.isArray(users) ? users : [],
    courses,
    materials: Array.isArray(materials) ? materials : [],
    // Shape problems are NOT silently normalized away here: a non-array audit
    // file or a non-object vault file reaches buildPlan, which names it. Turning
    // either into an empty collection would report 「0 rows」 for a file that has
    // rows in it, which is the one lie this script cannot afford.
    audit,
    keys,
    unhandled,
    skipped,
  };
}

// ===========================================================================
// INSERTION — everything below the database line
// ===========================================================================

/** Columns this script writes that migrations 001–004 do not create. Named up
 * front so a missing auth-plane migration is one clear message instead of a
 * 42703 halfway through the users. */
const REQUIRED_COLUMNS = Object.freeze([
  ['users', 'username'], ['users', 'password_hash'], ['users', 'must_change_password'],
  ['users', 'display_name_changed_at'], ['users', 'created_by'], ['users', 'revoked_at'],
  ['courses', 'title_locked'], ['courses', 'workbench'],
  ['messages', 'subject'], ['messages', 'provider_label'], ['messages', 'stage_name'],
  ['messages', 'cache'], ['messages', 'guards'],
  // Both tables arrive with 005 too. A database without it has no `admin_audit`
  // at all, and a missing TABLE shows up here as all of its columns missing —
  // one message naming the migration, rather than a 42P01 after the users are in.
  ['admin_audit', 'admin_id'], ['admin_audit', 'action'], ['admin_audit', 'target_user'],
  ['admin_audit', 'detail'], ['admin_audit', 'created_at'],
  ['user_keys', 'user_id'], ['user_keys', 'provider'], ['user_keys', 'ciphertext'],
]);

/** The tuple that identifies an audit row, as SQL. IS NOT DISTINCT FROM, not `=`:
 * `admin_id`, `target_user` and `detail` are all nullable, and `NULL = NULL` is
 * NULL — which would make every row with a null actor look absent and insert a
 * duplicate on every run. Bind order matches auditParams(). */
const AUDIT_MATCH = `admin_id    IS NOT DISTINCT FROM $1::uuid
                 AND action      = $2::text
                 AND target_user IS NOT DISTINCT FROM $3::uuid
                 AND detail      IS NOT DISTINCT FROM $4::jsonb
                 AND created_at  = $5::timestamptz`;

const auditParams = (r) => [r.admin_id, r.action, r.target_user, jsonb(r.detail), r.created_at];

/** In-memory identity of one vault row, used to remember which rows THIS run
 * wrote. One helper, called from both sides: two spellings of the same key would
 * silently never match, and the reconciliation would then blame the file for a
 * row it had just written itself. */
const keyIdentity = (r) => `${r.user_id}:${r.provider}`;

/**
 * May this connection write rows belonging to other people?
 *
 * Three ways it can, and one very quiet way it cannot: as `app_owner`, FORCE
 * ROW LEVEL SECURITY applies to the owner and the two aggregate policies are
 * read-only, so a data migration matches nothing and reports success
 * (demo/migrations/README.md, 「Operating notes」). That silence is the whole
 * reason this check exists.
 *
 * Pure catalog reads — `pg_has_role` would raise on a database where the roles
 * were never created, which is the normal single-role development case.
 */
async function checkRole(client) {
  const { rows } = await client.query(`
    SELECT current_user AS role,
           r.rolsuper     AS is_super,
           r.rolbypassrls AS bypasses_rls,
           EXISTS (SELECT 1 FROM pg_roles a
                     JOIN pg_auth_members m ON m.roleid = a.oid
                    WHERE a.rolname = 'app_admin' AND m.member = r.oid) AS member_of_app_admin
      FROM pg_roles r
     WHERE r.rolname = current_user`);
  const r = rows[0] ?? {};
  const ok = Boolean(r.is_super || r.bypasses_rls || r.role === 'app_admin' || r.member_of_app_admin);
  return { ...r, ok };
}

async function missingColumns(client) {
  // ::text on both sides: information_schema columns are the `sql_identifier`
  // domain over `name`, and leaving the comparison to implicit resolution is how
  // a preflight check turns into the error it exists to prevent.
  const { rows } = await client.query(
    `SELECT table_name::text AS table_name, column_name::text AS column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name::text = ANY($1::text[])`,
    [[...new Set(REQUIRED_COLUMNS.map(([t]) => t))]],
  );
  const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
  return REQUIRED_COLUMNS.filter(([t, c]) => !have.has(`${t}.${c}`)).map(([t, c]) => `${t}.${c}`);
}

async function counts(client) {
  const { rows } = await client.query(`
    SELECT (SELECT count(*) FROM users)       AS users,
           (SELECT count(*) FROM courses)     AS courses,
           (SELECT count(*) FROM messages)    AS messages,
           (SELECT count(*) FROM admin_audit) AS audit_rows,
           (SELECT count(*) FROM user_keys)   AS key_rows`);
  // count(*) is bigint and arrives as a string from node-postgres, which keeps
  // int8 exact. '10' > '9' is false, so every one crosses into JS as a number.
  return {
    users: Number(rows[0].users),
    courses: Number(rows[0].courses),
    messages: Number(rows[0].messages),
    audit: Number(rows[0].audit_rows),
    keys: Number(rows[0].key_rows),
  };
}

/**
 * Write the plan to PostgreSQL, then prove it arrived.
 *
 * @param {ReturnType<typeof buildPlan>} plan
 * @param {{connectionString: string, dryRun?: boolean, log?: (s: string) => void}} opts
 * @returns {Promise<{ok: boolean, before: Object, after: Object|null, inserted: Object,
 *                    skipped: Object, problems: Array<string>, reconciled: Array<Object>}>}
 */
export async function importPlan(plan, opts) {
  const log = opts.log ?? ((s) => process.stdout.write(`${s}\n`));
  const dryRun = Boolean(opts.dryRun);
  const problems = [];

  // Dynamic, for the same reason store.mjs loads pg-store dynamically: `pg` is
  // this repository's only dependency (ADR-0013) and belongs to the server tier.
  // A static import would make the pure transform — and its tests — unloadable
  // on a machine that has not installed it.
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: opts.connectionString });
  await client.connect();

  const inserted = { users: 0, courses: 0, messages: 0, snapshots: 0, materials: 0, audit: 0, keys: 0 };
  const skipped = { users: 0, courses: 0, materials: 0, audit: 0, keys: 0 };
  const reconciled = [];
  const reconciledAudit = [];
  const reconciledKeys = [];
  let before = null;
  let after = null;
  const fail = () => ({
    ok: false, before, after: null, inserted, skipped, problems, reconciled,
    reconciledAudit, reconciledKeys,
  });

  try {
    const role = await checkRole(client);
    log(`connected as ${role.role} (superuser=${role.is_super}, bypassrls=${role.bypasses_rls})`);
    if (!role.ok) {
      problems.push(`${role.role} may not write rows belonging to other teachers. Run this as `
        + '`postgres` or as `app_admin` — as app_owner or app_rw the writes are refused or match '
        + 'nothing at all (demo/migrations/README.md, Operating notes).');
      return fail();
    }

    const missing = await missingColumns(client);
    if (missing.length) {
      problems.push(`the database is missing columns this script writes: ${missing.join(', ')}. `
        + 'Apply the auth-plane migration described under REQUIRED SCHEMA in '
        + 'demo/src/store/pg-store.mjs before importing.');
      return fail();
    }

    before = await counts(client);
    log(`before: ${before.users} users, ${before.courses} courses, ${before.messages} messages`);

    // Orphan owners: a course whose user is neither in users.json nor already in
    // the database. courses.user_id is NOT NULL REFERENCES users(id), so this
    // would fail at INSERT — resolved here so it fails BEFORE anything is
    // written rather than partway through.
    if (plan.orphanCourses.length) {
      const wanted = [...new Set(plan.orphanCourses.map((o) => o.user_id).filter(isUuid))];
      const { rows } = await client.query('SELECT id FROM users WHERE id = ANY($1::uuid[])', [wanted]);
      const known = new Set(rows.map((r) => r.id));
      const { rows: courseRows } = await client.query(
        'SELECT id FROM courses WHERE id = ANY($1::uuid[])',
        [[...new Set(plan.orphanCourses.map((o) => o.course_id).filter(isUuid))]],
      );
      const knownCourses = new Set(courseRows.map((r) => r.id));
      for (const o of plan.orphanCourses) {
        if (o.kind === 'material') {
          if (!knownCourses.has(o.course_id)) {
            problems.push(`materials.json: a material points at course ${o.course_id}, which is in `
              + 'neither the files nor the database. Its cos_key is the only handle on the stored '
              + 'object (ADR-0013 §6) — resolve it, do not drop it.');
          }
          continue;
        }
        if (o.kind === 'key') {
          // user_keys.user_id IS a foreign key, so this would fail at INSERT.
          // Named here instead, before anything is written — and NOT dropped:
          // an entry left behind is a teacher who quietly loses her model access.
          if (!known.has(o.user_id)) {
            problems.push(`auth/keys.json: the vault holds a ${o.provider} key for user ${o.user_id}, `
              + 'who is in neither auth/users.json nor the database. user_keys.user_id references '
              + 'users(id), so the ciphertext cannot travel without its account — restore the account '
              + 'or decide deliberately to drop the key. Do not lose it silently.');
          }
          continue;
        }
        if (!known.has(o.user_id)) {
          problems.push(`${o.file}: course ${o.course_id} belongs to user ${o.user_id}, who is in `
            + 'neither auth/users.json nor the database');
        }
      }
    }
    // Audit actors who are in neither the files nor the database. NOT a problem
    // and NOT a reason to drop the row: admin_audit carries no foreign key so
    // that a row outlives the person it names (005_auth_plane.sql §5). Said out
    // loud, because 「an id in the trail that resolves to nobody」 is something an
    // operator should learn here rather than from a console screen later.
    if (plan.auditUnknownUsers?.length) {
      const wanted = [...new Set(plan.auditUnknownUsers.map((a) => a.id))];
      const { rows } = await client.query('SELECT id FROM users WHERE id = ANY($1::uuid[])', [wanted]);
      const known = new Set(rows.map((r) => r.id));
      const unknown = plan.auditUnknownUsers.filter((a) => !known.has(a.id));
      if (unknown.length) {
        log(`note: ${unknown.length} audit reference(s) name a user who is in neither `
          + 'auth/users.json nor the database (an erased admin, most likely). Imported unchanged — '
          + 'admin_audit has no foreign key precisely so accountability outlives the person:');
        for (const a of unknown.slice(0, 10)) log(`  ${a.field} ${a.id} (action ${a.action})`);
        if (unknown.length > 10) log(`  … and ${unknown.length - 10} more`);
      }
    }

    if (problems.length) {
      return fail();
    }

    if (dryRun) {
      log('--dry-run: nothing was written.');
      return {
        ok: true, before, after: null, inserted, skipped, problems, reconciled,
        reconciledAudit, reconciledKeys, dryRun: true,
      };
    }

    // ---- users, one transaction ----
    const insertedUserIds = [];
    await client.query('BEGIN');
    try {
      for (const u of plan.users) {
        const r = await client.query(
          `INSERT INTO users (id, username, display_name, password_hash, role, status, revoked_at,
                              must_change_password, display_name_changed_at, settings,
                              created_at, last_login_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9::timestamptz, $10::jsonb,
                   coalesce($11::timestamptz, now()), $12::timestamptz)
           ON CONFLICT (id) DO NOTHING`,
          [
            u.id, u.username, u.display_name, u.password_hash, u.role, u.status, u.revoked_at,
            u.must_change_password, u.display_name_changed_at, jsonb(u.settings),
            u.created_at, u.last_login_at,
          ],
        );
        if (r.rowCount > 0) { inserted.users += 1; insertedUserIds.push(u.id); }
        else skipped.users += 1;
      }
      // created_by in a second pass: it references users(id), and the admin who
      // provisioned an account has no guaranteed order relative to it. Applied
      // ONLY to rows this run inserted — a row that was already there is not
      // ours to edit.
      for (const u of plan.users) {
        if (!u.created_by || !insertedUserIds.includes(u.id)) continue;
        const r = await client.query(
          `UPDATE users SET created_by = $2 WHERE id = $1
            AND EXISTS (SELECT 1 FROM users WHERE id = $2)`,
          [u.id, u.created_by],
        );
        if (r.rowCount === 0) {
          log(`note: user ${u.id} was created by ${u.created_by}, who is not in the database; `
            + 'created_by left NULL rather than pointing at nobody');
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      // The transaction is gone, so the counters must go with it — a report
      // claiming inserts that were rolled back is worse than no report.
      inserted.users = 0;
      skipped.users = 0;
      // 23505 = unique_violation. `ON CONFLICT (id)` catches the same row
      // arriving twice; it does NOT catch a DIFFERENT id holding the same
      // username or display_name, and two datasets merged into one database —
      // 24 courses from public, 9 from dev — is exactly how that arrives. Named
      // here, because the raw message points at a constraint rather than at the
      // two accounts a person has to reconcile.
      if (e?.code === '23505') {
        problems.push('users: a unique constraint rejected the batch and no user was imported '
          + `(${e.detail ?? e.message}). Reconcile the colliding accounts in the files, then re-run.`);
        return fail();
      }
      throw e;
    }

    // ---- admin audit, one transaction ----
    // AFTER users, though admin_audit references none of them: the trail reads
    // in insert order, and a half-written trail is a trail with a hole in it, so
    // all of it lands or none of it does.
    const auditGroups = plan.auditGroups ?? groupAuditRows(plan.audit ?? []);
    if (auditGroups.length) {
      await client.query('BEGIN');
      try {
        for (const g of auditGroups) {
          const params = auditParams(g.row);
          // One scan per group, and admin_audit carries no index for this
          // predicate. That is fine at the size this runs against (tens of rows,
          // once) and would not be at a hundred thousand — if this script is ever
          // pointed at a large trail, index it first rather than waiting.
          const { rows } = await client.query(
            `SELECT count(*)::int AS n FROM admin_audit WHERE ${AUDIT_MATCH}`, params,
          );
          const present = rows[0].n;
          // The SHORTFALL, and only the shortfall. Present >= count is a re-run
          // (or a row the live server already wrote) and writes nothing.
          for (let i = present; i < g.count; i += 1) {
            await client.query(
              `INSERT INTO admin_audit (admin_id, action, target_user, detail, created_at)
               VALUES ($1::uuid, $2::text, $3::uuid, $4::jsonb, $5::timestamptz)`,
              // created_at is BOUND, never defaulted: this row's own instant is
              // the thing being preserved.
              params,
            );
            inserted.audit += 1;
          }
          skipped.audit += Math.min(present, g.count);
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        inserted.audit = 0;
        skipped.audit = 0;
        problems.push(`auth/audit.json: ${e.message}`);
      }
    }

    // ---- key vault, one transaction ----
    // AFTER users: user_keys.user_id references users(id). The ciphertext is
    // bound as a string and never inspected, never trimmed, never logged.
    const keysWritten = new Set();
    if (plan.keys?.length) {
      await client.query('BEGIN');
      try {
        for (const k of plan.keys) {
          const r = await client.query(
            `INSERT INTO user_keys (user_id, provider, ciphertext)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, provider) DO NOTHING`,
            // updated_at takes its DEFAULT now(): the JSON vault records no
            // timestamp, and inventing one would be a claim about when a teacher
            // saved her key. DO NOTHING, not DO UPDATE — see the header.
            [k.user_id, k.provider, k.ciphertext],
          );
          if (r.rowCount > 0) { inserted.keys += 1; keysWritten.add(keyIdentity(k)); }
          else skipped.keys += 1;
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        inserted.keys = 0;
        skipped.keys = 0;
        keysWritten.clear();
        // e.message on a user_keys failure can carry the row's values in the
        // detail, which is the ciphertext. Only the code and the constraint are
        // repeated here.
        problems.push('auth/keys.json: the vault batch failed and no key was imported '
          + `(SQLSTATE ${e.code ?? 'unknown'}${e.constraint ? `, constraint ${e.constraint}` : ''}). `
          + 'The message is withheld on purpose — it can quote the ciphertext.');
      }
    }

    // ---- courses, ONE TRANSACTION EACH ----
    // Per course rather than one transaction over all of them: a course row and
    // its messages and snapshots must arrive together or not at all — half a
    // course is invisible damage — but one bad course must not roll back the
    // twenty-three good ones. This is also what makes the run idempotent: the
    // course row is the key, so if it is present the whole course is present.
    for (const c of plan.courses) {
      // Counters are snapshotted with the transaction. A ROLLBACK that left them
      // incremented would make verifyTotals report a phantom shortfall on top of
      // the real error, and a report that says two things went wrong when one
      // did is a report nobody trusts.
      const mark = { courses: inserted.courses, messages: inserted.messages, snapshots: inserted.snapshots };
      await client.query('BEGIN');
      try {
        const r = await client.query(
          `INSERT INTO courses (id, user_id, class_id, title, course_state, state_version,
                                title_locked, workbench, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb,
                   coalesce($9::timestamptz, now()), coalesce($10::timestamptz, now()))
           ON CONFLICT (id) DO NOTHING`,
          [
            c.course.id, c.course.user_id, c.course.class_id, c.course.title,
            jsonb(c.course.course_state), c.course.state_version,
            c.course.title_locked, jsonb(c.course.workbench),
            c.course.created_at, c.course.updated_at,
          ],
        );
        if (r.rowCount === 0) {
          // Already imported. Its messages and snapshots came with it in this
          // same transaction on the earlier run, so re-inserting them would
          // duplicate every turn. The reconciliation below proves that claim
          // instead of assuming it.
          await client.query('COMMIT');
          skipped.courses += 1;
          continue;
        }
        inserted.courses += 1;

        for (const m of c.messages) {
          // messages.user_id is the COURSE OWNER for every row, agent and system
          // included. The JSON tier never stored one, and the owner is the only
          // value that is not a guess — it is also exactly what pg-store's
          // appendMessage writes, so imported turns and new turns agree.
          await client.query(
            `INSERT INTO messages (course_id, user_id, role, subject, content, turn_contract,
                                   provider, provider_label, usage, stage_name, cache, guards,
                                   created_at)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10, $11::jsonb, $12::jsonb,
                     coalesce($13::timestamptz, now()))`,
            [
              c.course.id, c.course.user_id, m.role, m.subject, m.content, jsonb(m.turn_contract),
              m.provider, m.provider_label, jsonb(m.usage), m.stage_name, jsonb(m.cache),
              jsonb(m.guards), m.created_at,
            ],
          );
          inserted.messages += 1;
        }

        for (const s of c.snapshots) {
          await client.query(
            `INSERT INTO course_snapshots (course_id, state_version, state_delta, course_state,
                                           is_checkpoint, message_id, created_at)
             VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, NULL, coalesce($6::timestamptz, now()))`,
            // message_id stays NULL: the JSON tier never recorded which turn
            // proposed a snapshot, and inventing the link would put a fabricated
            // row in the trail that evidence claims resolve against.
            [c.course.id, s.state_version, jsonb(s.state_delta), jsonb(s.course_state),
              s.is_checkpoint, s.created_at],
          );
          inserted.snapshots += 1;
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        Object.assign(inserted, mark);
        problems.push(`${c.file}: ${e.message}`);
      }
    }

    // ---- materials ----
    for (const m of plan.materials) {
      try {
        const r = await client.query(
          `INSERT INTO materials (id, course_id, user_id, kind, cos_key, mime_type, size_bytes,
                                  exif_stripped, contains_children, retention_until, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, coalesce($11::timestamptz, now()))
           ON CONFLICT (id) DO NOTHING`,
          [
            m.id, m.course_id, m.user_id, m.kind, m.cos_key, m.mime_type, m.size_bytes,
            m.exif_stripped, m.contains_children, m.retention_until, m.created_at,
          ],
        );
        if (r.rowCount > 0) inserted.materials += 1; else skipped.materials += 1;
      } catch (e) {
        problems.push(`materials.json: ${m.id}: ${e.message}`);
      }
    }

    // ---- verify ----
    after = await counts(client);
    log(`after:  ${after.users} users, ${after.courses} courses, ${after.messages} messages`);

    const totals = verifyTotals(before, after, inserted);
    problems.push(...totals.problems);

    for (const c of plan.courses) {
      const { rows } = await client.query(
        `SELECT EXISTS (SELECT 1 FROM courses WHERE id = $1) AS present,
                (SELECT count(*) FROM messages         WHERE course_id = $1) AS messages,
                (SELECT count(*) FROM course_snapshots WHERE course_id = $1) AS snapshots`,
        [c.course.id],
      );
      reconciled.push({
        file: c.file,
        id: c.course.id,
        present: rows[0].present,
        messages: Number(rows[0].messages),
        snapshots: Number(rows[0].snapshots),
        expected_messages: c.messages.length,
        expected_snapshots: c.snapshots.length,
      });
    }
    const perCourse = verifyCourses(reconciled);
    problems.push(...perCourse.problems);

    // Audit: every group re-counted, and the row's own timestamp read back.
    //
    // DELIBERATELY NOT the insert's predicate. AUDIT_MATCH pins created_at, so
    // asking it 「is this row here with this timestamp」 and then checking the
    // timestamp it returned would be a tautology — a row stamped with the import
    // time would simply not match, and would be reported as missing rather than
    // as what it is. So the match here drops created_at and counts both ways:
    // n_exact is how many carry the file's own instant, n_any how many are that
    // action at all. n_any > n_exact is exactly 「it arrived with the wrong
    // timestamp」, and `latest` is the timestamp to show a person.
    for (const g of auditGroups) {
      const params = auditParams(g.row);
      const { rows } = await client.query(
        `SELECT count(*) FILTER (WHERE created_at = $5::timestamptz)::int AS n_exact,
                count(*)::int AS n_any,
                max(created_at) AS latest
           FROM admin_audit
          WHERE admin_id    IS NOT DISTINCT FROM $1::uuid
            AND action      = $2::text
            AND target_user IS NOT DISTINCT FROM $3::uuid
            AND detail      IS NOT DISTINCT FROM $4::jsonb`, params,
      );
      const { n_exact: exact, n_any: any, latest } = rows[0];
      reconciledAudit.push({
        action: g.row.action,
        created_at: g.row.created_at,
        // Only reported when it disagrees; when the instants match there is
        // nothing to say and nothing to print.
        created_at_found: exact < g.count && any > 0 && latest
          ? new Date(latest).toISOString()
          : null,
        found: exact,
        expected: g.count,
      });
    }
    problems.push(...verifyAudit(reconciledAudit).problems);

    // Vault: the round trip, byte for byte. This is the only check that would
    // catch a blob that arrived truncated or re-encoded, and a truncated blob
    // fails its GCM tag — which the teacher discovers when a turn fails.
    for (const k of plan.keys ?? []) {
      const { rows } = await client.query(
        'SELECT ciphertext FROM user_keys WHERE user_id = $1 AND provider = $2',
        [k.user_id, k.provider],
      );
      reconciledKeys.push({
        user_id: k.user_id,
        provider: k.provider,
        present: rows.length > 0,
        // Compared, never printed, never returned.
        matches: rows.length > 0 && rows[0].ciphertext === k.ciphertext,
        inserted: keysWritten.has(keyIdentity(k)),
      });
    }
    problems.push(...verifyKeys(reconciledKeys).problems);
  } finally {
    await client.end().catch(() => {});
  }

  return {
    ok: problems.length === 0, before, after, inserted, skipped, problems,
    reconciled, reconciledAudit, reconciledKeys,
  };
}

// ===========================================================================
// CLI
// ===========================================================================

function parseArgs(argv) {
  const out = { dataDir: DEFAULT_DATA_DIR, dryRun: false, allowUnimported: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--allow-unimported') out.allowUnimported = true;
    else if (a === '--data') { out.dataDir = argv[i + 1]; i += 1; }
    else if (a.startsWith('--data=')) out.dataDir = a.slice('--data='.length);
    else if (a === '--help' || a === '-h') out.help = true;
    else out.unknown = a;
  }
  return out;
}

const USAGE = `usage: node demo/scripts/import-json-to-pg.mjs [--data <dir>] [--dry-run] [--allow-unimported]

  --data <dir>          the .data directory to read (default: demo/.data)
  --dry-run             read, plan and check, write nothing
  --allow-unimported    proceed even though row files this script does not
                        handle hold rows. An explicit operator decision to
                        leave them behind — never a default.

Connection: DATABASE_URL_ADMIN if set, otherwise DATABASE_URL. POINT IT AT
\`postgres\`, and at nothing else. app_admin is a read-plus-erase role: it holds
SELECT and DELETE everywhere but INSERT only on users and scope_log, so the
INSERTs below fail with 42501 permission denied (demo/migrations/002_roles.sql
§5 says so explicitly). app_rw is under row-level security and cannot write
across teachers; app_owner cannot log in at all.

Widening app_admin to cover a script that runs once would leave the widening
behind forever, which is why this asks for the superuser instead.

Stop the service first — the count-before/count-after check assumes nothing
else is writing.`;

async function main(argv) {
  const args = parseArgs(argv);
  const out = (s) => process.stdout.write(`${s}\n`);
  if (args.help) { out(USAGE); return 0; }
  if (args.unknown) { process.stderr.write(`unknown option ${args.unknown}\n${USAGE}\n`); return 2; }

  // DATABASE_URL_ADMIN first only because it is the 「elevated」 variable an
  // operator already has to hand; the ROLE it should carry for this run is
  // `postgres`, not app_admin. app_admin holds no INSERT on courses, messages,
  // course_snapshots or materials (002_roles.sql §5 lists that absence and why),
  // so an app_admin URL here fails at the first write with 42501 rather than
  // importing anything half-way.
  const url = process.env.DATABASE_URL_ADMIN || process.env.DATABASE_URL;
  if (!url && !args.dryRun) {
    process.stderr.write('no DATABASE_URL (or DATABASE_URL_ADMIN) set.\n');
    return 2;
  }

  out(`reading ${args.dataDir} (read-only: this script never writes to it)`);
  const raw = await readDataDir(args.dataDir);
  out(`found ${raw.courses.length} course files, ${raw.users.length} users, ${raw.materials.length} materials, `
    + `${Array.isArray(raw.audit) ? raw.audit.length : '?'} audit rows, `
    + `${rowCount(raw.keys)} account(s) in the key vault (counts only — no key value is `
    + 'printed or logged anywhere in this run)');

  for (const s of raw.skipped) {
    out(`skipped ${s.file} (${s.rows} rows): ${s.why}`);
  }

  const plan = buildPlan(raw);
  out('');
  out('plan:');
  for (const [k, v] of Object.entries(plan.counts)) out(`  ${k}: ${v}`);
  out(`  (subjects_defaulted = messages imported as '${COURSE_SUBJECT}' because they predate subjects)`);
  out(`  (audit_console_actor = rows taken through the shared-token console: admin_id NULL, `
    + `${ACTOR_LABEL_KEY} '${CONSOLE_ACTOR}' in detail — no named admin existed to record)`);
  for (const n of plan.notes) out(`  note: ${n}`);

  if (raw.unhandled.length) {
    out('');
    out('NOT IMPORTED BY THIS SCRIPT, and holding rows:');
    for (const u of raw.unhandled) out(`  ${u.file} (${u.rows} rows): ${u.why}`);
    if (!args.allowUnimported) {
      process.stderr.write('\nrefusing: leaving these behind silently is data loss nobody would '
        + 'notice. Extend the importer, or re-run with --allow-unimported to decide deliberately.\n');
      return 1;
    }
    out('  --allow-unimported: proceeding, and these rows stay on disk.');
  }

  if (plan.errors.length) {
    process.stderr.write('\nrefusing: the files do not map cleanly.\n');
    for (const e of plan.errors) process.stderr.write(`  ${e}\n`);
    return 1;
  }

  if (!url) { out('\n--dry-run without a database URL: the transform is clean. Nothing checked against Postgres.'); return 0; }

  out('');
  const report = await importPlan(plan, { connectionString: url, dryRun: args.dryRun, log: out });

  out('');
  out(`inserted: ${JSON.stringify(report.inserted)}`);
  out(`already present (skipped): ${JSON.stringify(report.skipped)}`);
  if (report.reconciledKeys?.length) {
    const matched = report.reconciledKeys.filter((k) => k.present && k.matches).length;
    out(`vault round trip: ${matched}/${report.reconciledKeys.length} rows read back byte for byte`);
  }
  if (report.reconciledAudit?.length) {
    const kept = report.reconciledAudit.filter(
      (a) => a.found >= a.expected
        && (a.created_at_found == null || Date.parse(a.created_at_found) === Date.parse(a.created_at)),
    ).length;
    out(`audit trail: ${kept}/${report.reconciledAudit.length} row groups present with their own timestamp`);
  }

  if (!report.ok) {
    process.stderr.write('\nIMPORT NOT VERIFIED. Do not treat this as done.\n');
    for (const p of report.problems) process.stderr.write(`  ${p}\n`);
    return 1;
  }
  out(report.dryRun
    ? '\ndry run clean: the plan maps, the role can write, the schema has the columns.'
    : '\nverified: counts agree, every course reconciles row for row, every audit row kept its own '
      + 'timestamp, and every vault ciphertext reads back byte for byte.');
  out('The JSON files are untouched. Keep them until a restore has actually been drilled.');
  return 0;
}

// Only when run directly, so importing this module in a test runs nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exitCode = 1; });
}
