// access-log: the admin read trail (ADR-0013 §7). Both directions everywhere —
// rotation crosses midnight AND leaves yesterday's file alone; prune removes
// past the window AND never today's file (nor anything it did not write); an
// over-long excerpt is truncated AND a compliant one survives untouched.
//
// No filesystem: every test drives the injectable in-memory I/O, so this suite
// runs the same on a laptop as on the VM.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  EXCERPT_MAX,
  RETENTION_DAYS,
  dayKey,
  logDir,
  logPath,
  appendAccess,
  readAccess,
  pruneAccess,
  normalizeAccessRow,
  createMemoryIo,
} from '../src/access-log.mjs';

const BASE = '/srv/app/.data';

// Dates are built from LOCAL components on purpose: the module files by local
// day, so a test that hard-codes a UTC instant would pass in Guangzhou and fail
// in a CI box set to UTC.
const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min);
const dayBefore = (n) => dayKey(new Date(2026, 7, 11 - n, 12));   // 2026-08-11 minus n

const fileFor = (key) => path.join(logDir(BASE), `${key}.jsonl`);

function seedDays(keys) {
  const seed = {};
  for (const key of keys) {
    seed[fileFor(key)] = `${JSON.stringify({
      admin_id: 'herman', action: 'read_messages', course_id: 'c-1',
      subject: 'course', excerpt: null, at: `${key}T04:00:00.000Z`,
    })}\n`;
  }
  return createMemoryIo(seed);
}

// ---------------------------------------------------------------- paths

test('logPath: daily file beside the other auth data; a bare day key passes through', () => {
  assert.equal(logPath(BASE, '2026-08-11'), path.join(BASE, 'auth', 'access-log', '2026-08-11.jsonl'));
  assert.equal(logPath(BASE, at(2026, 8, 11, 23, 59)), path.join(BASE, 'auth', 'access-log', '2026-08-11.jsonl'));
  assert.equal(dayKey(at(2026, 1, 2, 0, 5)), '2026-01-02', 'single digits are padded');
  assert.throws(() => logPath(BASE, 'not-a-date'), TypeError, 'an explicit bad date is a programmer error');
});

// ------------------------------------------------------------- rotation

test('rotation: crossing midnight starts a new file and leaves the old one alone', async () => {
  const io = createMemoryIo();
  const late = await appendAccess(BASE, { admin_id: 'herman', action: 'read_messages', course_id: 'c-1' },
    { io, now: () => at(2026, 8, 11, 23, 59) });
  const early = await appendAccess(BASE, { admin_id: 'herman', action: 'read_file', course_id: 'c-1' },
    { io, now: () => at(2026, 8, 12, 0, 1) });

  assert.equal(late.file, fileFor('2026-08-11'));
  assert.equal(early.file, fileFor('2026-08-12'), 'the date changed, so the file changed');
  assert.equal(io.files.size, 2, 'two days, two files — not one growing file');
  assert.equal(io.files.get(fileFor('2026-08-11')).trim().split('\n').length, 1,
    "yesterday's file still holds exactly its own row");
});

test('rotation: same day appends land in one file, one JSONL line each', async () => {
  const io = createMemoryIo();
  for (let i = 0; i < 3; i += 1) {
    await appendAccess(BASE, { admin_id: 'herman', action: 'read_course', course_id: `c-${i}` },
      { io, now: () => at(2026, 8, 11, 9 + i) });
  }
  const lines = io.files.get(fileFor('2026-08-11')).trim().split('\n');
  assert.equal(io.files.size, 1);
  assert.equal(lines.length, 3);
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line), 'every line parses on its own');
});

// -------------------------------------------------------------- excerpt

test('excerpt: an over-long one is truncated, never rejected — the row still lands', async () => {
  const io = createMemoryIo();
  // A real teacher paragraph. Losing this row would lose the record that an
  // admin read the conversation, which is worse than losing the tail.
  const long = '老师说：孩子们今天在操场的角落里发现了一窝蚂蚁，围着看了很久，'
    + '有人问蚂蚁要搬去哪里，有人跑回教室拿放大镜，还有人提议用积木给蚂蚁搭一座桥。';
  assert.ok(Array.from(long).length > EXCERPT_MAX, 'fixture is genuinely over the cap');

  const { row } = await appendAccess(BASE, {
    admin_id: 'herman', action: 'read_messages', course_id: 'c-1', subject: '3.2.1', excerpt: long,
  }, { io, now: () => at(2026, 8, 11) });

  assert.equal(Array.from(row.excerpt).length, EXCERPT_MAX, 'capped at 60 characters');
  assert.equal(row.excerpt, Array.from(long).slice(0, EXCERPT_MAX).join(''), 'the head is kept verbatim');
  assert.equal(row.action, 'read_messages', 'the row itself survives the over-long field');
  assert.equal(io.files.get(fileFor('2026-08-11')).trim().split('\n').length, 1, 'exactly one line written');
});

test('excerpt: a compliant one passes through untouched, and an absent one stays null', async () => {
  const io = createMemoryIo();
  const short = '孩子们在讨论蚂蚁搬家。';
  const { row } = await appendAccess(BASE, {
    admin_id: 'herman', action: 'read_messages', course_id: 'c-1', excerpt: short,
  }, { io, now: () => at(2026, 8, 11) });
  assert.equal(row.excerpt, short, 'under the cap means byte-for-byte');

  const bare = await appendAccess(BASE, { admin_id: 'herman', action: 'read_file', course_id: 'c-1' },
    { io, now: () => at(2026, 8, 11) });
  assert.equal(bare.row.excerpt, null, 'no content involved is null, not an empty string');
});

test('excerpt: truncation counts characters, so an astral character is never split', () => {
  const row = normalizeAccessRow({ action: 'read_messages', excerpt: '🙂'.repeat(70) });
  assert.equal(Array.from(row.excerpt).length, EXCERPT_MAX);
  assert.equal(row.excerpt.length, EXCERPT_MAX * 2, 'each emoji kept whole (two UTF-16 units)');
  // A whole emoji legitimately ENDS in a low surrogate; only a dangling HIGH
  // surrogate means the cut landed inside a character.
  assert.ok(!/[\uD800-\uDBFF]$/.test(row.excerpt), 'no dangling high surrogate at the tail');
});

test('normalize: a missing admin id is honest, and a junk timestamp falls back to now', () => {
  const now = at(2026, 8, 11, 10, 30);
  const row = normalizeAccessRow({ action: '  read_file  ', at: 'yesterday-ish' }, () => now);
  assert.equal(row.admin_id, 'unknown', "never invent an identity the console cannot resolve");
  assert.equal(row.action, 'read_file');
  assert.equal(row.course_id, null);
  assert.equal(row.at, now.toISOString(), 'a bad timestamp does not drop the row');
});

// ----------------------------------------------------------------- read

test('readAccess: inclusive range, oldest first, and out-of-range days stay out', async () => {
  const io = seedDays(['2026-08-08', '2026-08-09', '2026-08-10', '2026-08-11']);
  const rows = await readAccess(BASE, { from: '2026-08-09', to: '2026-08-10' }, { io });
  assert.deepEqual(rows.map((r) => r.date), ['2026-08-09', '2026-08-10']);
  assert.equal(rows[0].admin_id, 'herman');

  const all = await readAccess(BASE, {}, { io });
  assert.equal(all.length, 4, 'an omitted range reads everything on disk');
  const open = await readAccess(BASE, { from: '2026-08-10' }, { io });
  assert.deepEqual(open.map((r) => r.date), ['2026-08-10', '2026-08-11'], 'one open bound is allowed');
});

test('readAccess: a half-written line is skipped, the good rows around it survive', async () => {
  const good = (id) => JSON.stringify({ admin_id: 'herman', action: 'read_messages', course_id: id, at: '2026-08-11T04:00:00.000Z' });
  const io = createMemoryIo({ [fileFor('2026-08-11')]: `${good('c-1')}\n{"admin_id":"herman","act\n${good('c-2')}\n` });
  const rows = await readAccess(BASE, {}, { io });
  assert.deepEqual(rows.map((r) => r.course_id), ['c-1', 'c-2'], 'a crash mid-append does not blind the console');
});

test('readAccess: nothing logged yet reads as empty, not as an error', async () => {
  assert.deepEqual(await readAccess(BASE, {}, { io: createMemoryIo() }), []);
});

test('append then read: the round trip carries every field the ADR names', async () => {
  const io = createMemoryIo();
  await appendAccess(BASE, {
    admin_id: 'herman', action: 'read_messages', course_id: 'c-7', subject: '2.1', excerpt: '孩子们在讨论蚂蚁。',
  }, { io, now: () => at(2026, 8, 11, 14) });
  const [row] = await readAccess(BASE, { from: '2026-08-11', to: '2026-08-11' }, { io });
  assert.equal(row.admin_id, 'herman');
  assert.equal(row.action, 'read_messages');
  assert.equal(row.course_id, 'c-7');
  assert.equal(row.subject, '2.1');
  assert.equal(row.excerpt, '孩子们在讨论蚂蚁。');
  assert.ok(row.at.endsWith('Z'), 'who, what, when — the when is a full UTC stamp');
});

// ---------------------------------------------------------------- prune

test('prune: removes only past the window, keeps the cutoff day, never today', async () => {
  const io = seedDays([dayBefore(0), dayBefore(1), dayBefore(89), dayBefore(90), dayBefore(91), dayBefore(400)]);
  const now = () => at(2026, 8, 11, 3, 0);   // early morning: rotation must not drift
  const result = await pruneAccess(BASE, RETENTION_DAYS, { io, now });

  assert.deepEqual(result.removed.sort(), [dayBefore(400), dayBefore(91)].sort(), 'only files older than 90 days');
  assert.deepEqual(result.kept.sort(), [dayBefore(0), dayBefore(1), dayBefore(89), dayBefore(90)].sort(),
    'a file exactly 90 days old is 90 days old, not older');
  assert.deepEqual(result.failed, []);
  assert.ok(io.files.has(fileFor(dayBefore(0))), "today's file is still there");
  assert.ok(!io.files.has(fileFor(dayBefore(91))));
});

test('prune: even a zero-day window leaves today alone', async () => {
  const io = seedDays([dayBefore(0), dayBefore(1)]);
  const result = await pruneAccess(BASE, 0, { io, now: () => at(2026, 8, 11) });
  assert.deepEqual(result.kept, [dayBefore(0)]);
  assert.deepEqual(result.removed, [dayBefore(1)]);
  assert.ok(io.files.has(fileFor(dayBefore(0))), 'the current day survives every window');
});

test('prune: files it did not write are never touched', async () => {
  const foreign = path.join(logDir(BASE), 'README.txt');
  const backup = path.join(logDir(BASE), '2020-01-01.jsonl.bak');
  const io = seedDays([dayBefore(0), dayBefore(400)]);
  io.files.set(foreign, 'notes');
  io.files.set(backup, 'archived');

  const result = await pruneAccess(BASE, RETENTION_DAYS, { io, now: () => at(2026, 8, 11) });
  assert.deepEqual(result.removed, [dayBefore(400)]);
  assert.ok(io.files.has(foreign), 'someone else put it there');
  assert.ok(io.files.has(backup), 'an archived copy is not ours to delete');
});

test('prune: an empty directory is a no-op, and the cutoff is reported', async () => {
  const result = await pruneAccess(BASE, RETENTION_DAYS, { io: createMemoryIo(), now: () => at(2026, 8, 11) });
  assert.deepEqual(result, { removed: [], kept: [], failed: [], cutoff: dayBefore(RETENTION_DAYS) });
});
