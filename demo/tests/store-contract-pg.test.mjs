// store-contract-pg.test.mjs — the store contract, against PostgreSQL.
//
// The sibling of store-contract-json.test.mjs, and the reason the contract was
// factored out at all: ADR-0013 names 「the store test suite passing against
// both implementations」 as the proof that swapping json-store for pg-store is
// safe. Same assertions, second implementation.
//
// IT SKIPS WITHOUT `DATABASE_URL`, and that is a correctness requirement rather
// than a convenience. There is no PostgreSQL on a developer laptop here — the
// database runs on the Lighthouse VM (ADR-0013 §1) — so a suite that tried to
// connect would fail on every machine that has ever run this repository's
// tests, and a test that fails locally is a broken build, not a finding.
// runStoreContract calls makeStore lazily, inside the first test, so nothing
// below opens a connection while the suite is skipped.
//
// To run it, against a database that has 001–004 plus the auth-plane migration
// pg-store.mjs describes:
//
//   DATABASE_URL=postgresql://app_rw:…@localhost:5432/teacher_platform \
//   DATABASE_URL_ADMIN=postgresql://app_admin:…@localhost:5432/teacher_platform \
//   node --test demo/tests/store-contract-pg.test.mjs
//
// Point it at app_rw, never at `postgres` and never at `app_owner`: a superuser
// ignores row-level security entirely, so the suite would pass while proving
// nothing about the isolation it exists to check (demo/migrations/README.md).
// Run it on a database that can be thrown away. The contract cleans up after
// itself — every user it creates is erased in an after-hook — but it writes
// real rows to real tables while it runs.
//
// Without DATABASE_URL_ADMIN the store uses one connection for both planes.
// That is the single-role development case; on a properly roled database the
// auth plane then fails closed (app_rw cannot read another teacher's row), so
// the contract's user tests fail loudly rather than the isolation quietly
// widening.

import test from 'node:test';
import assert from 'node:assert/strict';

import { runStoreContract } from './store-contract.test.mjs';

// A string skip reason surfaces in the test report, so a run that quietly
// tested nothing says so out loud instead of looking like 25 passing tests.
const skip = !process.env.DATABASE_URL
  && 'DATABASE_URL 未设置——本机没有 PostgreSQL，跳过（ADR-0013：数据库只在 Lighthouse 服务器上）';

runStoreContract('pg-store', async () => {
  // Dynamic import for the same reason store.mjs uses one: `pg` is the only
  // dependency this repository has, and a static import here would break every
  // other test file's run on a machine that has not installed it.
  const { createPgStore } = await import('../src/store/pg-store.mjs');
  const store = createPgStore({
    connectionString: process.env.DATABASE_URL,
    adminConnectionString: process.env.DATABASE_URL_ADMIN,
  });
  // dispose runs after the contract's own row cleanup, so the pools are still
  // open while its users are being erased.
  return { store, dispose: () => store.close() };
}, { skip });

// ===========================================================================
// TIER PARITY — the one check that does NOT need a database
// ===========================================================================
// The contract suite above proves the two tiers BEHAVE the same, and it skips
// on every machine without PostgreSQL — so a method that exists only in
// json-store passes the whole gate and is discovered the day the swap happens,
// as a TypeError in a teacher's turn. This test is the cheap standing guard
// against that: it constructs both stores (a pg.Pool opens no connection until
// something queries it) and compares the surfaces.
//
// It skips only when `pg` is not installed, which is the static-tier case.
test('both tiers expose the same surface — a method on one only is a defect', async (t) => {
  let createPgStore;
  try {
    ({ createPgStore } = await import('../src/store/pg-store.mjs'));
  } catch {
    return t.skip('pg 未安装——静态层不带这个依赖');
  }
  const { createJsonStore } = await import('../src/store/json-store.mjs');

  const json = createJsonStore({ baseDir: '/nonexistent-never-read' });
  // A syntactically valid URL nothing will ever dial: no query is issued here,
  // and `new pg.Pool` connects lazily.
  const pgs = createPgStore({
    connectionString: 'postgresql://app_rw:x@127.0.0.1:1/none',
    adminConnectionString: 'postgresql://app_admin:x@127.0.0.1:1/none',
  });

  const methods = (s) => new Set(Object.keys(s).filter((k) => typeof s[k] === 'function'));
  const inJson = methods(json);
  const inPg = methods(pgs);

  const missing = [...inJson].filter((m) => !inPg.has(m)).sort();
  assert.deepEqual(missing, [], `pg-store 少了这些方法：${missing.join(', ')}`);

  // The other direction is not symmetric — `close()` releases the pools and has
  // no meaning for a directory — so it is listed rather than asserted away.
  const extra = [...inPg].filter((m) => !inJson.has(m)).sort();
  assert.deepEqual(extra, ['close'], `pg-store 多出来的方法只应该是 close：${extra.join(', ')}`);

  // Named explicitly as well, because a surface comparison would also pass if
  // BOTH tiers were missing something. These are the methods ADR-0011 / ADR-0009
  // / ADR-0013 §6 need and neither tier had.
  for (const m of [
    'listFacts', 'recordFact', 'archiveFact', 'widenFact', 'touchFactsUsed',
    'listClasses', 'createClass', 'updateClass', 'setDefaultClass', 'setCourseClass',
    'recordSignal', 'listSignals', 'getMaterial', 'listMaterialIds', 'adminListFacts',
  ]) {
    assert.equal(typeof json[m], 'function', `json-store 缺 ${m}`);
    assert.equal(typeof pgs[m], 'function', `pg-store 缺 ${m}`);
  }
  // And the ones that must NOT exist, in either tier: app_rw holds no DELETE on
  // facts or materials (002_roles.sql), so either would pass the JSON suite and
  // fail with 42501 in production.
  for (const m of ['deleteFact', 'deleteMaterial', 'deleteClass', 'deleteSignal']) {
    assert.equal(json[m], undefined, `json-store 不该有 ${m}`);
    assert.equal(pgs[m], undefined, `pg-store 不该有 ${m}`);
  }

  await pgs.close();
});

// ===========================================================================
// ADR-0013 §5's PROOF OBLIGATION
// ===========================================================================
// 「A test that connects as teacher A and tries to read teacher B's course, and
// gets nothing. Without that test this section is a wish.」
//
// The contract suite above cannot be that test, and the reason is worth
// stating: every teacher-plane query in pg-store ALSO carries an explicit
// `WHERE user_id = $1`. That habit is deliberate, and it means the contract
// returns identical results against a database with row-level security
// disabled, with FORCE missing, or with DATABASE_URL pointed at `postgres`.
// The suite would pass and prove nothing about isolation.
//
// So this test goes AROUND the store: a raw connection, a raw transaction, and
// queries carrying NO user predicate at all. Whatever comes back is what the
// POLICY decided, with nothing in front of it.
//
// Three blocks, because the three failure modes are different:
//   ① A asks for B's course BY ID, with no filter        → must be 0
//   ② A asks for her own                                 → must be 1 (else the
//                                                           policy is just off)
//   ③ nobody set app.user_id at all                      → must be 0, not
//                                                           everything
// ③ is the behaviour of a code path that forgot to name its user, and it is the
// one that decides whether `SET LOCAL app.user_id` is the ONLY thing standing
// between two teachers.
test('RLS is real: teacher A cannot read teacher B\'s course, and a nameless connection reads nothing',
  { skip: skip || (!process.env.DATABASE_URL_ADMIN && 'DATABASE_URL_ADMIN 未设置——两个平面需要两个角色') },
  async (t) => {
    const pg = (await import('pg')).default;
    const { createPgStore } = await import('../src/store/pg-store.mjs');

    const store = createPgStore({
      connectionString: process.env.DATABASE_URL,
      adminConnectionString: process.env.DATABASE_URL_ADMIN,
    });
    const stamp = Date.now().toString(36);
    const a = await store.createUser({ username: `rls_a_${stamp}`, displayName: `RLS甲${stamp}` });
    const b = await store.createUser({ username: `rls_b_${stamp}`, displayName: `RLS乙${stamp}` });
    const courseA = await store.createCourse(a.user.id, 'A 的醒狮');
    const courseB = await store.createCourse(b.user.id, 'B 的龙舟');

    // The raw connection. DATABASE_URL points at app_rw — never at `postgres`,
    // which ignores every policy and would make all three blocks pass while
    // proving the opposite of what they claim.
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    t.after(async () => {
      await client.end().catch(() => {});
      await store.eraseUser(null, a.user.id, {}).catch(() => {});
      await store.eraseUser(null, b.user.id, {}).catch(() => {});
      await store.close();
    });

    const count = async (sql, params) => Number((await client.query(sql, params)).rows[0].n);
    // `set_config(name, value, true)` IS `SET LOCAL`, and it is the only
    // spelling that accepts a parameter.
    const asA = async (fn) => {
      await client.query('BEGIN');
      try {
        await client.query("SELECT set_config('app.user_id', $1, true)", [a.user.id]);
        return await fn();
      } finally {
        await client.query('COMMIT').catch(() => {});
      }
    };

    // ① The violating direction. No `WHERE user_id`, on purpose.
    const stolen = await asA(() => count('SELECT count(*)::int AS n FROM courses WHERE id = $1', [courseB.id]));
    assert.equal(stolen, 0, 'A 用 id 直接问 B 的课程，必须一行都拿不到');

    // …and the same question about the tables that hang off it.
    const stolenMessages = await asA(() => count(
      'SELECT count(*)::int AS n FROM messages WHERE course_id = $1', [courseB.id],
    ));
    assert.equal(stolenMessages, 0, 'B 的消息同样不可见');

    // ② MUST PASS — her own row still comes back. Without this the test would
    // also pass against a database that returns nothing to anybody, which is
    // isolation by breakage rather than by policy.
    const mine = await asA(() => count('SELECT count(*)::int AS n FROM courses WHERE id = $1', [courseA.id]));
    assert.equal(mine, 1, 'A 读自己的课程必须读得到——否则这个测试证明的是「全都坏了」');

    // ③ The forgotten identity. No SET LOCAL anywhere in this transaction.
    await client.query('BEGIN');
    const nameless = await count('SELECT count(*)::int AS n FROM courses');
    const namelessMessages = await count('SELECT count(*)::int AS n FROM messages');
    await client.query('COMMIT');
    assert.equal(nameless, 0, '没有 SET LOCAL 的连接必须看到 0 行，而不是全部');
    assert.equal(namelessMessages, 0, '消息同理');
  });
