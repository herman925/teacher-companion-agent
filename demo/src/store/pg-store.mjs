// pg-store.mjs — PostgreSQL implementation of the demo persistence tier.
//
// Same interface as json-store.mjs (see store.mjs for the list, and
// demo/tests/store-contract.test.mjs for the executable specification). The
// tables are demo/migrations/001–005.
//
// ============================================================================
// THE TWO PLANES — read this before adding a method
// ============================================================================
// Every call in this file belongs to exactly one of two planes, and which one
// it is decides how it reaches the database:
//
//   TEACHER-DATA PLANE — courses, course_snapshots, messages, materials,
//     facts, classes, interaction_signals, scope_log. Reached through
//     `asUser(userId, …)`, which opens a transaction and names the teacher
//     inside it, so 003_rls.sql's policies apply. Row-level security is the
//     guarantee; the explicit `WHERE user_id = $1` that most of these queries
//     also carry is the habit DATABASE.md §1.4 keeps on top of it.
//
//   AUTH PLANE — users, sessions, admin_audit, user_keys, app_state. Reached
//     through the admin connection. This is not laziness: 003_rls.sql records
//     the reason as a known gap — resolving a teacher by username happens
//     BEFORE `app.user_id` can be set, because you cannot name the user you are
//     still identifying, so under `users_self` the lookup returns zero rows and
//     login fails closed. 003 lists two candidate fixes; this file takes
//     option (b), 「the authentication path uses its own connection as
//     app_admin」. 003 required that choice to be written down before it was
//     coded: it now is, in DATABASE.md §2c and in 005_auth_plane.sql §9, which
//     grants those four tables to app_admin and to nobody else.
//
// The admin plane also carries the admin console (adminListCourses,
// adminGetCourse, adminDelete, adminExportAll) and erasure, which are
// deliberate cross-teacher bypasses under ADR-0013 §7 with the access log as
// the compensating control. A bypass is never reached by FORGETTING to name a
// user — that path returns zero rows and would merely look like a bug.
//
// ONE deliberate exception, `ownerOf()`: appendMessage / getMessages /
// saveState / isUntitled take a course id and no user (that is the facade's
// signature, and serve.mjs calls them from a request that has already
// authenticated). Resolving the owner is a single-column admin read; the work
// itself then runs under RLS as that owner. See ownerOf for why this is not
// simply 「run it as admin」.
//
// ============================================================================
// REQUIRED SCHEMA — 005_auth_plane.sql
// ============================================================================
// 001_schema.sql transcribes DATABASE.md §2 and stops there; its own header
// says §4's account/session build spec 「belong[s] to a later numbered
// migration」. This store needs that migration, and it now exists:
// demo/migrations/005_auth_plane.sql adds the account columns, the four
// auth-plane tables (sessions, admin_audit, user_keys, app_state) and the
// migration ledger 001's header said the fifth file would trigger.
//
// Nothing here creates a table. The application connects as app_rw/app_admin,
// neither of which owns the schema, and a store that quietly runs DDL is a
// store that can quietly get the DDL wrong. WORSE THAN WRONG: a table
// hand-created on the box during an outage is owned by `postgres`, has no
// ENABLE, no FORCE, no policy and no grant, and is indistinguishable from a
// correct one in \dt — which is exactly the silently disabled row-level
// security 002 and 003 exist to prevent, on the two tables that hold bearer
// tokens and vault ciphertext. `assertHealthy` below refuses to start against
// such a database rather than serving from it.
//
// ============================================================================
// WHAT WAS NOT VERIFIED
// ============================================================================
// This file was written on a machine with no PostgreSQL. Every statement here
// is reasoned from the migrations and the pg documentation; none has been
// executed. The contract suite (store-contract-pg.test.mjs) is the proof, and
// it skips without DATABASE_URL — so 「the tests pass」 on a developer laptop
// says nothing about this file. Run it against the VM before trusting it.

import pg from 'pg';
import { randomUUID } from 'node:crypto';

import { createInitialState } from '../engine.mjs';
import { hashPassword, verifyPassword, tempPassword, sessionToken, sessionSid } from '../auth-util.mjs';
// Pure helpers, imported rather than copied: they ARE the contract (the
// subject default, the plan-node tally, the retention predicate), and a second
// copy is a second thing to drift. They happen to live in json-store.mjs
// because it was written first; moving them to a shared module is a follow-up
// that touches a file this change does not own.
import {
  TITLE_MAX, MATERIAL_KINDS, MATERIAL_MIME_TYPES,
  DEFAULT_ERASURE_WINDOW_DAYS, normalizeSubject, countPlanNodes, isDueForErasure,
} from './json-store.mjs';
// json-store's `tallyBy` has no counterpart here on purpose: the per-subject
// message tally is a GROUP BY, computed in the database rather than by reading
// every message row into the admin console.

const MAX_COURSES_PER_USER = 30;   // abuse guard (DATABASE.md §2)
const CHECKPOINT_EVERY = 20;       // full-document snapshot cadence (DATABASE.md §2)
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days, rolling
const SESSION_BUMP_MS = 60 * 60 * 1000;            // extend at most hourly
const DEFAULT_TITLE = '新课程';
const RATE_STATE_KEY = 'rate_limits';

// These four must match json-store's values exactly. They are duplicated rather
// than imported because json-store does not export them, and the contract suite
// asserts both tiers behave identically — a drift here fails that suite, which
// is the point.

const err = (status, message) => Object.assign(new Error(message), { status });

/** timestamptz arrives as a Date; the interface promises an ISO string, and
 * `assert.equal(a.revoked_at, b.revoked_at)` on two Date objects is false even
 * when they name the same instant. */
const iso = (v) => (v instanceof Date ? v.toISOString() : (v ?? null));

/** bigint (message ids, counts) arrives as a STRING from node-postgres, which
 * keeps int8 exact. '10' > '9' is false, so every id crosses into JS as a
 * number — safe to 2^53, far past any plausible message count. */
const int = (v) => (v == null ? null : Number(v));

/** jsonb bind value. Stringified explicitly and cast at the call site
 * ($n::jsonb) because node-postgres renders a JS ARRAY as a Postgres array
 * literal, not as JSON — an array-shaped delta would fail or, worse, coerce. */
const jsonb = (v) => (v == null ? null : JSON.stringify(v));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A non-uuid id is 「not found」, never a 22P02 cast error mid-transaction. */
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

const trim = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

/** Public user shape — never the password hash. Mirrors json-store's
 * sanitizeUser field for field, including `revoked_at`, because a retention
 * clock the console cannot see is a clock nobody checks. */
const sanitizeUser = (u) => u && {
  id: u.id, username: u.username, display_name: u.display_name, role: u.role,
  status: u.status, must_change_password: Boolean(u.must_change_password),
  display_name_changed_at: iso(u.display_name_changed_at),
  created_at: iso(u.created_at), last_login_at: iso(u.last_login_at),
  revoked_at: iso(u.revoked_at),
  profile: u.settings?.profile ?? null,
};

/** One message row, in the shape json-store returns. */
const messageRow = (r) => ({
  id: int(r.id),
  role: r.role, content: r.content ?? '',
  subject: normalizeSubject(r.subject),
  turn_contract: r.turn_contract ?? null,
  provider: r.provider ?? null, provider_label: r.provider_label ?? null,
  usage: r.usage ?? null, stage_name: r.stage_name ?? null,
  cache: r.cache ?? null, guards: r.guards ?? null,
  created_at: iso(r.created_at),
});

const snapshotRow = (r) => ({
  state_version: r.state_version,
  state_delta: r.state_delta ?? {},
  course_state: r.course_state ?? null,
  is_checkpoint: Boolean(r.is_checkpoint),
  created_at: iso(r.created_at),
});

const MESSAGE_COLUMNS = `id, role, subject, content, turn_contract, provider,
  provider_label, usage, stage_name, cache, guards, created_at`;

/**
 * The PostgreSQL store.
 *
 * @param {{
 *   connectionString?: string,        // app_rw — teacher data, under RLS
 *   adminConnectionString?: string,   // app_admin — auth plane + console
 *   max?: number,
 * }} [opts]
 */
export function createPgStore(opts = {}) {
  const rwUrl = opts.connectionString ?? process.env.DATABASE_URL;
  if (!rwUrl) throw new Error('createPgStore: no connection string (DATABASE_URL)');
  // The old fallback (「same URL for both planes」) was described as
  // SAFE-BY-FAILURE and was not uniformly so. On a correctly roled database
  // with DATABASE_URL_ADMIN forgotten, ownerOf() runs as app_rw with no
  // app.user_id and returns null for EVERY course — so getMessages returns [],
  // a course's whole history silently reads as empty, and the turn path runs
  // with no history instead of erroring. adminListCourses, listScope and
  // listAudit likewise return empty pages that look like an idle instance
  // rather than a misconfiguration. `assertHealthy` below now refuses to start
  // in that state; the fallback is kept only so the refusal can explain itself.
  const adminUrl = opts.adminConnectionString ?? process.env.DATABASE_URL_ADMIN ?? rwUrl;

  const rwPool = new pg.Pool({ connectionString: rwUrl, max: opts.max ?? 10 });
  const adminPool = adminUrl === rwUrl ? rwPool : new pg.Pool({ connectionString: adminUrl, max: 4 });

  // An idle client that errors emits on the pool, and an unhandled 'error' event
  // takes the process down — a dropped TCP connection would kill the server.
  const onPoolError = (e) => { console.error('[pg-store] idle client error:', e?.message ?? e); };
  rwPool.on('error', onPoolError);
  if (adminPool !== rwPool) adminPool.on('error', onPoolError);

  /**
   * WHAT THIS CHECK IS FOR, because it looks like ceremony and is not.
   *
   * Every teacher-plane query in this file ALSO carries an explicit
   * `WHERE user_id = $1`. That habit is deliberate (DATABASE.md §1.4) and it
   * has one bad consequence: the store returns identical results against a
   * database with row-level security disabled, with FORCE missing, or with
   * DATABASE_URL pointed at `postgres`, `app_owner` or `app_admin`. The
   * contract suite passes. The demo works. The isolation is not there, and
   * demo/migrations/README.md says so in as many words — 「nothing in the
   * application will complain」.
   *
   * So the application complains, once, at boot, and refuses to run. A
   * mis-pointed URL becomes a startup failure instead of silent full access.
   *
   * Written from the PostgreSQL documentation and NOT executed — there is no
   * PostgreSQL on the machine this was written on (see 「WHAT WAS NOT
   * VERIFIED」). If a query here is wrong the store fails to start, which is the
   * safe direction for it to be wrong in.
   */
  let healthPromise = null;
  async function assertHealthy() {
    const client = await rwPool.connect();
    try {
      const { rows: [me] } = await client.query(`
        SELECT current_user::text AS role,
               coalesce((SELECT r.rolsuper      FROM pg_roles r WHERE r.rolname = current_user), false) AS is_super,
               coalesce((SELECT r.rolbypassrls  FROM pg_roles r WHERE r.rolname = current_user), false) AS bypasses`);
      // A superuser and a BYPASSRLS role both ignore every policy in 003,
      // including FORCE. Nothing else in this file could tell.
      if (me.is_super) {
        throw new Error(`createPgStore: DATABASE_URL connects as the SUPERUSER '${me.role}'. A superuser ignores every row-level-security policy, so teacher isolation would not exist. Point it at app_rw (demo/migrations/README.md).`);
      }
      if (me.bypasses) {
        throw new Error(`createPgStore: DATABASE_URL connects as '${me.role}', which holds BYPASSRLS. Point it at app_rw.`);
      }
      if (me.role === 'app_admin') {
        throw new Error("createPgStore: DATABASE_URL connects as 'app_admin', the deliberate cross-teacher bypass role. Teacher data must go through app_rw; app_admin belongs in DATABASE_URL_ADMIN.");
      }
      // The owner is exempt from its own policies unless FORCE is set, and
      // membership in the owning role is the same exemption wearing a
      // different name — hence pg_has_role rather than a name comparison.
      const { rows: [owned] } = await client.query(`
        SELECT count(*)::int AS n
          FROM pg_class c JOIN pg_namespace nsp ON nsp.oid = c.relnamespace
         WHERE nsp.nspname = 'public' AND c.relkind = 'r'
           AND (pg_get_userbyid(c.relowner) = current_user
                OR pg_has_role(current_user, pg_get_userbyid(c.relowner), 'USAGE'))`);
      if (owned.n > 0) {
        throw new Error(`createPgStore: DATABASE_URL connects as '${me.role}', which owns (or is a member of the role that owns) ${owned.n} table(s). A table's owner is exempt from its own policies. Point it at app_rw (demo/migrations/002_roles.sql §1).`);
      }
      // FORCE lives in pg_class.relforcerowsecurity and nowhere else.
      // pg_tables.rowsecurity reports only ENABLE and reads `t` while every
      // policy is being skipped for the owner — which is why this reads the
      // inconvenient column.
      const { rows: naked } = await client.query(`
        SELECT c.relname::text AS relname
          FROM pg_class c JOIN pg_namespace nsp ON nsp.oid = c.relnamespace
         WHERE nsp.nspname = 'public' AND c.relkind = 'r'
           AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
         ORDER BY 1`);
      if (naked.length) {
        throw new Error(`createPgStore: ${naked.length} table(s) lack ENABLE+FORCE ROW LEVEL SECURITY: ${naked.map((r) => r.relname).join(', ')}. Usually a table hand-created outside demo/migrations/. Apply 003 (and 005) rather than removing this check.`);
      }
      // The two planes must be two roles. A single shared connection can only
      // be app_rw here (everything else was refused above), and app_rw cannot
      // serve the auth plane: `users_self` hides every other teacher, so login
      // and the admin console return nothing and LOOK like an empty instance.
      if (adminPool === rwPool) {
        throw new Error("createPgStore: DATABASE_URL_ADMIN is not set. The auth plane and the admin console need the separate app_admin connection; sharing the app_rw connection makes every cross-teacher lookup return nothing, which reads as an idle instance rather than as a misconfiguration.");
      }
    } finally {
      client.release();
    }
  }
  /** Memoized: the check runs once per store, on whichever call comes first. A
   * rejected promise is re-thrown to every later caller, which is correct — a
   * database that failed the check does not become safe by being asked twice. */
  const ready = () => (healthPromise ??= assertHealthy());

  /** One statement on the auth/admin plane. */
  const q = async (text, params) => { await ready(); return adminPool.query(text, params); };

  /** A transaction on the auth/admin plane. */
  async function adminTx(fn) {
    await ready();
    const c = await adminPool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  /**
   * Run a teacher-scoped transaction with row-level security in force.
   *
   *   BEGIN; SET LOCAL app.user_id = <her uuid>; … COMMIT;
   *
   * `set_config(name, value, is_local)` with is_local = true IS `SET LOCAL` —
   * and it is the only spelling that accepts a PARAMETER; `SET LOCAL
   * app.user_id = $1` is a syntax error, and building that statement by string
   * concatenation would put a caller-supplied value into DDL-adjacent SQL.
   *
   * LOCAL matters more than it looks: the connection is pooled, so a plain SET
   * would outlive this transaction and hand the NEXT teacher the previous
   * teacher's identity. No policy can defend against that (003_rls.sql, part 3).
   *
   * @param {string} userId
   * @param {(client: import('pg').PoolClient) => Promise<any>} fn
   */
  async function asUser(userId, fn) {
    // An unset or empty setting is fail-closed by policy (nullif → NULL → no
    // rows). 'undefined' or 'null' as a STRING is not: it is a cast error in
    // the middle of the transaction. Refuse before opening it.
    if (!isUuid(userId)) throw err(400, '缺少有效的用户标识');
    await ready();
    const c = await rwPool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.user_id', $1, true)", [userId]);
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  /**
   * Which teacher owns this course.
   *
   * The one place this store reads across teachers on a normal request path,
   * and it reads ONE column. appendMessage, getMessages, saveState and
   * isUntitled take a course id and no user — that is the facade's signature
   * (store.mjs), and serve.mjs calls them from a request that has already
   * resolved its session. The alternative, running the whole operation on the
   * admin connection, would take those four calls out from under RLS entirely;
   * this way only the lookup bypasses and the read or write itself still has to
   * satisfy the policy as that teacher.
   *
   * LATENT HAZARD, RECORDED RATHER THAN HIDDEN: for those four methods RLS
   * provides no isolation at all — the store runs the operation as whoever owns
   * the id it was handed. 「Authenticated」 is not 「authorised for that course」.
   * The check does exist today (serve.mjs proves ownership in runCourseTurn and
   * gates every /api/courses/:id/<sub> route with getCourse(uid, courseId)), so
   * this is a convention in another file rather than a live hole — but a new
   * caller, or one route that forgets, would read and write across teachers
   * with no second lock behind it. `expected` is the cheap interim the facade
   * signatures do not yet allow: a caller that KNOWS whose course this should
   * be says so, and a mismatch throws before any transaction opens.
   *
   * @param {string} courseId
   * @param {string|null} [expected] the user this course must belong to
   * @returns {Promise<string|null>} the owner's id, or null when no such course
   */
  async function ownerOf(courseId, expected = null) {
    if (!isUuid(courseId)) return null;
    const { rows } = await q('SELECT user_id FROM courses WHERE id = $1', [courseId]);
    const owner = rows[0]?.user_id ?? null;
    if (expected != null && owner !== null && owner !== expected) throw err(404, '课程不存在');
    return owner;
  }

  /**
   * Every object key this course owns in the private bucket.
   *
   * Read on the ADMIN plane on purpose: this runs for the admin console as well
   * as for a teacher deleting her own course, and a key that cannot be read is
   * an object that cannot be deleted. The row is the ONLY record of the key.
   */
  async function cosKeysOfCourse(courseId) {
    const { rows } = await q('SELECT cos_key FROM materials WHERE course_id = $1', [courseId]);
    return [...new Set(rows.map((r) => r.cos_key).filter((k) => typeof k === 'string' && k))];
  }

  const brief = (r) => ({
    id: r.id, title: r.title, state_version: r.state_version, updated_at: iso(r.updated_at),
  });

  /**
   * Delete one course and everything that hangs off it, in an order no foreign
   * key can refuse: violations point at messages AND courses, snapshots point
   * at messages. `facts.course_id` cascades on its own; `interaction_signals`
   * nulls its course_id. Runs on whichever client is handed in, so the same
   * ordering serves the teacher path and the admin console.
   *
   * Whole-course deletion is a data subject erasing their own record (PIPL
   * right to erasure), which is why it is a hard delete and not the
   * append-only rule being broken — DATABASE.md §4 draws that line, and also
   * records that v1 SHOULD move to a tombstone-plus-retention-timer instead.
   * That change belongs with the COS deletion it implies, not here.
   */
  async function deleteCourseRows(c, courseId, ownerId = null) {
    // A harness verdict can fire with a NULL course_id and still point at a
    // message in this course (003_rls.sql spells out that violations.course_id
    // is nullable). Deleting only by course_id would leave that row behind and
    // the message delete below would fail on its foreign key — an erase that
    // aborts halfway because of telemetry.
    await c.query(
      `DELETE FROM violations
        WHERE course_id = $1
           OR message_id IN (SELECT id FROM messages WHERE course_id = $1)`, [courseId],
    );
    await c.query('DELETE FROM materials WHERE course_id = $1', [courseId]);
    await c.query('DELETE FROM course_snapshots WHERE course_id = $1', [courseId]);
    await c.query('DELETE FROM messages WHERE course_id = $1', [courseId]);
    // `ownerId` threads the PROVEN owner into the destructive statement itself.
    // Ownership is checked in a separate, earlier transaction (see
    // deleteCourse), and nothing re-checks between the two — so without this
    // predicate the delete carries no evidence of what authorised it and can
    // outlive the check that justified it. The admin console passes null and
    // keeps the unqualified form, which IS the cross-teacher bypass ADR-0013 §7
    // grants deliberately.
    const r = await c.query(
      'DELETE FROM courses WHERE id = $1 AND ($2::uuid IS NULL OR user_id = $2)',
      [courseId, ownerId],
    );
    return r.rowCount > 0;
  }

  /**
   * Delete one course: OBJECTS FIRST, then rows.
   *
   * ADR-0013 §6: 「Deleting a course deletes its objects. Orphaned child photos
   * in a bucket nobody tracks are the failure mode to design against.」 The
   * materials row is the only record of the object key, so a delete that starts
   * with the rows has already lost the ability to find the photograph.
   * 002_roles.sql states the rule and this is the path that has to keep it.
   *
   * The store owns no COS client, so the caller injects the deleter; without
   * one the keys ride back in the result and deleting them is the caller's
   * obligation — stated, not assumed.
   *
   * @param {string} courseId
   * @param {string|null} ownerId proven owner, or null for the admin bypass
   * @param {((cosKey: string) => Promise<void>|void)|null} deleteObject
   */
  async function deleteCourseWithObjects(courseId, ownerId, deleteObject) {
    const cosKeys = await cosKeysOfCourse(courseId);
    // Outside the transaction, and before it: a throw here leaves every row
    // intact, so the operation can simply be repeated. An orphaned object
    // cannot be found again.
    if (typeof deleteObject === 'function') {
      for (const key of cosKeys) await deleteObject(key);
    }
    const deleted = await adminTx((c) => deleteCourseRows(c, courseId, ownerId));
    return { deleted, cos_keys: cosKeys, objects_deleted: typeof deleteObject === 'function' };
  }

  /** Revoke every live session of one user. @returns how many died. */
  async function killSessions(client, userId) {
    const r = await (client ?? adminPool).query(
      'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
      [userId],
    );
    return r.rowCount;
  }

  async function appendAuditRow(client, adminId, action, targetUser, detail) {
    await (client ?? adminPool).query(
      `INSERT INTO admin_audit (admin_id, action, target_user, detail)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [adminId ?? null, action, targetUser ?? null, jsonb(detail ?? null)],
    );
  }

  /** Full admin record for one course: the row plus its messages and snapshots.
   * Deliberately does NOT reach user_keys — the vault is out of every export
   * path (ADR-0005), and the way to keep it out is never to join it. */
  async function fullCourseRecord(row) {
    const [msgs, snaps] = await Promise.all([
      q(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE course_id = $1 ORDER BY id`, [row.id]),
      q(`SELECT state_version, state_delta, course_state, is_checkpoint, created_at
           FROM course_snapshots WHERE course_id = $1 ORDER BY state_version`, [row.id]),
    ]);
    return {
      id: row.id, user_id: row.user_id, title: row.title,
      title_locked: Boolean(row.title_locked),
      course_state: row.course_state, state_version: row.state_version,
      created_at: iso(row.created_at), updated_at: iso(row.updated_at),
      workbench: row.workbench ?? null,
      messages: msgs.rows.map(messageRow),
      snapshots: snaps.rows.map(snapshotRow),
    };
  }

  // Named rather than returned anonymously so one method can call another
  // without `this` — a facade whose methods break when they are destructured is
  // a trap for the next caller.
  const api = {
    // ================= courses =================

    async listCourses(userId) {
      return asUser(userId, async (c) => {
        // The explicit filter is the habit; the policy is the guarantee
        // (DATABASE.md §1.4). Keeping both means a policy regression shows up
        // as a test failure rather than as another teacher's course list.
        const { rows } = await c.query(
          `SELECT id, title, state_version, updated_at FROM courses
            WHERE user_id = $1 ORDER BY updated_at DESC`, [userId],
        );
        return rows.map(brief);
      });
    },

    async createCourse(userId, title) {
      return asUser(userId, async (c) => {
        const { rows: [{ n }] } = await c.query(
          'SELECT count(*)::int AS n FROM courses WHERE user_id = $1', [userId],
        );
        // READ COMMITTED does not make this a real guard against two
        // simultaneous creates — DATABASE.md §2 calls the quota an endpoint
        // rule, and a hard one would need a trigger or a counter row. It stops
        // the case it exists for (one teacher, one browser, a stuck button).
        if (n >= MAX_COURSES_PER_USER) throw err(409, `最多 ${MAX_COURSES_PER_USER} 个课程`);
        const id = randomUUID();
        const { rows } = await c.query(
          `INSERT INTO courses (id, user_id, title, course_state, state_version, title_locked)
           VALUES ($1, $2, $3, $4::jsonb, 0, false)
           RETURNING id, title, state_version, updated_at`,
          // Edge-trimmed only, exactly as the JSON tier creates it. renameCourse
          // additionally collapses inner whitespace, and so does that tier —
          // the two paths differ there in both implementations, identically.
          [id, userId, String(title ?? '').trim() || DEFAULT_TITLE, JSON.stringify(createInitialState(id))],
        );
        return brief(rows[0]);
      });
    },

    async getCourse(userId, courseId) {
      if (!isUuid(courseId)) return null;
      return asUser(userId, async (c) => {
        const { rows } = await c.query(
          `SELECT id, title, course_state, state_version, created_at, updated_at
             FROM courses WHERE id = $1 AND user_id = $2`, [courseId, userId],
        );
        const r = rows[0];
        return r ? {
          id: r.id, title: r.title, course_state: r.course_state,
          state_version: r.state_version,
          created_at: iso(r.created_at), updated_at: iso(r.updated_at),
        } : null;
      });
    },

    /**
     * Rename (owner only). A human rename sets title_locked so auto-titling
     * never overwrites a person's choice; an auto rename leaves it unlocked.
     */
    async renameCourse(userId, courseId, title, { auto = false } = {}) {
      if (!isUuid(courseId)) throw err(404, '课程不存在');
      return asUser(userId, async (c) => {
        const { rows } = await c.query(
          `SELECT id, title, title_locked, state_version, updated_at
             FROM courses WHERE id = $1 AND user_id = $2 FOR UPDATE`, [courseId, userId],
        );
        const row = rows[0];
        if (!row) throw err(404, '课程不存在');
        if (auto && row.title_locked) return brief(row);        // human choice wins
        const t = trim(title);
        if (!t || t.length > TITLE_MAX) throw err(400, `课程名需为 1–${TITLE_MAX} 个字符`);
        const { rows: [next] } = await c.query(
          `UPDATE courses SET title = $3, title_locked = title_locked OR $4::boolean, updated_at = now()
            WHERE id = $1 AND user_id = $2
            RETURNING id, title, state_version, updated_at`,
          [courseId, userId, t, !auto],
        );
        return brief(next);
      });
    },

    /** Teacher ✓确认 of one blueprint node — the engine decides, the store
     * records. The confirmation rides state_version so replay and audit see it
     * as a revision rather than as a field that changed by itself. */
    async confirmBlueprintNode(userId, courseId, nodeId, engineConfirm) {
      if (!isUuid(courseId)) throw err(404, '课程不存在');
      return asUser(userId, async (c) => {
        const { rows } = await c.query(
          'SELECT course_state, state_version FROM courses WHERE id = $1 AND user_id = $2 FOR UPDATE',
          [courseId, userId],
        );
        if (!rows[0]) throw err(404, '课程不存在');
        // Called synchronously, exactly as json-store calls it: the two tiers
        // must accept the same engine function, and awaiting here would make an
        // async engine work against Postgres and silently misbehave on JSON.
        const r = engineConfirm(rows[0].course_state, nodeId);
        if (!r.confirmed) throw err(400, '节点不存在或已是已确认');
        const version = rows[0].state_version + 1;
        await c.query(
          'UPDATE courses SET course_state = $2::jsonb, state_version = $3, updated_at = now() WHERE id = $1',
          [courseId, JSON.stringify(r.state), version],
        );
        await c.query(
          `INSERT INTO course_snapshots (course_id, state_version, state_delta, course_state, is_checkpoint)
           VALUES ($1, $2, $3::jsonb, NULL, false)`,
          [courseId, version, JSON.stringify({ blueprint_confirm: nodeId })],
        );
        return r.state.course_plan_blueprint;
      });
    },

    /** Mirror of the teacher's unsent 工作台 state: the living question-card
     * answers plus the receipt ledger (ADR-0010 §7). Scratch, not history — no
     * state_version bump, no snapshot row; admin exports simply show
     * work-in-progress alongside what was actually sent.
     *
     * MERGES, never replaces. The 批注 surface is gone, so a current client
     * sends no `blueprint_comments` — and a replacing write turned the first
     * turn after that build into a silent deletion of words the teacher typed
     * and never sent. An absent key now means 「不知道」, not 「空的」; only an
     * explicitly supplied array rewrites a section. `recent_nodes` is
     * deliberately NOT stored: it is a per-browser navigation trail, and the
     * server can derive a truer one from message subjects plus
     * course_plan.revision_log. */
    async setWorkbench(userId, courseId, workbench) {
      if (!isUuid(courseId)) throw err(404, '课程不存在');
      return asUser(userId, async (c) => {
        const { rows } = await c.query(
          'SELECT id, workbench FROM courses WHERE id = $1 AND user_id = $2', [courseId, userId],
        );
        if (!rows[0]) throw err(404, '课程不存在');
        const prev = rows[0].workbench ?? {};
        // Same caps as the JSON tier, field for field. They are a bound on how
        // much unsent scratch one course may hold, not formatting.
        const s = (v, max) => String(v ?? '').slice(0, max);
        const comments = Array.isArray(workbench?.blueprint_comments)
          ? workbench.blueprint_comments.slice(0, 200)
            .map((r) => ({ id: s(r?.id, 120), number: s(r?.number, 20), title: s(r?.title, 200), text: s(r?.text, 500) }))
          : prev.blueprint_comments;
        // Receipts are a record of what was written, so they are clipped and
        // capped like everything else here, and `state_before` (a whole state
        // snapshot, the undo buffer) is never accepted over the wire.
        const receipts = Array.isArray(workbench?.receipts) ? workbench.receipts.slice(0, 40).map((r) => ({
          id: s(r?.id, 120),
          at: s(r?.at, 40),
          turn_index: Number.isFinite(Number(r?.turn_index)) ? Number(r.turn_index) : null,
          parts: (Array.isArray(r?.parts) ? r.parts : []).slice(0, 10).map((x) => ({
            kind: s(x?.kind, 20), count: Math.trunc(Number(x?.count) || 0), label: s(x?.label, 200),
            node_ids: (Array.isArray(x?.node_ids) ? x.node_ids : []).slice(0, 50).map((i) => s(i, 120)),
          })),
          undoable: Boolean(r?.undoable),
          undone: Boolean(r?.undone),
        })) : null;
        const qc = workbench?.question_cards;
        const cards = qc && Array.isArray(qc.questions) ? {
          questions: qc.questions.slice(0, 50).map((x) => ({ text: s(x?.text, 500), ...(x?.why ? { why: s(x.why, 500) } : {}) })),
          answers: (Array.isArray(qc.answers) ? qc.answers : []).slice(0, 50)
            .map((a) => ({ value: s(a?.value, 2000), skipped: Boolean(a?.skipped), locked: Boolean(a?.locked) })),
        } : null;
        const value = {
          ...(comments === undefined ? {} : { blueprint_comments: comments }),
          question_cards: 'question_cards' in (workbench ?? {}) ? cards : (prev.question_cards ?? cards),
          receipts: receipts === null ? (prev.receipts ?? []) : receipts,
          updated_at: new Date().toISOString(),
        };
        await c.query('UPDATE courses SET workbench = $2::jsonb WHERE id = $1', [courseId, JSON.stringify(value)]);
        return value;
      });
    },

    /** True when auto-titling may run: still on the default name, not locked. */
    async isUntitled(courseId) {
      const owner = await ownerOf(courseId);
      if (!owner) return false;
      return asUser(owner, async (c) => {
        const { rows } = await c.query('SELECT title, title_locked FROM courses WHERE id = $1', [courseId]);
        const r = rows[0];
        return Boolean(r && !r.title_locked && r.title === DEFAULT_TITLE);
      });
    },

    /**
     * Whole-course erasure. Two steps on purpose:
     *
     * ① Ownership is proved UNDER THE POLICY, as her — if the row is not hers
     *    the policy hides it and this returns false, exactly as the JSON tier
     *    does for a mismatched user_id.
     * ② The cascade then runs on the admin connection, because it has to remove
     *    rows her own policies deliberately hide from her: a harness violation
     *    with a NULL course_id belongs to nobody and is invisible to app_rw
     *    (003_rls.sql says so in as many words), so deleting as her would skip
     *    it and the message delete would then abort on its foreign key. A
     *    course deletion that fails halfway is worse than one that reaches
     *    telemetry she cannot read.
     */
    async deleteCourse(userId, courseId, { deleteObject = null } = {}) {
      const empty = { deleted: false, cos_keys: [], objects_deleted: false };
      if (!isUuid(courseId)) return empty;
      const mine = await asUser(userId, async (c) => {
        const { rows } = await c.query(
          'SELECT id FROM courses WHERE id = $1 AND user_id = $2', [courseId, userId],
        );
        return Boolean(rows[0]);
      });
      if (!mine) return empty;
      // The proven owner rides into the final DELETE (see deleteCourseRows).
      return deleteCourseWithObjects(courseId, userId, deleteObject);
    },

    // ================= messages =================

    /** Append one message (append-only). `msg.subject` tags it (ADR-0010 §1). */
    async appendMessage(courseId, msg) {
      const owner = await ownerOf(courseId);
      if (!owner) throw err(404, '课程不存在');
      return asUser(owner, async (c) => {
        let rows;
        try {
          ({ rows } = await c.query(
            `INSERT INTO messages (course_id, user_id, role, subject, content, turn_contract,
                                   provider, provider_label, usage, stage_name, cache, guards)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10, $11::jsonb, $12::jsonb)
             RETURNING ${MESSAGE_COLUMNS}`,
            [
              courseId, owner, msg.role,
              // Read from the caller's own field and nowhere else: the subject
              // is engine-owned (ADR-0010 §2), so a `subject` the model put in
              // its turn_contract rides along as record and is never used.
              normalizeSubject(msg.subject),
              msg.content ?? '',
              jsonb(msg.turn_contract ?? null),
              msg.provider ?? null, msg.provider_label ?? null,
              jsonb(msg.usage ?? null), msg.stage_name ?? null,
              jsonb(msg.cache ?? null), jsonb(msg.guards ?? null),
            ],
          ));
        } catch (e) {
          // 23514 = check_violation: the only CHECK on this table is the role
          // allowlist, so this is a caller sending an unknown role.
          if (e?.code === '23514') throw err(400, '消息角色不支持');
          // 23503 = foreign_key_violation: the course was deleted between the
          // owner lookup and this insert. Same answer as never having existed.
          if (e?.code === '23503') throw err(404, '课程不存在');
          throw e;
        }
        const row = messageRow(rows[0]);
        // The history rail sorts by updated_at, so a course that is being
        // talked about has to move to the top even when no state changed.
        await c.query('UPDATE courses SET updated_at = $2 WHERE id = $1', [courseId, row.created_at]);
        return row;
      });
    },

    async getMessages(courseId, { before, limit, subject } = {}) {
      const owner = await ownerOf(courseId);
      if (!owner) return [];                    // reading a missing course is empty history
      return asUser(owner, async (c) => {
        // The subject filter is a VIEW over the one ordered log, never a
        // partition: ids stay global, so 「she asked about 3.2.1 BEFORE she
        // edited 周2」 stays provable from a filtered read (ADR-0010 §1).
        // The inner ORDER BY … DESC + LIMIT takes the most recent N, the outer
        // one hands them back in reading order. LIMIT NULL means no limit.
        const { rows } = await c.query(
          `SELECT * FROM (
             SELECT ${MESSAGE_COLUMNS} FROM messages
              WHERE course_id = $1
                AND ($2::text IS NULL OR subject = $2)
                AND ($3::bigint IS NULL OR id < $3)
              ORDER BY id DESC
              LIMIT $4::bigint
           ) t ORDER BY id ASC`,
          [
            courseId,
            subject == null ? null : normalizeSubject(subject),
            before == null ? null : String(before),
            limit == null ? null : String(limit),
          ],
        );
        return rows.map(messageRow);
      });
    },

    // ================= state, snapshots, the optimistic lock =================

    /** Delta every version, full document at checkpoints (DATABASE.md §2). */
    async saveState(courseId, delta, newState, expectedVersion) {
      const owner = await ownerOf(courseId);
      if (!owner) throw err(404, '课程不存在');
      return asUser(owner, async (c) => {
        // FOR UPDATE plus the version in the UPDATE's WHERE: the row lock
        // serialises two turns on one course, and the predicate is what makes a
        // stale write abort the WHOLE transaction rather than half-apply
        // (DATABASE.md §3).
        const { rows } = await c.query(
          `SELECT state_version, course_state->'stage' AS stage
             FROM courses WHERE id = $1 FOR UPDATE`, [courseId],
        );
        const row = rows[0];
        if (!row) throw err(404, '课程不存在');
        if (expectedVersion != null && row.state_version !== expectedVersion) {
          throw err(409, '状态版本冲突');
        }
        const version = row.state_version + 1;
        // `?? null` on both sides: jsonb gives null for an absent key where the
        // JSON tier gives undefined, and null !== undefined would make every
        // stage-less course look like a stage change.
        const stageChanged = (row.stage ?? null) !== (newState?.stage ?? null);
        const isCheckpoint = version % CHECKPOINT_EVERY === 0 || stageChanged || version === 1;

        const upd = await c.query(
          `UPDATE courses SET course_state = $2::jsonb, state_version = $3, updated_at = now()
            WHERE id = $1 AND state_version = $4`,
          [courseId, JSON.stringify(newState ?? {}), version, row.state_version],
        );
        if (upd.rowCount === 0) throw err(409, '状态版本冲突');

        await c.query(
          `INSERT INTO course_snapshots (course_id, state_version, state_delta, course_state, is_checkpoint)
           VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)`,
          [
            courseId, version, JSON.stringify(delta ?? {}),
            // checkpoint ⇔ full document. Reconstruction is 「nearest checkpoint
            // <= V, then replay deltas forward」, so a checkpoint without a
            // document and a document on a row nobody reads both break replay.
            isCheckpoint ? JSON.stringify(newState ?? {}) : null,
            isCheckpoint,
          ],
        );
        return { state_version: version };
      });
    },

    // ================= users (auth plane) =================

    /** Admin-provisioned account; returns the one-time temp password. */
    async createUser({ username, displayName, role = 'teacher', createdBy = null }) {
      const uname = String(username ?? '').trim().toLowerCase();
      if (!/^[a-z0-9_\-]{3,24}$/.test(uname)) throw err(400, '用户名需为 3–24 位小写字母、数字、_-');
      const dname = String(displayName ?? '').trim() || uname;
      const dup = await q(
        'SELECT username, display_name FROM users WHERE username = $1 OR display_name = $2',
        [uname, dname],
      );
      if (dup.rows.some((r) => r.username === uname)) throw err(409, '用户名已存在');
      if (dup.rows.length) throw err(409, '昵称已被占用');
      const temp = tempPassword();
      try {
        const { rows } = await q(
          `INSERT INTO users (username, display_name, password_hash, role, status,
                              must_change_password, created_by, settings)
           VALUES ($1, $2, $3, $4, 'active', true, $5, '{}'::jsonb)
           RETURNING *`,
          [uname, dname, hashPassword(temp), role === 'admin' ? 'admin' : 'teacher', createdBy],
        );
        return { user: sanitizeUser(rows[0]), temp_password: temp };
      } catch (e) {
        // 23505 = unique_violation. The SELECT above lost a race with another
        // create; the database is the thing that actually decides.
        if (e?.code === '23505') throw err(409, '用户名或昵称已存在');
        throw e;
      }
    },

    async getUser(userId) {
      if (!isUuid(userId)) return null;
      const { rows } = await q('SELECT * FROM users WHERE id = $1', [userId]);
      return sanitizeUser(rows[0] ?? null);
    },

    async listUsers() {
      const { rows } = await q('SELECT * FROM users ORDER BY created_at');
      return rows.map(sanitizeUser);
    },

    /**
     * Password login. Compared TRIMMED on purpose: temp passwords are pasted
     * out of chat apps with stray edge whitespace, and no stored password ever
     * has any. Dropping the trim produces a wave of 「密码不对」 for teachers who
     * typed nothing wrong.
     * @returns sanitized user, or null for wrong credentials / not active
     */
    async verifyLogin(username, password) {
      const uname = String(username ?? '').trim().toLowerCase();
      if (!uname) return null;
      const { rows } = await q('SELECT * FROM users WHERE username = $1', [uname]);
      const u = rows[0];
      if (!u || u.status !== 'active' || !verifyPassword(String(password ?? '').trim(), u.password_hash)) {
        return null;
      }
      const { rows: [next] } = await q(
        'UPDATE users SET last_login_at = now() WHERE id = $1 RETURNING *', [u.id],
      );
      return sanitizeUser(next);
    },

    /** Self-service change (old verified) — clears must_change_password. */
    async changePassword(userId, oldPassword, newPassword) {
      if (!isUuid(userId)) throw err(404, '用户不存在');
      const { rows } = await q('SELECT id, password_hash FROM users WHERE id = $1', [userId]);
      if (!rows[0]) throw err(404, '用户不存在');
      if (!verifyPassword(String(oldPassword ?? '').trim(), rows[0].password_hash)) throw err(403, '旧密码不对');
      const next = String(newPassword ?? '').trim();
      if (next.length < 8) throw err(400, '新密码至少 8 位');
      await q(
        'UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1',
        [userId, hashPassword(next)],
      );
      return true;
    },

    /** Admin reset — returns a fresh one-time temp password. */
    async resetPassword(userId) {
      if (!isUuid(userId)) throw err(404, '用户不存在');
      const temp = tempPassword();
      const r = await q(
        'UPDATE users SET password_hash = $2, must_change_password = true WHERE id = $1',
        [userId, hashPassword(temp)],
      );
      if (r.rowCount === 0) throw err(404, '用户不存在');
      return temp;
    },

    /** Uniqueness plus the stamp. Charset, profanity and the 6-month lock are
     * the caller's rules (auth-util), which is why none of them appear here. */
    async setDisplayName(userId, name) {
      if (!isUuid(userId)) throw err(404, '用户不存在');
      const dname = String(name ?? '').trim();
      const taken = await q('SELECT id FROM users WHERE display_name = $1 AND id <> $2', [dname, userId]);
      if (taken.rowCount > 0) throw err(409, '昵称已被占用');
      try {
        const { rows } = await q(
          'UPDATE users SET display_name = $2, display_name_changed_at = now() WHERE id = $1 RETURNING *',
          [userId, dname],
        );
        if (!rows[0]) throw err(404, '用户不存在');
        return sanitizeUser(rows[0]);
      } catch (e) {
        if (e?.code === '23505') throw err(409, '昵称已被占用');
        throw e;
      }
    },

    async saveUserProfile(userId, profile) {
      if (!isUuid(userId)) throw err(404, '用户不存在');
      // jsonb_set with create_missing = true writes settings.profile without
      // touching the rest of settings — the axis vector and UI prefs live in
      // the same document and must survive a profile save.
      const r = await q(
        `UPDATE users
            SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{profile}', $2::jsonb, true)
          WHERE id = $1`,
        [userId, JSON.stringify(profile ?? null)],
      );
      if (r.rowCount === 0) throw err(404, '用户不存在');
      return true;
    },

    /**
     * Admin: status and role changes. Anything that is not `active` also
     * revokes live sessions. `disabled` is the legacy spelling kept for the
     * existing console button; ADR-0013's three states are active / revoked /
     * erased, and `revoked` is the one that starts the retention clock — a
     * `disabled` row is never seen by dueForErasure.
     */
    async updateUser(userId, patch) {
      if (!isUuid(userId)) throw err(404, '用户不存在');
      return adminTx(async (c) => {
        const { rows } = await c.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
        const u = rows[0];
        if (!u) throw err(404, '用户不存在');
        let next = u;
        if (patch.status && ['active', 'disabled', 'revoked'].includes(patch.status)) {
          if (patch.status === 'revoked') {
            // coalesce, not now(): a second revoke must never move the stamp
            // forward, or every click restarts the retention window and
            // 「revoked」 quietly becomes 「kept forever」.
            ({ rows: [next] } = await c.query(
              `UPDATE users SET status = 'revoked', revoked_at = coalesce(revoked_at, now())
                WHERE id = $1 RETURNING *`, [userId],
            ));
          } else {
            // Reinstatement stops the clock. Leaving the stamp would hand the
            // scheduled erasure job a live account to delete.
            ({ rows: [next] } = await c.query(
              `UPDATE users SET status = $2, revoked_at = CASE WHEN $2 = 'active' THEN NULL ELSE revoked_at END
                WHERE id = $1 RETURNING *`, [userId, patch.status],
            ));
          }
        }
        if (patch.role && ['admin', 'teacher'].includes(patch.role)) {
          ({ rows: [next] } = await c.query(
            'UPDATE users SET role = $2 WHERE id = $1 RETURNING *', [userId, patch.role],
          ));
        }
        if (next.status !== 'active') await killSessions(c, userId);
        return sanitizeUser(next);
      });
    },

    // ================= the three account states (ADR-0013 §11) =================

    /**
     * REVOKE — the teacher left the school, or was banned. Login is refused,
     * live sessions die, and THE DATA STAYS: the kindergarten may still need
     * last year's curriculum. Stamping `revoked_at` starts the retention clock
     * that dueForErasure reads; a revocation without it would sit here forever.
     */
    async revokeUser(adminId, userId) {
      if (!isUuid(userId)) throw err(404, '用户不存在');
      return adminTx(async (c) => {
        const { rows } = await c.query(
          `UPDATE users SET status = 'revoked', revoked_at = coalesce(revoked_at, now())
            WHERE id = $1 RETURNING *`, [userId],
        );
        const u = rows[0];
        if (!u) throw err(404, '用户不存在');
        const killed = await killSessions(c, userId);
        await appendAuditRow(c, adminId, 'revoke_user', userId, {
          revoked_at: iso(u.revoked_at), sessions_revoked: killed,
        });
        return sanitizeUser(u);
      });
    },

    /**
     * Revoked accounts whose retention window has passed. RETURNS IDS AND
     * ERASES NOTHING — the caller decides, because erasure is irreversible and
     * a scheduled job that both finds and deletes has no step where a human can
     * look. The window is an argument, not a constant (DATABASE.md §5b).
     *
     * The predicate is evaluated in JavaScript, by the same pure function the
     * JSON tier uses, rather than as an SQL interval: one implementation of
     * 「is this due」 means the two tiers cannot disagree about a boundary, and
     * the candidate set is every revoked account — a handful, not a scan.
     */
    async dueForErasure(now = Date.now(), windowDays = DEFAULT_ERASURE_WINDOW_DAYS) {
      const days = Number(windowDays);
      // A NaN window would compare false everywhere and quietly return nothing
      // due — a retention job that silently stops is the failure to avoid.
      if (!Number.isFinite(days) || days < 0) throw err(400, '保留期需为非负天数');
      const { rows } = await q(
        "SELECT id, status, revoked_at FROM users WHERE status = 'revoked'",
      );
      return rows.filter((u) => isDueForErasure(u, now, days)).map((u) => u.id);
    },

    /**
     * ERASE — everything goes (ADR-0013 §11, DATABASE.md §5b).
     *
     * @param {string|null} adminId who asked
     * @param {string} userId
     * @param {{deleteObject?: ((cosKey: string) => Promise<void>|void)|null}} [opts]
     *   `deleteObject` removes one COS object. Provide it and the bucket is
     *   emptied before any row is touched, with a throw aborting the erase.
     *   Omit it and the receipt's `cos_keys` are the caller's to delete.
     */
    async eraseUser(adminId, userId, { deleteObject = null } = {}) {
      if (!isUuid(userId)) throw err(404, '用户不存在');
      const { rows: userRows } = await q('SELECT id, username FROM users WHERE id = $1', [userId]);
      const u = userRows[0];
      if (!u) throw err(404, '用户不存在');

      const { rows: courseRows } = await q('SELECT id FROM courses WHERE user_id = $1', [userId]);
      const courseIds = courseRows.map((r) => r.id);
      const { rows: keyRows } = await q(
        `SELECT cos_key FROM materials
          WHERE user_id = $1 OR course_id = ANY($2::uuid[])`, [userId, courseIds],
      );
      const cosKeys = [...new Set(keyRows.map((r) => r.cos_key).filter((k) => typeof k === 'string' && k))];

      // OBJECTS BEFORE ROWS. A deleted row is a lost key, and a lost key is a
      // child photo nobody can find to delete. So the bucket goes first, and a
      // throw here aborts with every row still intact — a half-run erase can be
      // repeated, an orphaned object cannot be found again. This store owns no
      // COS client, so the caller injects the deleter; without one the keys ride
      // back in the receipt and deleting them is the caller's obligation.
      if (typeof deleteObject === 'function') {
        for (const key of cosKeys) await deleteObject(key);
      }

      const count = async (c, sql, params) => Number((await c.query(sql, params)).rows[0].n);

      const receipt = await adminTx(async (c) => {
        // Sessions first: an open session must stop resolving before its data
        // starts disappearing, so no request can read a half-erased account.
        await c.query('DELETE FROM sessions WHERE user_id = $1', [userId]);

        // EVERY count is taken BEFORE anything is deleted. `facts.course_id`
        // and `classes` cascade from their parents, so a count taken afterwards
        // reports fewer rows than were actually erased — and the receipt is the
        // only evidence an operator has that the erase did what it says.
        const deleted = {
          courses: courseIds.length,
          // Counted by BOTH predicates, because both are swept below. A count
          // taken only over her courses would under-report a stray row and
          // make the receipt claim less than the erase actually removed.
          messages: await count(c,
            'SELECT count(*)::int AS n FROM messages WHERE course_id = ANY($1::uuid[]) OR user_id = $2',
            [courseIds, userId]),
          snapshots: await count(c,
            'SELECT count(*)::int AS n FROM course_snapshots WHERE course_id = ANY($1::uuid[])', [courseIds]),
          materials: await count(c, 'SELECT count(*)::int AS n FROM materials WHERE user_id = $1', [userId]),
          facts: await count(c, 'SELECT count(*)::int AS n FROM facts WHERE user_id = $1', [userId]),
          interaction_signals: await count(c,
            'SELECT count(*)::int AS n FROM interaction_signals WHERE user_id = $1', [userId]),
          classes: await count(c, 'SELECT count(*)::int AS n FROM classes WHERE user_id = $1', [userId]),
          key_providers: await count(c, 'SELECT count(*)::int AS n FROM user_keys WHERE user_id = $1', [userId]),
        };

        // null owner: this IS the admin bypass, and her courses have already
        // been enumerated by user_id above.
        for (const id of courseIds) await deleteCourseRows(c, id, null);
        // Swept by user_id as well, not only through the courses: an erase that
        // trusts a join is an erase with a survivor.
        //
        // `messages` is in this list for exactly the reason the other four are.
        // It used to be deleted only per course, inside deleteCourseRows —
        // but `messages.user_id` is a plain FK with no ON DELETE, so a single
        // row of hers sitting in a course she does not own (an importer
        // artefact, an admin-plane write, any row created before the policies
        // existed) made the final `DELETE FROM users` fail on a foreign key and
        // aborted the whole erase AFTER the COS objects had already been
        // deleted outside this transaction. That is the worst possible place
        // for an erase to stop.
        //
        // Violations point at messages, so they go first — same ordering rule
        // as deleteCourseRows, applied to the stray-row sweep.
        //
        // `course_snapshots.message_id` also references messages. It is not
        // handled here because nothing has ever written it: this store's
        // snapshot INSERTs omit the column and the JSON importer sets it NULL
        // explicitly (it says why). If a future turn path starts recording it,
        // this sweep needs a matching step — and app_admin would need UPDATE on
        // course_snapshots, which 002 deliberately withholds today.
        await c.query(
          'DELETE FROM violations WHERE message_id IN (SELECT id FROM messages WHERE user_id = $1)', [userId],
        );
        await c.query('DELETE FROM messages WHERE user_id = $1', [userId]);
        await c.query('DELETE FROM materials WHERE user_id = $1', [userId]);
        await c.query('DELETE FROM facts WHERE user_id = $1', [userId]);
        await c.query('DELETE FROM interaction_signals WHERE user_id = $1', [userId]);
        await c.query('DELETE FROM classes WHERE user_id = $1', [userId]);
        // Vaulted keys must not outlive the account (ADR-0005).
        await c.query('DELETE FROM user_keys WHERE user_id = $1', [userId]);

        // The scope log keeps its ROWS and loses the PERSON: operational
        // history survives, the subject does not.
        const scopeNulled = (await c.query(
          'UPDATE scope_log SET user_id = NULL WHERE user_id = $1', [userId],
        )).rowCount;
        // Same treatment for the admin audit. `admin_id` is deliberately NOT
        // nulled — accountability for what an admin did has to survive; it is
        // the erased person who goes.
        const auditNulled = (await c.query(
          'UPDATE admin_audit SET target_user = NULL WHERE target_user = $1', [userId],
        )).rowCount;

        await c.query('DELETE FROM users WHERE id = $1', [userId]);

        // The erase row names NO subject: recording who was erased in the log
        // that outlives the erasure would defeat it. Counts are what an
        // operator needs in order to see that it ran.
        await appendAuditRow(c, adminId, 'erase_user', null, {
          ...deleted,
          objects: cosKeys.length,
          objects_deleted: typeof deleteObject === 'function',
          scope_log_nulled: scopeNulled, audit_subjects_nulled: auditNulled,
        });
        return { deleted, scope_log_nulled: scopeNulled, audit_subjects_nulled: auditNulled };
      });

      return {
        // The username rides back in the RESPONSE — the admin who asked needs
        // to see which account went — and is written to no file.
        username: u.username,
        cos_keys: cosKeys,
        objects_deleted: typeof deleteObject === 'function',
        ...receipt,
      };
    },

    /** Legacy name for erase, kept because serve.mjs's admin console calls it. */
    async deleteUser(userId) {
      const r = await api.eraseUser(null, userId, {});
      return { username: r.username, courses_deleted: r.deleted.courses, cos_keys: r.cos_keys };
    },

    // ================= materials (COS references, never bytes) =================

    /**
     * Record one uploaded object (ADR-0013 §6). The bytes live in the private
     * LighthouseCOS bucket; this row is all the store keeps, and it exists so
     * erasure can find the key — an object nobody recorded is an object nobody
     * can delete.
     *
     * The store neither mints the key nor enforces the size cap: the upload
     * path owns both, because it knows the extension and the configured limit.
     * It also owns non-negotiable #4 — no uploaded child photo reaches any model
     * without its own compliance ADR, enforced where the call is made.
     */
    async recordMaterial(userId, courseId, material) {
      const kind = String(material?.kind ?? '');
      const mime = String(material?.mime_type ?? '');
      const key = String(material?.cos_key ?? '').trim();
      if (!MATERIAL_KINDS.includes(kind)) throw err(400, '素材类型不支持');
      if (!MATERIAL_MIME_TYPES.includes(mime)) throw err(400, '文件类型不支持');
      if (!key) throw err(400, '缺少对象键');
      // materials.course_id is NOT NULL in DATABASE.md §2, so unlike the JSON
      // tier this store cannot hold a course-less material. Refused with a 400
      // rather than allowed to become a 23502 at insert time.
      if (!isUuid(courseId)) throw err(400, '缺少课程');
      return asUser(userId, async (c) => {
        // materials_owner's WITH CHECK already refuses a course that is not
        // hers — but it refuses with 42501, a raw error carrying no status, and
        // the interface promises 404 (the JSON tier raises it directly). Asked
        // first so the two tiers answer the same thing; the policy stays as the
        // guarantee behind it, exactly as everywhere else in this file.
        const { rows: own } = await c.query(
          'SELECT id FROM courses WHERE id = $1 AND user_id = $2', [courseId, userId],
        );
        if (!own[0]) throw err(404, '课程不存在');
        const { rows } = await c.query(
          `INSERT INTO materials (course_id, user_id, kind, cos_key, mime_type, size_bytes,
                                  exif_stripped, contains_children, retention_until)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id, course_id, user_id, kind, cos_key, mime_type, size_bytes,
                     exif_stripped, contains_children, retention_until::text AS retention_until,
                     created_at`,
          [
            courseId, userId, kind, key, mime,
            Number(material?.size_bytes ?? 0) || 0,
            Boolean(material?.exif_stripped),
            Boolean(material?.contains_children),
            material?.retention_until ?? null,
          ],
        );
        const r = rows[0];
        return { ...r, size_bytes: int(r.size_bytes), created_at: iso(r.created_at) };
      });
    },

    /** Owner-scoped list; optionally one course. */
    async listMaterials(userId, courseId) {
      if (courseId != null && !isUuid(courseId)) return [];
      return asUser(userId, async (c) => {
        const { rows } = await c.query(
          `SELECT id, course_id, user_id, kind, cos_key, mime_type, size_bytes,
                  exif_stripped, contains_children, retention_until::text AS retention_until, created_at
             FROM materials
            WHERE user_id = $1 AND ($2::uuid IS NULL OR course_id = $2)
            ORDER BY created_at DESC`,
          [userId, courseId ?? null],
        );
        return rows.map((r) => ({ ...r, size_bytes: int(r.size_bytes), created_at: iso(r.created_at) }));
      });
    },

    // ============ per-account model-key vault (ciphertext only) ============
    // The store never sees plaintext: serve.mjs encrypts and decrypts through
    // key-vault.mjs. These rows are joined by no export path — the admin
    // console, adminExportAll and the course record never touch user_keys.

    /** Save/replace (blob string) or delete (null) one provider's ciphertext. */
    async setUserKey(userId, provider, blobOrNull) {
      if (!isUuid(userId)) throw err(404, '用户不存在');
      if (blobOrNull) {
        await q(
          `INSERT INTO user_keys (user_id, provider, ciphertext) VALUES ($1, $2, $3)
           ON CONFLICT (user_id, provider) DO UPDATE
             SET ciphertext = EXCLUDED.ciphertext, updated_at = now()`,
          [userId, String(provider), String(blobOrNull)],
        );
      } else {
        await q('DELETE FROM user_keys WHERE user_id = $1 AND provider = $2', [userId, String(provider)]);
      }
      return true;
    },

    /** @returns {Promise<Object>} { provider: ciphertext } — a fresh object
     * every call, so the vault is not editable by accident. */
    async getUserKeys(userId) {
      if (!isUuid(userId)) return {};
      const { rows } = await q('SELECT provider, ciphertext FROM user_keys WHERE user_id = $1', [userId]);
      return Object.fromEntries(rows.map((r) => [r.provider, r.ciphertext]));
    },

    // ================= rate-gate persistence (opaque blob) =================

    async loadRateState() {
      const { rows } = await q('SELECT value FROM app_state WHERE key = $1', [RATE_STATE_KEY]);
      return rows[0]?.value ?? null;
    },

    async saveRateState(state) {
      await q(
        `INSERT INTO app_state (key, value) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [RATE_STATE_KEY, JSON.stringify(state ?? {})],
      );
    },

    // ================= sessions =================

    async createSession(userId, userAgent) {
      const token = sessionToken();
      const sid = sessionSid();
      // Expiry computed in JavaScript and bound as a timestamp, not as an SQL
      // interval expression: one arithmetic, shared with the JSON tier, and no
      // dependence on how a unit string parses.
      await q(
        `INSERT INTO sessions (token, sid, user_id, expires_at, user_agent)
         VALUES ($1, $2, $3, $4::timestamptz, $5)`,
        [
          token, sid, userId,
          new Date(Date.now() + SESSION_TTL_MS).toISOString(),
          String(userAgent ?? '').slice(0, 200),
        ],
      );
      return { token, sid };
    },

    /** Resolve a cookie token → { user, session } or null. Rolling expiry. */
    async getSessionUser(token) {
      if (!token) return null;
      const { rows } = await q(
        `SELECT s.sid, s.user_id, s.last_seen_at, u.*
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
        [token],
      );
      const r = rows[0];
      if (!r || r.status !== 'active') return null;
      if (Date.now() - new Date(r.last_seen_at).getTime() > SESSION_BUMP_MS) {
        await q(
          `UPDATE sessions SET last_seen_at = now(), expires_at = $2::timestamptz WHERE token = $1`,
          [token, new Date(Date.now() + SESSION_TTL_MS).toISOString()],
        );
      }
      return { user: sanitizeUser(r), session: { sid: r.sid } };
    },

    /** Device list — public sids only, never bearer tokens: 用户中心 renders
     * this list, and a token in it is a token in the DOM. */
    async listSessions(userId, currentToken) {
      if (!isUuid(userId)) return [];
      const { rows } = await q(
        `SELECT sid, created_at, last_seen_at, user_agent, (token = $2) AS current
           FROM sessions
          WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
          ORDER BY created_at`,
        [userId, currentToken ?? null],
      );
      return rows.map((r) => ({
        sid: r.sid, created_at: iso(r.created_at), last_seen_at: iso(r.last_seen_at),
        user_agent: r.user_agent, current: Boolean(r.current),
      }));
    },

    async revokeSession(userId, sid) {
      if (!isUuid(userId)) return false;
      const r = await q(
        'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND sid = $2 AND revoked_at IS NULL',
        [userId, sid],
      );
      return r.rowCount > 0;
    },

    async revokeByToken(token) {
      if (!token) return false;
      const r = await q(
        'UPDATE sessions SET revoked_at = now() WHERE token = $1 AND revoked_at IS NULL', [token],
      );
      return r.rowCount > 0;
    },

    // ================= audit =================

    /** Every admin action on another user leaves a row. */
    async audit(adminId, action, targetUser, detail) {
      await appendAuditRow(null, adminId, action, targetUser, detail);
    },

    async listAudit({ limit = 100 } = {}) {
      const { rows } = await q(
        `SELECT id, admin_id, action, target_user, detail, created_at
           FROM admin_audit ORDER BY id DESC LIMIT $1`, [limit],
      );
      return rows.map((r) => ({
        id: int(r.id), admin_id: r.admin_id ?? null, action: r.action,
        target_user: r.target_user ?? null, detail: r.detail ?? null,
        created_at: iso(r.created_at),
      }));
    },

    // ================= scope shell log (ADR-0012 §3) =================
    // Warn-only mode is only useful if somebody READS the would-refuse rows, so
    // they are persisted rather than left in journalctl. The matched rule and a
    // short excerpt — enough to judge a false block — never the whole message,
    // which would put teacher content in an ops log.

    /** One scope verdict. THE 60-CHARACTER CAP IS THE INTERFACE'S, not this
     * implementation's: scope_log.excerpt also carries a CHECK, so a caller
     * that forgets to truncate gets a rejected INSERT rather than a teacher's
     * sentence at rest in an ops table. */
    async logScope(row) {
      const values = [
        String(row?.rule ?? ''),
        Boolean(row?.enforced),
        Boolean(row?.refused),
        // CODE POINTS, not UTF-16 units. Postgres `length()` counts characters,
        // so `.slice(0, 60)` on a message containing an astral character can
        // pass the JavaScript cap and be rejected by the CHECK — and it can cut
        // a surrogate pair in half on the way. Two caps that count different
        // things are one cap that sometimes lies.
        Array.from(String(row?.excerpt ?? '')).slice(0, 60).join(''),
      ];
      const sql = `INSERT INTO scope_log (user_id, rule, enforced, refused, excerpt)
                   VALUES ($1, $2, $3, $4, $5)`;
      const userId = row?.userId ?? null;
      if (isUuid(userId)) {
        // Attributed rows go in under the policy, as her: scope_log_owner's
        // WITH CHECK requires the row to name the connected user.
        await asUser(userId, (c) => c.query(sql, [userId, ...values]));
        return undefined;
      }
      // Unattributed rows cannot: 003_rls.sql refuses a NULL user_id from
      // app_rw on purpose, so 「a loud failure is the cheaper mistake」. But the
      // scope shell also fires BEFORE a session exists (that is the point of a
      // shell), and dropping those verdicts would hide exactly the traffic
      // warn-only mode exists to measure — so they are written on the admin
      // connection instead. Recorded here because it is a tension, not a
      // detail: if 003 ever gains a policy for unattributed rows, delete this.
      await q(sql, [null, ...values]);
      return undefined;
    },

    /** Newest first, plus a per-rule tally — the shape the admin tab wants. */
    async listScope({ limit = 200 } = {}) {
      const [page, tally, total] = await Promise.all([
        q(`SELECT id, rule, enforced, refused, excerpt, user_id, created_at
             FROM scope_log ORDER BY id DESC LIMIT $1`, [limit]),
        q('SELECT rule, count(*)::int AS n FROM scope_log GROUP BY rule'),
        q('SELECT count(*)::int AS n FROM scope_log'),
      ]);
      return {
        rows: page.rows.map((r) => ({
          id: int(r.id), rule: r.rule, enforced: r.enforced, refused: r.refused,
          excerpt: r.excerpt, user_id: r.user_id ?? null, created_at: iso(r.created_at),
        })),
        total: total.rows[0].n,
        byRule: Object.fromEntries(tally.rows.map((r) => [r.rule, r.n])),
      };
    },

    // ================= admin console reads (data tab) =================
    // ADR-0013 §7: admins keep full read access, and every content read appends
    // a line to the access log. The log is the compensating control for that
    // reach — a console that reads without logging is not the design. It lives
    // in access-log.mjs, at the endpoint, because only the endpoint knows who
    // asked.

    async adminListCourses() {
      // course_plan alone, never the whole state document: this is the scanning
      // view, and pulling every course's full JSONB to count four nodes is how
      // an admin page becomes the slowest thing on the server.
      const { rows } = await q(
        `SELECT c.id, c.user_id, c.title, c.state_version, c.created_at, c.updated_at,
                c.course_state->'course_plan'            AS course_plan,
                c.course_state->'course_plan_blueprint'  AS blueprint,
                u.username, u.display_name, u.settings->'profile' AS profile,
                (SELECT count(*)::int FROM messages m WHERE m.course_id = c.id)         AS messages,
                (SELECT count(*)::int FROM course_snapshots s WHERE s.course_id = c.id) AS snapshots,
                (SELECT coalesce(jsonb_object_agg(t.subject, t.n), '{}'::jsonb)
                   FROM (SELECT subject, count(*) AS n FROM messages m
                          WHERE m.course_id = c.id GROUP BY subject) t)                 AS messages_by_subject
           FROM courses c LEFT JOIN users u ON u.id = c.user_id
          ORDER BY c.updated_at DESC`,
      );
      return rows.map((r) => ({
        id: r.id, user_id: r.user_id, title: r.title,
        username: r.username ?? null, display_name: r.display_name ?? null,
        profile: r.profile ?? null,
        state_version: r.state_version,
        created_at: iso(r.created_at), updated_at: iso(r.updated_at),
        messages: r.messages, snapshots: r.snapshots,
        blueprint_version: r.blueprint?.version ?? null,
        blueprint_modules: r.blueprint?.modules?.length ?? 0,
        // 「哪些课程有计划」 and 「有多少被标了待复查」 are exactly the questions
        // the staleness stamp exists to answer, and they were invisible at
        // scanning level until they were counted here.
        plan_version: r.course_plan?.version ?? null,
        plan_nodes: countPlanNodes(r.course_plan),
        plan_stale_nodes: countPlanNodes(r.course_plan, (n) => Boolean(n.stale_since)),
        messages_by_subject: r.messages_by_subject ?? {},
      }));
    },

    async adminGetCourse(courseId) {
      if (!isUuid(courseId)) return null;
      const { rows } = await q('SELECT * FROM courses WHERE id = $1', [courseId]);
      return rows[0] ? fullCourseRecord(rows[0]) : null;
    },

    /** The console's cross-teacher delete (ADR-0013 §7). Same object-first
     * ordering — an admin delete must not be the path that orphans a photo. */
    async adminDelete(courseId, { deleteObject = null } = {}) {
      if (!isUuid(courseId)) return { deleted: false, cos_keys: [], objects_deleted: false };
      return deleteCourseWithObjects(courseId, null, deleteObject);
    },

    async adminExportAll() {
      const { rows } = await q('SELECT * FROM courses ORDER BY updated_at DESC');
      // Sequential rather than Promise.all: an export of every course on the
      // instance is a background operation, and firing three queries per course
      // at once is how one export exhausts the pool the teachers are using.
      const out = [];
      for (const row of rows) out.push(await fullCourseRecord(row));
      return out;
    },

    // ================= lifecycle =================

    /** Release the pools. Tests call it through the contract's dispose hook;
     * the server never does, because it holds them for its lifetime. */
    async close() {
      await rwPool.end();
      if (adminPool !== rwPool) await adminPool.end();
    },
  };

  return api;
}
