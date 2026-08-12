// access-log.mjs — the admin content-read audit trail (ADR-0013 §7).
//
// ADR-0013 §7 accepts a real tension: admins keep full read access to course
// content and uploads, which is broader than non-negotiable #4's scoped
// access. The compensating control is that every content read is recorded.
// This file is that control, so it has to be boring and hard to break.
//
// Shape, per Herman's call: DAILY-ROTATED FILES at
// `<baseDir>/auth/access-log/YYYY-MM-DD.jsonl` — not one growing file (nobody
// archives or prunes those), and not a database table (an audit trail living
// outside the database it audits is harder to quietly edit; DATABASE.md §2b).
// `baseDir` is the data root — the same `.data` directory json-store.mjs uses —
// so a caller passes the base it already has and this module owns the layout.
//
// Two rules the rest of the file exists to keep:
//
//   1. EXCERPT ONLY, 60 characters. Enough to judge what an admin looked at,
//      not enough to turn an ops log into a second store of teacher
//      conversation. An over-long excerpt is TRUNCATED, never rejected: losing
//      a whole row (and with it the record that a read happened) is far worse
//      than losing the tail of a sentence.
//   2. Retention is finite. `pruneAccess` deletes past the window because an
//      audit log that grows forever becomes its own liability.
//
// I/O sits behind an injectable `io` so callers can test without a real
// filesystem; `createMemoryIo()` below is the in-memory implementation.
//
// Honest limits: the pilot runs a single Node process, and appends use append
// mode, so lines from concurrent requests in this process do not interleave.
// We claim nothing about multiple processes appending to one file — if the
// deployment ever forks, this needs revisiting rather than assuming.

import { mkdir, appendFile, readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

/** Excerpt cap, in characters. Same 60 as `scope_log` (DATABASE.md §2b). */
export const EXCERPT_MAX = 60;

/** Retention window in days (ADR-0013 §7). */
export const RETENTION_DAYS = 90;

/** Cap on the action verb — a label, never prose. */
const ACTION_MAX = 40;

/** Cap on ids and subjects. A node id or a uuid, not a sentence. */
const ID_MAX = 120;

/**
 * Actions the console is expected to record. Exported as documentation for
 * callers, NOT as a validator: an unrecognized action is still written, because
 * dropping the row would lose the fact that a read happened — which is the one
 * thing this log exists to keep.
 */
export const ACCESS_ACTIONS = Object.freeze([
  'read_messages',   // opened a course's conversation
  'read_course',     // opened a course's state / plan tree
  'read_file',       // opened or downloaded an upload
  'export_course',   // pulled a course out of the system
]);

const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const pad = (n) => String(n).padStart(2, '0');

/** Node-backed I/O. The default; swap it out in tests. */
const nodeIo = {
  mkdir: (dir) => mkdir(dir, { recursive: true }),
  appendFile: (file, data) => appendFile(file, data, 'utf8'),
  readFile: (file) => readFile(file, 'utf8'),
  readdir: (dir) => readdir(dir),
  unlink: (file) => unlink(file),
};

/**
 * In-memory I/O with the same surface as `nodeIo` — a flat path → text map.
 * Lives here rather than in the test so the contract the tests exercise is the
 * contract this module actually declares.
 * @param {Record<string,string>} [seed] path → file contents
 */
export function createMemoryIo(seed = {}) {
  const files = new Map(Object.entries(seed));
  const enoent = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  return {
    files,
    async mkdir() { /* directories are implicit in a flat map */ },
    async appendFile(file, data) { files.set(file, (files.get(file) ?? '') + data); },
    async readFile(file) {
      const v = files.get(file);
      if (v === undefined) throw enoent(file);
      return v;
    },
    async readdir(dir) {
      const names = [...files.keys()].filter((p) => path.dirname(p) === dir).map((p) => path.basename(p));
      // A directory with no files has never been created, so behave like the
      // real thing and throw — readAccess/pruneAccess must handle that path.
      if (!names.length) throw enoent(dir);
      return names;
    },
    async unlink(file) {
      if (!files.delete(file)) throw enoent(file);
    },
  };
}

/**
 * The day key (`YYYY-MM-DD`) a timestamp belongs to.
 *
 * A bare `YYYY-MM-DD` string is already a key and passes through untouched. A
 * Date or full timestamp is resolved in the SERVER'S LOCAL TIME, because the
 * operator reading `2026-08-11.jsonl` means their own day — a UTC boundary
 * would put the rollover at 08:00 in Guangzhou and make「今天的日志」 wrong for
 * a third of the working day. Nothing is lost by this: each row's `at` field
 * keeps a full UTC timestamp, so the file name is a filing decision only.
 *
 * @param {Date|string|number} [value]
 * @returns {string} `YYYY-MM-DD`
 */
export function dayKey(value = new Date()) {
  if (typeof value === 'string') {
    const bare = /^(\d{4}-\d{2}-\d{2})$/.exec(value.trim());
    if (bare) return bare[1];
  }
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new TypeError(`access-log: invalid date ${String(value)}`);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The directory holding the daily files. Beside the other auth data. */
export function logDir(baseDir) {
  return path.join(baseDir, 'auth', 'access-log');
}

/**
 * Path of the daily file for `date` (default: now). Pure.
 * @param {string} baseDir data root, e.g. `.data`
 * @param {Date|string|number} [date]
 */
export function logPath(baseDir, date = new Date()) {
  return path.join(logDir(baseDir), `${dayKey(date)}.jsonl`);
}

/**
 * Trim a string to `max` characters without splitting a character in half.
 * Counted in code points, not UTF-16 units: `.slice()` on a string can cut an
 * emoji in half and leave a lone surrogate in the log. Code points are also
 * what Postgres `length()` counts, so this cap matches `scope_log`'s CHECK.
 * @param {unknown} value @param {number} max
 */
function clip(value, max) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max).join('');
}

/**
 * Normalize one row. Pure, and deliberately forgiving — every branch here ends
 * with a writable row, never a rejection.
 * @param {Object} row
 * @param {() => Date} now
 * @returns {{admin_id: string, action: string, course_id: string|null, subject: string|null, excerpt: string|null, at: string}}
 */
export function normalizeAccessRow(row = {}, now = () => new Date()) {
  // Until admin auth is session + role (ADR-0013 §8) the console can only say
  // 「someone with the token」; callers pass what they have and 'unknown' is the
  // honest placeholder rather than a fabricated identity.
  const adminId = clip(row.admin_id ?? row.adminId, ID_MAX) || 'unknown';
  const action = clip(row.action, ACTION_MAX) || 'unknown';
  const courseId = clip(row.course_id ?? row.courseId, ID_MAX) || null;
  const subject = clip(row.subject, ID_MAX) || null;
  // null (no content involved) and '' (content that was empty) are different
  // facts, so an absent excerpt stays null instead of collapsing to a string.
  const raw = row.excerpt;
  const excerpt = raw === undefined || raw === null ? null : clip(raw, EXCERPT_MAX);

  let at = now();
  if (row.at !== undefined && row.at !== null) {
    const parsed = row.at instanceof Date ? row.at : new Date(row.at);
    if (!Number.isNaN(parsed.getTime())) at = parsed;   // a bad `at` falls back
  }                                                     // to now, never drops.
  return {
    admin_id: adminId,
    action,
    course_id: courseId,
    subject,
    excerpt,
    at: at.toISOString(),   // UTC, full precision — the file name is local-day
  };
}

/**
 * Append one access record. Rotates by itself: the day comes from the row's
 * timestamp, so a process running across midnight starts a new file with no
 * scheduler and no restart.
 * @param {string} baseDir
 * @param {Object} row {admin_id, action, course_id, subject, excerpt, at?}
 * @param {{io?: Object, now?: () => Date}} [deps]
 * @returns {Promise<{row: Object, file: string}>} what was written, and where
 */
export async function appendAccess(baseDir, row, { io = nodeIo, now = () => new Date() } = {}) {
  const normalized = normalizeAccessRow(row, now);
  const file = logPath(baseDir, normalized.at);
  await io.mkdir(logDir(baseDir));
  // JSON.stringify escapes any newline inside a value, so one row is one line
  // by construction — the JSONL invariant does not depend on the caller.
  await io.appendFile(file, `${JSON.stringify(normalized)}\n`);
  return { row: normalized, file };
}

/**
 * Read a date range back for the console. Inclusive on both ends; an omitted
 * bound is open (default: everything on disk, which the 90-day prune bounds).
 * Oldest first.
 * @param {string} baseDir
 * @param {{from?: Date|string, to?: Date|string}} [range]
 * @param {{io?: Object}} [deps]
 * @returns {Promise<Array<Object>>} rows, each carrying its `date` key
 */
export async function readAccess(baseDir, { from, to } = {}, { io = nodeIo } = {}) {
  const dir = logDir(baseDir);
  const fromKey = from === undefined || from === null ? null : dayKey(from);
  const toKey = to === undefined || to === null ? null : dayKey(to);

  let names;
  try {
    names = await io.readdir(dir);
  } catch (e) {
    if (e?.code === 'ENOENT') return [];   // nothing logged yet is not an error
    throw e;
  }

  // YYYY-MM-DD sorts and compares correctly as a string, which is the whole
  // reason the file name uses it.
  const keys = names
    .map((n) => FILE_RE.exec(n)?.[1])
    .filter((k) => k && (!fromKey || k >= fromKey) && (!toKey || k <= toKey))
    .sort();

  const rows = [];
  for (const key of keys) {
    let text;
    try {
      text = await io.readFile(path.join(dir, `${key}.jsonl`));
    } catch (e) {
      if (e?.code === 'ENOENT') continue;   // pruned between readdir and read
      throw e;
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        rows.push({ ...parsed, date: key });
      } catch {
        // A half-written last line (a crash mid-append) must not take the
        // console down and hide every good row in the file. Skipped, not
        // thrown — and visible as a gap in ids nobody keeps, which is the
        // trade we accept for a log that always reads.
      }
    }
  }
  return rows;
}

/**
 * Delete daily files older than `days` (ADR-0013 §7 retention).
 *
 * A file dated exactly `days` ago is `days` old, not older, so it is kept; the
 * cutoff is `today - days`. Today's file is never removed — guaranteed by the
 * cutoff and asserted again below, because a prune bug that eats the current
 * day would erase the reads that are most likely to be under question.
 * Files whose names we do not recognize are left alone: something else put
 * them there and they are not ours to delete.
 *
 * @param {string} baseDir
 * @param {number} [days]
 * @param {{io?: Object, now?: () => Date}} [deps]
 * @returns {Promise<{removed: string[], kept: string[], failed: string[], cutoff: string}>}
 */
export async function pruneAccess(baseDir, days = RETENTION_DAYS, { io = nodeIo, now = () => new Date() } = {}) {
  const window = Number.isFinite(days) ? Math.max(0, Math.floor(days)) : RETENTION_DAYS;
  const today = now();
  const todayKey = dayKey(today);
  // Step back from local NOON so a daylight-saving hour cannot slide the cutoff
  // onto the wrong calendar day. (Mainland China has no DST; the anchor costs
  // nothing and stops this from being a bug elsewhere.)
  const noon = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12);
  const cutoff = dayKey(new Date(noon.getTime() - window * 86400000));

  const dir = logDir(baseDir);
  let names;
  try {
    names = await io.readdir(dir);
  } catch (e) {
    if (e?.code === 'ENOENT') return { removed: [], kept: [], failed: [], cutoff };
    throw e;
  }

  const removed = [];
  const kept = [];
  const failed = [];
  for (const name of names.slice().sort()) {
    const key = FILE_RE.exec(name)?.[1];
    if (!key) continue;                       // not ours — leave it
    if (key >= cutoff || key === todayKey) { kept.push(key); continue; }
    try {
      await io.unlink(path.join(dir, name));
      removed.push(key);
    } catch (e) {
      // Already gone is fine; anything else is reported, not thrown, so one
      // stubborn file cannot stop the rest of the window being pruned.
      if (e?.code === 'ENOENT') removed.push(key); else failed.push(key);
    }
  }
  return { removed, kept, failed, cutoff };
}
