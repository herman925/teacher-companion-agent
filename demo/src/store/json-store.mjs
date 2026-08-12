// json-store.mjs — JSON-file implementation of the demo persistence tier
// (DATABASE.md §4). Courses: one file each under <base>/courses/. Auth
// (SECURITY.md): users/sessions/audit as single JSON files under <base>/auth/.
// Zero-dep; a pg-store.mjs will later implement the SAME interface (store.mjs).
//
// Not for production child data: plain files on disk. The .data dir is
// gitignored (child-data non-negotiable #4).

import { readFile, writeFile, mkdir, readdir, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createInitialState } from '../engine.mjs';
import { hashPassword, verifyPassword, tempPassword, sessionToken, sessionSid } from '../auth-util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASE = path.join(HERE, '..', '..', '.data');

const MAX_COURSES_PER_USER = 30;   // abuse guard (DATABASE.md §2)
const CHECKPOINT_EVERY = 20;       // full-document snapshot cadence (DATABASE.md §2)
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days, rolling
const SESSION_BUMP_MS = 60 * 60 * 1000;            // extend at most hourly

const nowISO = () => new Date().toISOString();
const err = (status, message) => Object.assign(new Error(message), { status });

export const TITLE_MAX = 16; // a rail row, not a sentence (DESIGN.md §4)
// Scope-log ring size. Enough to judge a week of traffic before enforcing,
// small enough that the file stays readable and bounded.
export const SCOPE_LOG_MAX = 2000;
const DEFAULT_TITLE = '新课程';

// Message subjects (ADR-0010 §1). One log per course; the subject is a tag,
// never a container — see normalizeSubject below for why the default matters.
export const COURSE_SUBJECT = 'course';
const SUBJECT_MAX = 120; // a node id, not prose; same cap as a workbench row id

// ---- the three account states (ADR-0013 §11, DATABASE.md §5b) ----
// active / revoked / erased are three OPERATIONS for three situations, not
// points on a scale. Revoke refuses login and KEEPS the data, because the
// kindergarten may still need last year's curriculum. Erase is the deletion
// request and takes everything. Conflating them is the mistake DATABASE.md
// §2 spends a CHECK constraint on.
export const ACCOUNT_STATES = Object.freeze(['active', 'revoked', 'erased']);

const DAY_MS = 24 * 60 * 60 * 1000;

// Default retention window for revoked accounts: 365 days, the ADR's 12
// months. CONFIGURATION, NOT A CONSTANT — dueForErasure takes the window as an
// argument so the pilot's compliance answer can set it. ADR-0013 records the
// real value as still open; 365 is a defensible placeholder, not a legal
// opinion, and nothing here should read as one.
export const DEFAULT_ERASURE_WINDOW_DAYS = 365;

// Materials are LighthouseCOS references, never bytes (ADR-0013 §6). Both
// allowlists mirror the CHECK constraints in DATABASE.md §2: reject by
// default, never blocklist.
export const MATERIAL_KINDS = Object.freeze(['photo', 'observation', 'document', 'generated']);
export const MATERIAL_MIME_TYPES = Object.freeze([
  'application/pdf', 'image/jpeg', 'image/png',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

// Row-shaped, user-scoped collections in this tier, relative to baseDir. Each
// is a flat array of rows carrying `user_id`, mirroring the tables of the same
// name in DATABASE.md §2, and erasure sweeps every one of them. Exported
// because the list IS the contract: whoever implements facts, classes or
// interaction signals in the JSON tier must write here, or their rows survive
// an erase and nobody finds out until an audit does.
export const USER_SCOPED_FILES = Object.freeze([
  'materials.json', 'facts.json', 'interaction-signals.json', 'classes.json',
]);

/**
 * Epoch milliseconds from a Date, a number, or an ISO string; NaN when the
 * value cannot be read as a time.
 * @param {unknown} v
 * @returns {number}
 */
function toMillis(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string') return Date.parse(v);
  return NaN;
}

/**
 * Is this user row past its retention window? Pure, so the retention policy is
 * testable without a clock or a file (DATABASE.md §5b).
 *
 * A `revoked` row with no `revoked_at` is a data defect, not an old account:
 * the clock never started, so we do not know when the window opened. Guessing
 * a date would erase early and erasure is irreversible, so such a row is never
 * due — it stays visible in listUsers as revoked-without-a-date instead.
 *
 * @param {{status?: string, revoked_at?: string|null}|null|undefined} user
 * @param {Date|number|string} nowMs
 * @param {number} [windowDays]
 * @returns {boolean}
 */
export function isDueForErasure(user, nowMs, windowDays = DEFAULT_ERASURE_WINDOW_DAYS) {
  const now = toMillis(nowMs);
  if (!Number.isFinite(now)) throw new Error('isDueForErasure: now must be a Date, epoch ms or ISO string');
  if (!user || user.status !== 'revoked') return false;
  const at = toMillis(user.revoked_at);
  if (!Number.isFinite(at)) return false;
  return now - at >= windowDays * DAY_MS;
}

/**
 * Normalize a message subject: the string 'course', or a node id.
 * Anything absent, blank or not a string becomes 'course', and that default is
 * the whole reason the tag is additive — every message written before subjects
 * existed reads back as course-level, so there is no migration (ADR-0010 §1).
 * The value stays opaque: the store does not know the node-id grammar and must
 * not invent one.
 * @param {unknown} subject
 * @returns {string}
 */
export function normalizeSubject(subject) {
  if (typeof subject !== 'string') return COURSE_SUBJECT;
  return subject.replace(/\s+/g, ' ').trim().slice(0, SUBJECT_MAX) || COURSE_SUBJECT;
}

/**
 * Short course-name-like title from state (pure; DATABASE.md §4 auto-titling).
 * Prefers the theme the model extracted (醒狮, 龙舟…); falls back to the first
 * teacher message, hard-trimmed. Returns null when nothing usable exists.
 * @param {Object|null} state @param {string} [fallbackText]
 */
export function deriveCourseTitle(state, fallbackText) {
  const theme = String(state?.theme_resource?.name ?? '').replace(/\s+/g, ' ').trim();
  if (theme) return theme.slice(0, TITLE_MAX);
  const fb = String(fallbackText ?? '').replace(/\s+/g, ' ').trim();
  if (fb) return fb.slice(0, TITLE_MAX);
  return null;
}

/**
 * Count plan-tree nodes, optionally only those matching a predicate. Iterative
 * so a hand-edited course file with a deep tree cannot blow the stack inside an
 * admin read — the console must never be the thing that goes down.
 * @param {{roots?: Array<Object>}|null|undefined} plan `course_state.course_plan`
 * @param {(node: Object) => boolean} [match] counted when it returns true
 * @returns {number}
 */
export function countPlanNodes(plan, match) {
  const stack = Array.isArray(plan?.roots) ? [...plan.roots] : [];
  let n = 0;
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (!match || match(node)) n += 1;
    for (const c of Array.isArray(node.children) ? node.children : []) stack.push(c);
  }
  return n;
}

/**
 * Tally rows by a key function. `{}` for an empty log rather than null, so a
 * console column can render 「no messages yet」 apart from 「field missing」.
 * @param {Array<Object>|null|undefined} rows
 * @param {(row: Object) => string} keyOf
 * @returns {Record<string, number>}
 */
export function tallyBy(rows, keyOf) {
  const out = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const k = keyOf(row);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/** @param {{ baseDir?: string }} [opts] baseDir override is for tests. */
export function createJsonStore(opts = {}) {
  const BASE = opts.baseDir ?? DEFAULT_BASE;
  const COURSE_DIR = path.join(BASE, 'courses');
  const AUTH_DIR = path.join(BASE, 'auth');

  // All mutations serialize through one promise chain — the demo is one
  // process with sequential turns, so this keeps read-modify-write safe.
  let chain = Promise.resolve();
  function withLock(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
  }

  async function writeAtomic(file, data) {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await rename(tmp, file);
  }
  async function readJson(file, fallback) {
    try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
  }

  // ---- courses ----
  const coursePath = (id) => path.join(COURSE_DIR, `${encodeURIComponent(id)}.json`);
  const readCourse = (id) => readJson(coursePath(id), null);
  const writeCourse = (c) => writeAtomic(coursePath(c.id), c);
  const brief = (c) => ({ id: c.id, title: c.title, state_version: c.state_version, updated_at: c.updated_at });

  async function allCourses() {
    let files = [];
    try { files = await readdir(COURSE_DIR); } catch { files = []; }
    const out = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const c = await readJson(path.join(COURSE_DIR, f), null);
      if (c) out.push(c);
    }
    return out;
  }

  // ---- auth files ----
  const usersFile = path.join(AUTH_DIR, 'users.json');
  const sessionsFile = path.join(AUTH_DIR, 'sessions.json');
  const auditFile = path.join(AUTH_DIR, 'audit.json');
  const scopeFile = path.join(AUTH_DIR, 'scope-log.json'); // ADR-0012 §3 would-refuse log
  const keysFile = path.join(AUTH_DIR, 'keys.json');         // { userId: { provider: ciphertext } }
  const rateFile = path.join(AUTH_DIR, 'rate-limits.json');  // rate-gate state blob
  // User-scoped row collections (USER_SCOPED_FILES above). They sit beside the
  // courses rather than under auth/ because they are course-and-teacher data,
  // not credentials.
  const materialsFile = path.join(BASE, 'materials.json');
  const factsFile = path.join(BASE, 'facts.json');
  const signalsFile = path.join(BASE, 'interaction-signals.json');
  const classesFile = path.join(BASE, 'classes.json');
  const readUsers = () => readJson(usersFile, []);
  const readSessions = () => readJson(sessionsFile, []);
  /** Public shape: never the password hash. `revoked_at` rides along because
   * new state must be observable (AGENTS.md) — a retention clock nobody can
   * see in the console is a clock nobody checks. */
  const sanitizeUser = (u) => u && {
    id: u.id, username: u.username, display_name: u.display_name, role: u.role,
    status: u.status, must_change_password: Boolean(u.must_change_password),
    display_name_changed_at: u.display_name_changed_at ?? null,
    created_at: u.created_at, last_login_at: u.last_login_at ?? null,
    revoked_at: u.revoked_at ?? null,
    profile: u.settings?.profile ?? null,
  };

  // ---- internals shared by the account-state operations ----
  // These do NOT take the lock. withLock is one promise chain, so a nested
  // acquire would wait for a lock only its own caller can release; every one of
  // these runs inside an already-locked section.

  /** Append one admin-audit row. The public audit() wraps this in the lock. */
  async function appendAuditRow(adminId, action, targetUser, detail) {
    const rows = await readJson(auditFile, []);
    rows.push({
      id: rows.length + 1, admin_id: adminId ?? null, action,
      target_user: targetUser ?? null, detail: detail ?? null, created_at: nowISO(),
    });
    await writeAtomic(auditFile, rows);
  }

  /** Revoke every live session of one user. @returns how many died. */
  async function killSessions(userId) {
    const sessions = await readSessions();
    let n = 0;
    for (const s of sessions) {
      if (s.user_id === userId && !s.revoked_at) { s.revoked_at = nowISO(); n += 1; }
    }
    if (n) await writeAtomic(sessionsFile, sessions);
    return n;
  }

  /**
   * Mark one user row revoked and start the retention clock. Idempotent on the
   * stamp: a second revoke must not move `revoked_at` forward, or every click
   * of the button would restart the window and 「revoked」 would quietly become
   * 「kept forever」 — the outcome minimal retention exists to prevent.
   */
  function stampRevocation(u) {
    u.status = 'revoked';
    if (!u.revoked_at) u.revoked_at = nowISO();
  }

  /** Drop every row of one user from a flat user-scoped file. @returns count. */
  async function purgeUserRows(file, userId) {
    const rows = await readJson(file, null);
    if (!Array.isArray(rows)) return 0;      // absent file: nothing to erase, not an error
    const kept = rows.filter((r) => r?.user_id !== userId);
    const removed = rows.length - kept.length;
    if (removed) await writeAtomic(file, kept);
    return removed;
  }

  /**
   * Delete one course, its objects and its material rows, in the one order
   * that cannot orphan a photograph. Shared by the teacher path and the admin
   * console so the ordering cannot drift between them.
   *
   * The object deletion runs OUTSIDE the write lock, exactly as `eraseInternal`
   * does: a network call to object storage must not hold the store's lock, and
   * a throw there must leave every row intact so the operation can be repeated.
   *
   * @param {string} courseId
   * @param {((cosKey: string) => Promise<void>|void)|null} deleteObject
   * @returns {Promise<{deleted: boolean, cos_keys: string[], objects_deleted: boolean}>}
   */
  async function deleteCourseInternal(courseId, deleteObject) {
    const rows = await withLock(async () => {
      const all = await readJson(materialsFile, []);
      return (Array.isArray(all) ? all : []).filter((m) => m?.course_id === courseId);
    });
    const cosKeys = [...new Set(rows.map((m) => m?.cos_key).filter((k) => typeof k === 'string' && k))];

    // OBJECTS BEFORE ROWS — the same rule, and the same reason, as eraseUser.
    if (typeof deleteObject === 'function') {
      for (const key of cosKeys) await deleteObject(key);
    }

    return withLock(async () => {
      const c = await readCourse(courseId);
      if (!c) return { deleted: false, cos_keys: cosKeys, objects_deleted: typeof deleteObject === 'function' };
      const all = await readJson(materialsFile, []);
      const kept = (Array.isArray(all) ? all : []).filter((m) => m?.course_id !== courseId);
      if (kept.length !== (Array.isArray(all) ? all.length : 0)) await writeAtomic(materialsFile, kept);
      await unlink(coursePath(courseId)).catch(() => {});
      return { deleted: true, cos_keys: cosKeys, objects_deleted: typeof deleteObject === 'function' };
    });
  }

  /**
   * Erase one account: everything goes (ADR-0013 §11, DATABASE.md §5b).
   * Ordering is the whole design, so it is spelled out where it happens.
   * @param {string|null} adminId who asked
   * @param {string} userId
   * @param {((cosKey: string) => Promise<void>|void)|null} deleteObject
   */
  async function eraseInternal(adminId, userId, deleteObject) {
    const users = await readUsers();
    const u = users.find((x) => x.id === userId);
    if (!u) throw err(404, '用户不存在');

    const courses = (await allCourses()).filter((c) => c.user_id === userId);
    const materialRows = await readJson(materialsFile, []);
    const mine = (Array.isArray(materialRows) ? materialRows : []).filter((m) => m?.user_id === userId);
    // Keys are collected from the materials registry AND from any list a course
    // file carries: a key recorded in one place and swept from the other is
    // exactly the orphaned child photo ADR-0013 §6 designs against.
    const cosKeys = [...new Set([
      ...mine.map((m) => m?.cos_key),
      ...courses.flatMap((c) => (Array.isArray(c.materials) ? c.materials : []).map((m) => m?.cos_key)),
    ].filter((k) => typeof k === 'string' && k.length > 0))];

    // OBJECTS BEFORE ROWS. A deleted row is a lost key, and a lost key is a
    // child photo nobody can find to delete. So the bucket goes first, and a
    // throw here aborts with every row still intact — a half-run erase can be
    // repeated, an orphaned object cannot be found again.
    // This store owns no COS client, so the caller injects the deleter. Without
    // one, the keys ride back in the receipt and deleting them is the caller's
    // obligation — stated, not assumed.
    if (typeof deleteObject === 'function') {
      for (const key of cosKeys) await deleteObject(key);
    }

    // Sessions first among the rows: an open session must stop resolving before
    // its data starts disappearing, so no request can read a half-erased
    // account.
    await writeAtomic(sessionsFile, (await readSessions()).filter((s) => s.user_id !== userId));

    const materials = await purgeUserRows(materialsFile, userId);

    // Courses carry their messages and snapshots inside the same file in this
    // tier, so one unlink is three tables in the Postgres shape. A pg-store
    // deletes them as separate statements in this same order.
    let messages = 0;
    let snapshots = 0;
    for (const c of courses) {
      messages += (c.messages || []).length;
      snapshots += (c.snapshots || []).length;
      await unlink(coursePath(c.id)).catch(() => {});
    }

    const facts = await purgeUserRows(factsFile, userId);
    const signals = await purgeUserRows(signalsFile, userId);

    // Vaulted keys must not outlive the account (ADR-0005).
    const keyRows = await readJson(keysFile, {});
    const keyProviders = Object.keys(keyRows?.[userId] ?? {}).length;
    if (keyRows?.[userId]) { delete keyRows[userId]; await writeAtomic(keysFile, keyRows); }

    const classes = await purgeUserRows(classesFile, userId);

    // The scope log keeps its ROWS and loses the PERSON: operational history
    // survives, the subject does not (ADR-0013 §11).
    const scopeRows = await readJson(scopeFile, []);
    let scopeNulled = 0;
    for (const r of Array.isArray(scopeRows) ? scopeRows : []) {
      if (r?.user_id === userId) { r.user_id = null; scopeNulled += 1; }
    }
    if (scopeNulled) await writeAtomic(scopeFile, scopeRows);

    // Same treatment for the admin audit: the action stays visible, its subject
    // does not. `admin_id` is deliberately NOT nulled — accountability for what
    // an admin did has to survive; it is the erased person who goes.
    const auditRows = await readJson(auditFile, []);
    let auditNulled = 0;
    for (const r of Array.isArray(auditRows) ? auditRows : []) {
      if (r?.target_user === userId) { r.target_user = null; auditNulled += 1; }
    }
    if (auditNulled) await writeAtomic(auditFile, auditRows);

    // Rate-limit counters are deliberately left alone. They are keyed by
    // identifier rather than by person, they expire on their own window, and
    // clearing them would hand an attacker a free counter reset by asking for
    // an erase. The rate gate also holds that blob in memory and flushes on a
    // debounce, so a write from here would be overwritten anyway.

    await writeAtomic(usersFile, users.filter((x) => x.id !== userId));

    // The erase row names NO subject: recording who was erased in the log that
    // outlives the erasure would defeat it. Counts are what an operator needs
    // in order to see that it ran.
    const deleted = {
      courses: courses.length, messages, snapshots, materials,
      facts, interaction_signals: signals, classes, key_providers: keyProviders,
    };
    await appendAuditRow(adminId, 'erase_user', null, {
      ...deleted,
      objects: cosKeys.length,
      objects_deleted: typeof deleteObject === 'function',
      scope_log_nulled: scopeNulled, audit_subjects_nulled: auditNulled,
    });

    return {
      // The username rides back in the RESPONSE — the admin who asked needs to
      // see which account went — and is written to no file.
      username: u.username,
      cos_keys: cosKeys,
      objects_deleted: typeof deleteObject === 'function',
      deleted, scope_log_nulled: scopeNulled, audit_subjects_nulled: auditNulled,
    };
  }

  return {
    // ================= courses (unchanged interface) =================

    async listCourses(userId) {
      return withLock(async () => {
        const out = (await allCourses()).filter((c) => c.user_id === userId).map(brief);
        out.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
        return out;
      });
    },

    async createCourse(userId, title) {
      return withLock(async () => {
        const count = (await allCourses()).filter((c) => c.user_id === userId).length;
        if (count >= MAX_COURSES_PER_USER) throw err(409, `最多 ${MAX_COURSES_PER_USER} 个课程`);
        const id = randomUUID();
        const ts = nowISO();
        const course = {
          id, user_id: userId,
          title: (title && String(title).trim()) || '新课程',
          course_state: createInitialState(id),
          state_version: 0, created_at: ts, updated_at: ts,
          next_message_id: 1, messages: [], snapshots: [],
        };
        await writeCourse(course);
        return brief(course);
      });
    },

    async getCourse(userId, courseId) {
      return withLock(async () => {
        const c = await readCourse(courseId);
        if (!c || c.user_id !== userId) return null;
        return {
          id: c.id, title: c.title, course_state: c.course_state,
          state_version: c.state_version, created_at: c.created_at, updated_at: c.updated_at,
        };
      });
    },

    /**
     * Rename (owner only). Human renames set title_locked so auto-titling
     * never overwrites a person's choice; auto renames leave it unlocked.
     */
    async renameCourse(userId, courseId, title, { auto = false } = {}) {
      return withLock(async () => {
        const c = await readCourse(courseId);
        if (!c || c.user_id !== userId) throw err(404, '课程不存在');
        if (auto && c.title_locked) return brief(c);            // human choice wins
        const t = String(title ?? '').replace(/\s+/g, ' ').trim();
        if (!t || t.length > TITLE_MAX) throw err(400, `课程名需为 1–${TITLE_MAX} 个字符`);
        c.title = t;
        if (!auto) c.title_locked = true;
        c.updated_at = nowISO();
        await writeCourse(c);
        return brief(c);
      });
    },

    /** Teacher ✓确认 of one blueprint node — engine applies, version rides
     * state_version so replay/audit sees the confirmation as a revision. */
    async confirmBlueprintNode(userId, courseId, nodeId, engineConfirm) {
      return withLock(async () => {
        const c = await readCourse(courseId);
        if (!c || c.user_id !== userId) throw err(404, '课程不存在');
        const r = engineConfirm(c.course_state, nodeId);
        if (!r.confirmed) throw err(400, '节点不存在或已是已确认');
        c.course_state = r.state;
        c.state_version += 1;
        c.snapshots = c.snapshots || [];
        c.snapshots.push({ state_version: c.state_version, state_delta: { blueprint_confirm: nodeId }, is_checkpoint: false, created_at: nowISO() });
        c.updated_at = nowISO();
        await writeCourse(c);
        return c.course_state.course_plan_blueprint;
      });
    },

    /** Mirror of the teacher's unsent 工作台 state — per-node 批注 + the
     * living question-card answers (DESIGN.md §5c). Scratch, not history:
     * no state_version bump, no snapshot row; admin exports simply show
     * work-in-progress alongside what was actually sent. */
    async setWorkbench(userId, courseId, workbench) {
      return withLock(async () => {
        const c = await readCourse(courseId);
        if (!c || c.user_id !== userId) throw err(404, '课程不存在');
        const s = (v, max) => String(v ?? '').slice(0, max);
        const comments = (Array.isArray(workbench?.blueprint_comments) ? workbench.blueprint_comments : [])
          .slice(0, 200)
          .map((r) => ({ id: s(r?.id, 120), number: s(r?.number, 20), title: s(r?.title, 200), text: s(r?.text, 500) }));
        const qc = workbench?.question_cards;
        const cards = qc && Array.isArray(qc.questions) ? {
          questions: qc.questions.slice(0, 50).map((q) => ({ text: s(q?.text, 500), ...(q?.why ? { why: s(q.why, 500) } : {}) })),
          answers: (Array.isArray(qc.answers) ? qc.answers : []).slice(0, 50)
            .map((a) => ({ value: s(a?.value, 2000), skipped: Boolean(a?.skipped), locked: Boolean(a?.locked) })),
        } : null;
        c.workbench = { blueprint_comments: comments, question_cards: cards, updated_at: nowISO() };
        await writeCourse(c);
        return c.workbench;
      });
    },

    /** True when auto-titling should run: still on the default name, not human-locked. */
    async isUntitled(courseId) {
      return withLock(async () => {
        const c = await readCourse(courseId);
        return Boolean(c && !c.title_locked && c.title === DEFAULT_TITLE);
      });
    },

    /**
     * Whole-course erasure (data-subject deletion, DATABASE.md §4).
     *
     * ADR-0013 §6: 「Deleting a course deletes its objects. Orphaned child
     * photos in a bucket nobody tracks are the failure mode to design
     * against.」 The materials row is the ONLY record of an object key, so the
     * order is not negotiable: harvest the keys, delete the objects, THEN the
     * rows. Deleting the row first loses the key, and a lost key is a child
     * photo nobody can find to delete — which is why this returns the keys even
     * when it deleted the objects itself.
     *
     * @param {string} userId @param {string} courseId
     * @param {{deleteObject?: ((cosKey: string) => Promise<void>|void)|null}} [opts]
     * @returns {Promise<{deleted: boolean, cos_keys: string[], objects_deleted: boolean}>}
     *   `cos_keys` is what this course owned in the bucket. With no
     *   `deleteObject` injected they are the caller's obligation, stated rather
     *   than assumed.
     */
    async deleteCourse(userId, courseId, { deleteObject = null } = {}) {
      const owned = await withLock(async () => {
        const c = await readCourse(courseId);
        return Boolean(c && c.user_id === userId);
      });
      if (!owned) return { deleted: false, cos_keys: [], objects_deleted: false };
      return deleteCourseInternal(courseId, deleteObject);
    },

    /** Append one message (append-only). `msg.subject` tags it (ADR-0010 §1). */
    async appendMessage(courseId, msg) {
      return withLock(async () => {
        const c = await readCourse(courseId);
        if (!c) throw err(404, '课程不存在');
        const row = {
          id: c.next_message_id,
          role: msg.role, content: msg.content ?? '',
          // Read from the caller's own field and nowhere else: the subject is
          // engine-owned (ADR-0010 §2), so a `subject` the model happened to
          // put in its turn_contract rides along as record and is never used.
          subject: normalizeSubject(msg.subject),
          turn_contract: msg.turn_contract ?? null,
          provider: msg.provider ?? null, provider_label: msg.provider_label ?? null,
          usage: msg.usage ?? null, stage_name: msg.stage_name ?? null,
          // Observability duty (AGENTS.md): cache report + timeout-guard
          // events persist with the turn so admin exports carry them.
          cache: msg.cache ?? null, guards: msg.guards ?? null,
          created_at: nowISO(),
        };
        c.next_message_id += 1;
        c.messages.push(row);
        c.updated_at = row.created_at;
        await writeCourse(c);
        return row;
      });
    },

    async getMessages(courseId, { before, limit, subject } = {}) {
      return withLock(async () => {
        const c = await readCourse(courseId);
        if (!c) return [];
        let rows = c.messages.slice().sort((a, b) => a.id - b.id);
        // The subject filter is a view over the one ordered log, never a
        // partition: ids stay global, so 「she asked about 3.2.1 BEFORE she
        // edited 周2」 is still provable from a filtered read (ADR-0010 §1).
        // Rows stored before subjects existed carry none and read as 'course'.
        if (subject != null) {
          const want = normalizeSubject(subject);
          rows = rows.filter((r) => normalizeSubject(r.subject) === want);
        }
        if (before != null) rows = rows.filter((r) => r.id < before);
        if (limit != null) rows = rows.slice(-limit);
        return rows;
      });
    },

    /** Delta every version + full-document checkpoint (DATABASE.md §2); optimistic lock. */
    async saveState(courseId, delta, newState, expectedVersion) {
      return withLock(async () => {
        const c = await readCourse(courseId);
        if (!c) throw err(404, '课程不存在');
        if (expectedVersion != null && c.state_version !== expectedVersion) throw err(409, '状态版本冲突');
        const stageChanged = (c.course_state?.stage) !== (newState?.stage);
        const newVersion = c.state_version + 1;
        const isCheckpoint = newVersion % CHECKPOINT_EVERY === 0 || stageChanged || newVersion === 1;
        c.snapshots.push({
          state_version: newVersion, state_delta: delta ?? {},
          course_state: isCheckpoint ? newState : null,
          is_checkpoint: isCheckpoint, created_at: nowISO(),
        });
        c.course_state = newState;
        c.state_version = newVersion;
        c.updated_at = nowISO();
        await writeCourse(c);
        return { state_version: newVersion };
      });
    },

    // ================= users (SECURITY.md §3/§4) =================

    /** Admin-provisioned account; returns the one-time temp password. */
    async createUser({ username, displayName, role = 'teacher', createdBy = null }) {
      return withLock(async () => {
        const uname = String(username ?? '').trim().toLowerCase();
        if (!/^[a-z0-9_\-]{3,24}$/.test(uname)) throw err(400, '用户名需为 3–24 位小写字母、数字、_-');
        const users = await readUsers();
        if (users.some((u) => u.username === uname)) throw err(409, '用户名已存在');
        const dname = String(displayName ?? '').trim() || uname;
        if (users.some((u) => u.display_name === dname)) throw err(409, '昵称已被占用');
        const temp = tempPassword();
        const user = {
          id: randomUUID(), username: uname, display_name: dname,
          role: role === 'admin' ? 'admin' : 'teacher', status: 'active',
          password: hashPassword(temp), must_change_password: true,
          display_name_changed_at: null, created_at: nowISO(), created_by: createdBy,
          last_login_at: null, settings: {},
        };
        users.push(user);
        await writeAtomic(usersFile, users);
        return { user: sanitizeUser(user), temp_password: temp };
      });
    },

    async getUser(userId) {
      return withLock(async () => sanitizeUser((await readUsers()).find((u) => u.id === userId) ?? null));
    },

    async listUsers() {
      return withLock(async () => (await readUsers()).map(sanitizeUser));
    },

    /** Password login. @returns sanitized user or null (wrong creds / disabled).
     * Passwords are compared trimmed: temp passwords pasted out of chat apps
     * arrive with stray edge whitespace, and no stored password ever has any
     * (changePassword trims too). */
    async verifyLogin(username, password) {
      return withLock(async () => {
        const users = await readUsers();
        const u = users.find((x) => x.username === String(username ?? '').trim().toLowerCase());
        if (!u || u.status !== 'active' || !verifyPassword(String(password ?? '').trim(), u.password)) return null;
        u.last_login_at = nowISO();
        await writeAtomic(usersFile, users);
        return sanitizeUser(u);
      });
    },

    /** Self-service change (old verified) — clears must_change_password. */
    async changePassword(userId, oldPassword, newPassword) {
      return withLock(async () => {
        const users = await readUsers();
        const u = users.find((x) => x.id === userId);
        if (!u) throw err(404, '用户不存在');
        if (!verifyPassword(String(oldPassword ?? '').trim(), u.password)) throw err(403, '旧密码不对');
        const next = String(newPassword ?? '').trim();
        if (next.length < 8) throw err(400, '新密码至少 8 位');
        u.password = hashPassword(next);
        u.must_change_password = false;
        await writeAtomic(usersFile, users);
        return true;
      });
    },

    /** Admin reset — returns a fresh one-time temp password. */
    async resetPassword(userId) {
      return withLock(async () => {
        const users = await readUsers();
        const u = users.find((x) => x.id === userId);
        if (!u) throw err(404, '用户不存在');
        const temp = tempPassword();
        u.password = hashPassword(temp);
        u.must_change_password = true;
        await writeAtomic(usersFile, users);
        return temp;
      });
    },

    /** Uniqueness + persist + stamp. Rule checks (charset/profanity/6-month) are the caller's (auth-util). */
    async setDisplayName(userId, name) {
      return withLock(async () => {
        const users = await readUsers();
        const dname = String(name ?? '').trim();
        if (users.some((u) => u.display_name === dname && u.id !== userId)) throw err(409, '昵称已被占用');
        const u = users.find((x) => x.id === userId);
        if (!u) throw err(404, '用户不存在');
        u.display_name = dname;
        u.display_name_changed_at = nowISO();
        await writeAtomic(usersFile, users);
        return sanitizeUser(u);
      });
    },

    async saveUserProfile(userId, profile) {
      return withLock(async () => {
        const users = await readUsers();
        const u = users.find((x) => x.id === userId);
        if (!u) throw err(404, '用户不存在');
        u.settings = { ...(u.settings ?? {}), profile: profile ?? null };
        await writeAtomic(usersFile, users);
        return true;
      });
    },

    /** Admin: status/role changes. Anything that is not `active` also revokes
     * live sessions. `disabled` is the legacy spelling kept for the existing
     * console button; ADR-0013's three states are `active` / `revoked` /
     * `erased`, and `revoked` is the one that starts the retention clock —
     * a `disabled` row is never seen by dueForErasure. */
    async updateUser(userId, patch) {
      return withLock(async () => {
        const users = await readUsers();
        const u = users.find((x) => x.id === userId);
        if (!u) throw err(404, '用户不存在');
        if (patch.status && ['active', 'disabled', 'revoked'].includes(patch.status)) {
          if (patch.status === 'revoked') stampRevocation(u);
          else {
            u.status = patch.status;
            // Reinstatement stops the retention clock. Leaving the stamp would
            // hand the scheduled erasure job a live account to delete.
            if (patch.status === 'active') u.revoked_at = null;
          }
        }
        if (patch.role && ['admin', 'teacher'].includes(patch.role)) u.role = patch.role;
        await writeAtomic(usersFile, users);
        if (u.status !== 'active') await killSessions(userId);
        return sanitizeUser(u);
      });
    },

    // ================= the three account states (ADR-0013 §11) =================

    /**
     * REVOKE — the teacher left the school, or was banned. Login is refused
     * (verifyLogin and getSessionUser both require `active`), live sessions
     * die, and THE DATA STAYS: the kindergarten may still need last year's
     * curriculum. Stamping `revoked_at` starts the retention clock that
     * dueForErasure reads; a revocation without it would sit in the database
     * forever.
     * @param {string|null} adminId who asked — the audit row keeps it
     * @param {string} userId
     * @returns {Promise<Object>} the sanitized user
     */
    async revokeUser(adminId, userId) {
      return withLock(async () => {
        const users = await readUsers();
        const u = users.find((x) => x.id === userId);
        if (!u) throw err(404, '用户不存在');
        stampRevocation(u);
        await writeAtomic(usersFile, users);
        const killed = await killSessions(userId);
        await appendAuditRow(adminId, 'revoke_user', userId, {
          revoked_at: u.revoked_at, sessions_revoked: killed,
        });
        return sanitizeUser(u);
      });
    },

    /**
     * ERASE — everything goes. Used for alpha cleanup and for any deletion
     * request. Objects before rows; see eraseInternal, where the order lives.
     * @param {string|null} adminId
     * @param {string} userId
     * @param {{deleteObject?: ((cosKey: string) => Promise<void>|void)|null}} [opts]
     *   `deleteObject` removes one COS object. Provide it and the bucket is
     *   emptied before any row is touched, with a throw aborting the whole
     *   erase. Omit it and the receipt's `cos_keys` are the caller's to delete.
     * @returns {Promise<Object>} receipt: username, cos_keys, per-table counts
     */
    async eraseUser(adminId, userId, { deleteObject = null } = {}) {
      return withLock(() => eraseInternal(adminId, userId, deleteObject));
    },

    /**
     * Revoked accounts whose retention window has passed. RETURNS IDS AND
     * ERASES NOTHING — the caller decides, because erasure is irreversible and
     * a scheduled job that both finds and deletes has no step where a human
     * can look. The window is an argument, not a constant (DATABASE.md §5b).
     * @param {Date|number|string} [now]
     * @param {number} [windowDays]
     * @returns {Promise<Array<string>>} user ids
     */
    async dueForErasure(now = Date.now(), windowDays = DEFAULT_ERASURE_WINDOW_DAYS) {
      const days = Number(windowDays);
      // A NaN window would compare false everywhere and quietly return nothing
      // due — a retention job that silently stops is the failure to avoid.
      if (!Number.isFinite(days) || days < 0) throw err(400, '保留期需为非负天数');
      return withLock(async () => (await readUsers())
        .filter((u) => isDueForErasure(u, now, days))
        .map((u) => u.id));
    },

    /** Legacy name for erase, kept because serve.mjs's admin console calls it.
     * Same operation, no COS deleter, legacy receipt shape plus the keys. */
    async deleteUser(userId) {
      return withLock(async () => {
        const r = await eraseInternal(null, userId, null);
        return { username: r.username, courses_deleted: r.deleted.courses, cos_keys: r.cos_keys };
      });
    },

    // ================= materials (COS references, never bytes) =================

    /**
     * Record one uploaded object (ADR-0013 §6). The bytes live in the private
     * LighthouseCOS bucket; this row is all the store keeps, and it exists so
     * that erasure can find the key — an object nobody recorded is an object
     * nobody can delete.
     *
     * The store neither mints the key nor enforces the size cap: the upload
     * path owns both, because it knows the extension and the configured limit.
     * It also owns non-negotiable #4 — no uploaded child photo reaches any
     * model without its own compliance ADR, and that has to be enforced where
     * the call is made, not commented about here.
     */
    async recordMaterial(userId, courseId, material) {
      return withLock(async () => {
        const kind = String(material?.kind ?? '');
        const mime = String(material?.mime_type ?? '');
        const key = String(material?.cos_key ?? '').trim();
        if (!MATERIAL_KINDS.includes(kind)) throw err(400, '素材类型不支持');
        if (!MATERIAL_MIME_TYPES.includes(mime)) throw err(400, '文件类型不支持');
        if (!key) throw err(400, '缺少对象键');
        // THE COURSE MUST BE HERS. The Postgres tier gets this from
        // `materials_owner`'s WITH CHECK (003_rls.sql), so without it here the
        // two tiers disagree about a security property and the shared contract
        // suite cannot see the difference — neither tier was asked.
        //
        // The consequence once an upload endpoint exists is not abstract:
        // teacher A files a material against teacher B's course, B's course
        // deletion then removes A's row while the COS object survives, and an
        // orphaned child photo is exactly what ADR-0013 §6 names as the failure
        // mode to design against.
        if (courseId != null) {
          const owner = await readCourse(courseId);
          if (!owner || owner.user_id !== userId) throw err(404, '课程不存在');
        }
        const existing = await readJson(materialsFile, []);
        const rows = Array.isArray(existing) ? existing : [];
        const row = {
          id: randomUUID(), user_id: userId, course_id: courseId ?? null,
          kind, cos_key: key, mime_type: mime,
          size_bytes: Number(material?.size_bytes ?? 0) || 0,
          exif_stripped: Boolean(material?.exif_stripped),
          contains_children: Boolean(material?.contains_children),
          retention_until: material?.retention_until ?? null,
          created_at: nowISO(),
        };
        rows.push(row);
        await writeAtomic(materialsFile, rows);
        return row;
      });
    },

    /** Owner-scoped list; optionally one course. */
    async listMaterials(userId, courseId) {
      return withLock(async () => {
        const rows = await readJson(materialsFile, []);
        return (Array.isArray(rows) ? rows : []).filter((m) => m?.user_id === userId
          && (courseId == null || m?.course_id === courseId));
      });
    },

    // ============ per-account model-key vault (ciphertext only) ============
    // The store never sees plaintext keys: serve.mjs encrypts/decrypts via
    // key-vault.mjs. These rows are excluded from every export path — the
    // admin console, adminExportAll and course records never touch keysFile.

    /** Save/replace (blob string) or delete (null) one provider's ciphertext. */
    async setUserKey(userId, provider, blobOrNull) {
      return withLock(async () => {
        const all = await readJson(keysFile, {});
        const mine = { ...(all[userId] ?? {}) };
        if (blobOrNull) mine[provider] = String(blobOrNull);
        else delete mine[provider];
        if (Object.keys(mine).length) all[userId] = mine; else delete all[userId];
        await writeAtomic(keysFile, all);
        return true;
      });
    },

    /** @returns {Object} { provider: ciphertext } for one user (may be empty). */
    async getUserKeys(userId) {
      return withLock(async () => ({ ...((await readJson(keysFile, {}))[userId] ?? {}) }));
    },

    // ================= rate-gate persistence (opaque blob) =================

    async loadRateState() {
      return withLock(async () => readJson(rateFile, null));
    },

    async saveRateState(state) {
      return withLock(async () => writeAtomic(rateFile, state ?? {}));
    },

    // ================= sessions (SECURITY.md §2) =================

    async createSession(userId, userAgent) {
      return withLock(async () => {
        const sessions = await readSessions();
        const row = {
          token: sessionToken(), sid: sessionSid(), user_id: userId,
          created_at: nowISO(), last_seen_at: nowISO(),
          expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
          revoked_at: null, user_agent: String(userAgent ?? '').slice(0, 200),
        };
        sessions.push(row);
        await writeAtomic(sessionsFile, sessions);
        return { token: row.token, sid: row.sid };
      });
    },

    /** Resolve a cookie token → { user, session } or null. Rolling expiry. */
    async getSessionUser(token) {
      return withLock(async () => {
        if (!token) return null;
        const sessions = await readSessions();
        const s = sessions.find((x) => x.token === token);
        if (!s || s.revoked_at || Date.parse(s.expires_at) < Date.now()) return null;
        const users = await readUsers();
        const u = users.find((x) => x.id === s.user_id);
        if (!u || u.status !== 'active') return null;
        if (Date.now() - Date.parse(s.last_seen_at) > SESSION_BUMP_MS) {
          s.last_seen_at = nowISO();
          s.expires_at = new Date(Date.now() + SESSION_TTL_MS).toISOString();
          await writeAtomic(sessionsFile, sessions);
        }
        return { user: sanitizeUser(u), session: { sid: s.sid } };
      });
    },

    /** Device list — public sids only, never bearer tokens. */
    async listSessions(userId, currentToken) {
      return withLock(async () => {
        const sessions = await readSessions();
        return sessions
          .filter((s) => s.user_id === userId && !s.revoked_at && Date.parse(s.expires_at) > Date.now())
          .map((s) => ({
            sid: s.sid, created_at: s.created_at, last_seen_at: s.last_seen_at,
            user_agent: s.user_agent, current: s.token === currentToken,
          }));
      });
    },

    async revokeSession(userId, sid) {
      return withLock(async () => {
        const sessions = await readSessions();
        const s = sessions.find((x) => x.user_id === userId && x.sid === sid && !x.revoked_at);
        if (!s) return false;
        s.revoked_at = nowISO();
        await writeAtomic(sessionsFile, sessions);
        return true;
      });
    },

    async revokeByToken(token) {
      return withLock(async () => {
        const sessions = await readSessions();
        const s = sessions.find((x) => x.token === token && !x.revoked_at);
        if (!s) return false;
        s.revoked_at = nowISO();
        await writeAtomic(sessionsFile, sessions);
        return true;
      });
    },

    // ================= audit (SECURITY.md §4) =================

    /** Every admin action on another user leaves a row. */
    async audit(adminId, action, targetUser, detail) {
      return withLock(() => appendAuditRow(adminId, action, targetUser, detail));
    },

    async listAudit({ limit = 100 } = {}) {
      return withLock(async () => (await readJson(auditFile, [])).slice(-limit).reverse());
    },

    // ================= scope shell log (ADR-0012 §3) =================
    // Warn-only mode is only useful if somebody READS the would-refuse rows, so
    // they are persisted rather than left in journalctl. Stores the matched
    // rule and a short excerpt — enough to judge a false block — never the whole
    // message, which would put teacher content in an ops log.

    /** One scope verdict. Ring-buffered: this is an ops signal, not history. */
    async logScope(row) {
      return withLock(async () => {
        const rows = await readJson(scopeFile, []);
        rows.push({
          id: rows.length + 1,
          rule: String(row?.rule ?? ''),
          enforced: Boolean(row?.enforced),
          refused: Boolean(row?.refused),
          excerpt: String(row?.excerpt ?? '').slice(0, 60),
          user_id: row?.userId ?? null,
          created_at: nowISO(),
        });
        await writeAtomic(scopeFile, rows.slice(-SCOPE_LOG_MAX));
      });
    },

    /** Newest first, plus a per-rule tally — the shape the admin tab wants. */
    async listScope({ limit = 200 } = {}) {
      return withLock(async () => {
        const rows = await readJson(scopeFile, []);
        const byRule = {};
        for (const r of rows) byRule[r.rule] = (byRule[r.rule] ?? 0) + 1;
        return { rows: rows.slice(-limit).reverse(), total: rows.length, byRule };
      });
    },

    // ================= admin console reads (data tab) =================

    async adminListCourses() {
      return withLock(async () => {
        // Join usernames so consoles can show people, not UUIDs (DESIGN.md clarity rules).
        const users = await readUsers();
        const byId = Object.fromEntries(users.map((u) => [u.id, u]));
        const out = (await allCourses()).map((c) => ({
          id: c.id, user_id: c.user_id, title: c.title,
          username: byId[c.user_id]?.username ?? null,
          display_name: byId[c.user_id]?.display_name ?? null,
          profile: byId[c.user_id]?.settings?.profile ?? null, // demographics columns/filters
          state_version: c.state_version, created_at: c.created_at, updated_at: c.updated_at,
          messages: (c.messages || []).length, snapshots: (c.snapshots || []).length,
          // living-plan visibility (ADR-0003): version + how much is still unconfirmed
          blueprint_version: c.course_state?.course_plan_blueprint?.version ?? null,
          blueprint_modules: c.course_state?.course_plan_blueprint?.modules?.length ?? 0,
          // Same treatment for the plan tree, because the list tab is where an
          // analyst scans and the detail JSON is opened one course at a time:
          // 「which courses have a plan at all」 and 「how much of it is flagged
          // 待复查」 are exactly the questions the staleness stamp exists to
          // answer, and they were invisible at scanning level.
          plan_version: c.course_state?.course_plan?.version ?? null,
          plan_nodes: countPlanNodes(c.course_state?.course_plan),
          plan_stale_nodes: countPlanNodes(c.course_state?.course_plan, (n) => Boolean(n.stale_since)),
          // Per-subject message tally (ADR-0010 §1): one ordered log, tagged
          // rows — so node-level activity is visible without reading the file.
          messages_by_subject: tallyBy(c.messages, (m) => m.subject || 'course'),
        }));
        out.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
        return out;
      });
    },

    async adminGetCourse(courseId) {
      return withLock(async () => readCourse(courseId));
    },

    /** Same shape and the same object-first ordering as deleteCourse — a
     * console delete must not be the path that orphans a child photo. */
    async adminDelete(courseId, { deleteObject = null } = {}) {
      return deleteCourseInternal(courseId, deleteObject);
    },

    async adminExportAll() {
      return withLock(async () => allCourses());
    },
  };
}
