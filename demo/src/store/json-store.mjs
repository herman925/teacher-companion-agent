// json-store.mjs — JSON-file implementation of the demo persistence tier
// (DATABASE.md §4). One file per course under demo/.data/courses/, so demo
// chat history survives across reloads and devices on localhost or the Tencent
// VM. Zero-dep; a pg-store.mjs will later implement the SAME interface (store.mjs).
//
// Not for production child data: no auth, single demo user, plain files on disk.
// demo/.data/ is gitignored (child-data non-negotiable #4).

import { readFile, writeFile, mkdir, readdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createInitialState } from '../engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(HERE, '..', '..', '.data', 'courses');

const MAX_COURSES_PER_USER = 30; // abuse guard (DATABASE.md §2)
const CHECKPOINT_EVERY = 20;     // full-document snapshot cadence (DATABASE.md §2)

const nowISO = () => new Date().toISOString();

// All file mutations serialize through one promise chain: the whole demo is one
// process with sequential turns, so this is enough to keep read-modify-write safe.
let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}

const coursePath = (id) => path.join(DATA_DIR, `${encodeURIComponent(id)}.json`);

async function ensureDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

async function readCourse(id) {
  try {
    return JSON.parse(await readFile(coursePath(id), 'utf8'));
  } catch {
    return null;
  }
}

async function writeCourse(course) {
  await ensureDir();
  const file = coursePath(course.id);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(course, null, 2), 'utf8');
  await rename(tmp, file); // atomic replace
}

/** Brief shape for course lists (no state/messages). */
function brief(c) {
  return { id: c.id, title: c.title, state_version: c.state_version, updated_at: c.updated_at };
}

export function createJsonStore() {
  return {
    async listCourses(userId) {
      return withLock(async () => {
        await ensureDir();
        let files = [];
        try { files = await readdir(DATA_DIR); } catch { files = []; }
        const out = [];
        for (const f of files) {
          if (!f.endsWith('.json')) continue;
          try {
            const c = JSON.parse(await readFile(path.join(DATA_DIR, f), 'utf8'));
            if (c.user_id === userId) out.push(brief(c));
          } catch { /* skip unreadable/partial file */ }
        }
        out.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
        return out;
      });
    },

    async createCourse(userId, title) {
      return withLock(async () => {
        await ensureDir();
        let files = [];
        try { files = await readdir(DATA_DIR); } catch { files = []; }
        let count = 0;
        for (const f of files) {
          if (!f.endsWith('.json')) continue;
          try {
            const c = JSON.parse(await readFile(path.join(DATA_DIR, f), 'utf8'));
            if (c.user_id === userId) count += 1;
          } catch { /* ignore */ }
        }
        if (count >= MAX_COURSES_PER_USER) {
          const err = new Error(`最多 ${MAX_COURSES_PER_USER} 个课程`);
          err.status = 409;
          throw err;
        }
        const id = randomUUID();
        const ts = nowISO();
        const course = {
          id,
          user_id: userId,
          title: (title && String(title).trim()) || '新课程',
          course_state: createInitialState(id),
          state_version: 0,
          created_at: ts,
          updated_at: ts,
          next_message_id: 1,
          messages: [],
          snapshots: [],
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

    /** Append one message (append-only). @returns the stored row. */
    async appendMessage(courseId, msg) {
      return withLock(async () => {
        const c = await readCourse(courseId);
        if (!c) throw Object.assign(new Error('课程不存在'), { status: 404 });
        const row = {
          id: c.next_message_id,
          role: msg.role, // 'teacher' | 'agent' | 'system'
          content: msg.content ?? '',
          turn_contract: msg.turn_contract ?? null,
          provider: msg.provider ?? null,
          provider_label: msg.provider_label ?? null,
          usage: msg.usage ?? null,
          stage_name: msg.stage_name ?? null,
          created_at: nowISO(),
        };
        c.next_message_id += 1;
        c.messages.push(row);
        c.updated_at = row.created_at;
        await writeCourse(c);
        return row;
      });
    },

    /** Paged history. { before } = id upper bound (exclusive); { limit } = keep last N. */
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

    /**
     * Persist an applied state delta with checkpoint snapshots (DATABASE.md §2):
     * delta every version + full document every CHECKPOINT_EVERY versions and on
     * stage change. Optimistic lock on expectedVersion.
     */
    async saveState(courseId, delta, newState, expectedVersion) {
      return withLock(async () => {
        const c = await readCourse(courseId);
        if (!c) throw Object.assign(new Error('课程不存在'), { status: 404 });
        if (expectedVersion != null && c.state_version !== expectedVersion) {
          throw Object.assign(new Error('状态版本冲突'), { status: 409 });
        }
        const stageChanged = (c.course_state?.stage) !== (newState?.stage);
        const newVersion = c.state_version + 1;
        const isCheckpoint = newVersion % CHECKPOINT_EVERY === 0 || stageChanged || newVersion === 1;
        c.snapshots.push({
          state_version: newVersion,
          state_delta: delta ?? {},
          course_state: isCheckpoint ? newState : null,
          is_checkpoint: isCheckpoint,
          created_at: nowISO(),
        });
        c.course_state = newState;
        c.state_version = newVersion;
        c.updated_at = nowISO();
        await writeCourse(c);
        return { state_version: newVersion };
      });
    },
  };
}
