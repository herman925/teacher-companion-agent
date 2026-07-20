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
const DEFAULT_TITLE = '新课程';

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
  const readUsers = () => readJson(usersFile, []);
  const readSessions = () => readJson(sessionsFile, []);
  /** Public shape: never the password hash. */
  const sanitizeUser = (u) => u && {
    id: u.id, username: u.username, display_name: u.display_name, role: u.role,
    status: u.status, must_change_password: Boolean(u.must_change_password),
    display_name_changed_at: u.display_name_changed_at ?? null,
    created_at: u.created_at, last_login_at: u.last_login_at ?? null,
    profile: u.settings?.profile ?? null,
  };

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

    /** True when auto-titling should run: still on the default name, not human-locked. */
    async isUntitled(courseId) {
      return withLock(async () => {
        const c = await readCourse(courseId);
        return Boolean(c && !c.title_locked && c.title === DEFAULT_TITLE);
      });
    },

    /** Whole-course erasure (data-subject deletion, DATABASE.md §4). */
    async deleteCourse(userId, courseId) {
      return withLock(async () => {
        const c = await readCourse(courseId);
        if (!c || c.user_id !== userId) return false;
        await unlink(coursePath(courseId)).catch(() => {});
        return true;
      });
    },

    /** Append one message (append-only). */
    async appendMessage(courseId, msg) {
      return withLock(async () => {
        const c = await readCourse(courseId);
        if (!c) throw err(404, '课程不存在');
        const row = {
          id: c.next_message_id,
          role: msg.role, content: msg.content ?? '',
          turn_contract: msg.turn_contract ?? null,
          provider: msg.provider ?? null, provider_label: msg.provider_label ?? null,
          usage: msg.usage ?? null, stage_name: msg.stage_name ?? null,
          created_at: nowISO(),
        };
        c.next_message_id += 1;
        c.messages.push(row);
        c.updated_at = row.created_at;
        await writeCourse(c);
        return row;
      });
    },

    async getMessages(courseId, { before, limit } = {}) {
      return withLock(async () => {
        const c = await readCourse(courseId);
        if (!c) return [];
        let rows = c.messages.slice().sort((a, b) => a.id - b.id);
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

    /** Password login. @returns sanitized user or null (wrong creds / disabled). */
    async verifyLogin(username, password) {
      return withLock(async () => {
        const users = await readUsers();
        const u = users.find((x) => x.username === String(username ?? '').trim().toLowerCase());
        if (!u || u.status !== 'active' || !verifyPassword(password, u.password)) return null;
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
        if (!verifyPassword(oldPassword, u.password)) throw err(403, '旧密码不对');
        if (String(newPassword ?? '').length < 8) throw err(400, '新密码至少 8 位');
        u.password = hashPassword(newPassword);
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

    /** Admin: status/role changes. Disabling also revokes live sessions. */
    async updateUser(userId, patch) {
      return withLock(async () => {
        const users = await readUsers();
        const u = users.find((x) => x.id === userId);
        if (!u) throw err(404, '用户不存在');
        if (patch.status && ['active', 'disabled'].includes(patch.status)) u.status = patch.status;
        if (patch.role && ['admin', 'teacher'].includes(patch.role)) u.role = patch.role;
        await writeAtomic(usersFile, users);
        if (u.status === 'disabled') {
          const sessions = await readSessions();
          for (const s of sessions) if (s.user_id === userId && !s.revoked_at) s.revoked_at = nowISO();
          await writeAtomic(sessionsFile, sessions);
        }
        return sanitizeUser(u);
      });
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
      return withLock(async () => {
        const rows = await readJson(auditFile, []);
        rows.push({ id: rows.length + 1, admin_id: adminId, action, target_user: targetUser ?? null, detail: detail ?? null, created_at: nowISO() });
        await writeAtomic(auditFile, rows);
      });
    },

    async listAudit({ limit = 100 } = {}) {
      return withLock(async () => (await readJson(auditFile, [])).slice(-limit).reverse());
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
        }));
        out.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
        return out;
      });
    },

    async adminGetCourse(courseId) {
      return withLock(async () => readCourse(courseId));
    },

    async adminDelete(courseId) {
      return withLock(async () => {
        const c = await readCourse(courseId);
        if (!c) return false;
        await unlink(coursePath(courseId)).catch(() => {});
        return true;
      });
    },

    async adminExportAll() {
      return withLock(async () => allCourses());
    },
  };
}
