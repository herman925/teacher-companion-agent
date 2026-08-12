// store-contract.test.mjs — ONE suite, every implementation of store.mjs.
//
// ADR-0013's consequences name this file: 「`pg-store.mjs` behind the existing
// `store.mjs` facade … with the store test suite passing against both
// implementations as the proof the swap is safe」. Today json-store is the only
// implementation; pg-store is next. A suite that only ever ran against the JSON
// tier would prove nothing about the swap, so the assertions live here, in a
// factory, and each implementation gets a three-line runner file.
//
// This file exports `runStoreContract` and declares no tests of its own — run
// directly it reports zero tests and passes, which is correct.
//
// WHAT MAY BE ASSERTED HERE — the rule that keeps the suite portable:
//   * only behaviour store.mjs's interface comment, DATABASE.md or an ADR
//     promises. Not 「json-store happens to do this」.
//   * no filesystem. No reading .data files, no path assumptions. The second
//     implementation has tables, not files.
//   * no insertion order beyond what the interface promises. Message ids are
//     OPAQUE and only ever increase — json numbers them per course, the
//     Postgres shape numbers them globally (DATABASE.md §2), and a contract that
//     asserts `id === 1` would pass here and fail there for no real reason.
//   * no assumption of an empty store. A Postgres runner points at ONE database
//     that other runs have already used, so every test scopes itself to rows it
//     created (unique usernames, unique rule names) and never asserts a total.
//   * clean up. Every user this suite creates is erased afterwards, so running
//     it twice against one database is the same as running it once.
//
// The pg runner will be `runStoreContract('pg-store', makePgStore, { skip:
// !process.env.DATABASE_URL })` — makeStore is never called when skipped, so no
// connection is attempted on a machine with no database.

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * Assert a call rejects with a store error carrying this HTTP status.
 * serve.mjs maps `e.status ?? 500` straight onto the reply, so the NUMBER is
 * part of the interface, not an implementation detail: a second store that
 * throws a bare Error turns 「课程不存在」 into a 500 and the client's error
 * handling stops working.
 * @param {() => Promise<unknown>} fn
 * @param {number} status
 * @param {string} why
 */
function rejectsWithStatus(fn, status, why) {
  return assert.rejects(fn, (e) => {
    assert.equal(e.status, status, `${why} — expected status ${status}, got ${e.status} (${e.message})`);
    return true;
  }, why);
}

/** A short, unique, username-legal token: usernames are `[a-z0-9_-]{3,24}`. */
const suffix = () => randomUUID().replace(/-/g, '').slice(0, 10);

/**
 * @typedef {{ store: Object, dispose?: () => Promise<void>|void }} StoreHandle
 *   `dispose` releases whatever the runner allocated — a temp directory, a
 *   connection pool. It runs after every test, and after the suite's own
 *   row cleanup, so a pool is still open while users are being erased.
 */

/**
 * Declare the store contract against one implementation.
 *
 * @param {string} name label for the test titles, e.g. 'json-store'
 * @param {() => Promise<StoreHandle|Object>|StoreHandle|Object} makeStore
 *   Called AT MOST ONCE, lazily, inside the first test — never at module load.
 *   That laziness is what lets the Postgres runner declare its tests and skip
 *   them without opening a connection. May return the store itself or a
 *   {store, dispose} handle.
 * @param {{ skip?: boolean|string }} [opts]
 *   `skip: !process.env.DATABASE_URL` for any runner needing a live database.
 *   A test that fails because the machine has no Postgres is a broken build,
 *   not a finding.
 */
export function runStoreContract(name, makeStore, { skip = false } = {}) {
  if (typeof makeStore !== 'function') throw new TypeError('runStoreContract: makeStore must be a function');

  /** @type {StoreHandle|null} */
  let handle = null;
  /** @type {Promise<Object>|null} */
  let opening = null;
  /** Users this suite created, erased in the after-hook so a second run starts
   * from the same place as the first. A Set because a test may erase its own. */
  const users = new Set();

  const open = () => {
    if (!opening) {
      opening = Promise.resolve(makeStore()).then((made) => {
        handle = made && typeof made === 'object' && made.store ? made : { store: made };
        return handle.store;
      });
    }
    return opening;
  };

  /** Declare one contract test. The store arrives already opened. */
  const t = (title, fn) => test(`${name} · ${title}`, { skip }, async (ctx) => fn(await open(), ctx));

  test.after(async () => {
    if (!handle) return;                       // skipped, or nothing ever opened
    const store = handle.store;
    for (const id of users) {
      // Erase, not revoke: revoked rows KEEP their data (ADR-0013 §11), which
      // would leave this suite's courses in a shared database forever.
      try {
        if (typeof store.eraseUser === 'function') await store.eraseUser(null, id);
        else if (typeof store.deleteUser === 'function') await store.deleteUser(id);
      } catch { /* a test may have erased it already; cleanup is best-effort */ }
    }
    if (typeof handle.dispose === 'function') await handle.dispose();
  });

  /**
   * A fresh teacher, tracked for cleanup. Every name carries a random suffix
   * because usernames and display names are both unique and the database may
   * already hold a previous run's rows.
   * @returns {Promise<{id: string, username: string, password: string}>}
   */
  async function newUser(store, { role = 'teacher', label = 'c' } = {}) {
    const s = suffix();
    const { user, temp_password } = await store.createUser({
      username: `${label}_${s}`, displayName: `老师_${label}_${s}`, role,
    });
    users.add(user.id);
    return { id: user.id, username: user.username, password: temp_password };
  }

  // ==================== courses ====================

  t('courses: create, read, list — and one teacher never sees another\'s', async (store) => {
    const a = await newUser(store);
    const b = await newUser(store);

    assert.deepEqual(await store.listCourses(a.id), [], '新老师名下什么都没有');

    const created = await store.createCourse(a.id, '醒狮');
    assert.ok(created.id, 'createCourse returns a brief with an id');
    assert.equal(created.title, '醒狮');
    assert.equal(created.state_version, 0, 'a new course is at version 0, before any delta');
    assert.ok(Date.parse(created.updated_at) > 0, 'updated_at is a sortable timestamp');

    const head = await store.getCourse(a.id, created.id);
    assert.equal(head.id, created.id);
    assert.equal(head.state_version, 0);
    // The state document is seeded at creation, not left null: every caller
    // downstream (engine, prompt builder) reads it without a null branch.
    assert.equal(typeof head.course_state, 'object');
    assert.equal(head.course_state.stage, 0, '新课程从第 0 阶段起步');

    // Owner scoping. ADR-0013 §5 makes this the database's job in the Postgres
    // tier — 「a query that forgets its filter returns nothing instead of
    // everything」 — and its proof obligation starts here, at the interface.
    assert.equal(await store.getCourse(b.id, created.id), null, 'B 读不到 A 的课程');
    assert.deepEqual(await store.listCourses(b.id), [], 'and it is not in her list either');
    // NEW SHAPE since ADR-0013 §6 was implemented: deleteCourse returns a
    // receipt, not a boolean, because 「it worked」 told a caller nothing about
    // the COS objects it still owns. `deleted` is the old boolean.
    assert.deepEqual(
      await store.deleteCourse(b.id, created.id),
      { deleted: false, cos_keys: [], objects_deleted: false },
      'nor can she delete it',
    );
    assert.ok(await store.getCourse(a.id, created.id), '被拒绝的删除什么都没改');

    const second = await store.createCourse(a.id, '龙舟');
    const list = await store.listCourses(a.id);
    assert.deepEqual(new Set(list.map((c) => c.id)), new Set([created.id, second.id]));
    // Newest-first, asserted as a PROPERTY rather than a fixed row order: two
    // courses created in the same millisecond tie, and a contract that depends
    // on the tie-break fails on a faster machine for no product reason.
    for (let i = 1; i < list.length; i += 1) {
      assert.ok(Date.parse(list[i - 1].updated_at) >= Date.parse(list[i].updated_at), '课程列表按更新时间倒序');
    }
    assert.ok(list.every((c) => !('course_state' in c)), '列表给的是简要行，不是每门课的完整状态文档');

    assert.equal((await store.deleteCourse(a.id, second.id)).deleted, true);
    assert.equal(await store.getCourse(a.id, second.id), null);
    assert.equal((await store.deleteCourse(a.id, second.id)).deleted, false, '重复删除是 false，不是异常');
  });

  // ---------------- deleting a course deletes its objects (ADR-0013 §6) ----
  // 「Orphaned child photos in a bucket nobody tracks are the failure mode to
  // design against.」 The materials row is the ONLY record of an object key, so
  // this is the one ordering that cannot be got wrong: keys out, objects gone,
  // rows removed. Both directions — the injected deleter is used when given,
  // and the keys still come back when it is not.
  t('deleteCourse: objects before rows, and the keys come back either way', async (store, ctx) => {
    if (typeof store.recordMaterial !== 'function') {
      return ctx.skip('this store has no materials surface yet');
    }
    const a = await newUser(store);
    const course = await store.createCourse(a.id, '龙舟');
    const other = await store.createCourse(a.id, '醒狮');
    await store.recordMaterial(a.id, course.id, {
      kind: 'photo', mime_type: 'image/jpeg', cos_key: `courses/${course.id}/one.jpg`,
      size_bytes: 1024, exif_stripped: true, contains_children: true,
    });
    await store.recordMaterial(a.id, course.id, {
      kind: 'photo', mime_type: 'image/png', cos_key: `courses/${course.id}/two.png`,
      size_bytes: 2048, exif_stripped: true, contains_children: true,
    });
    // A material on a DIFFERENT course, which must survive untouched.
    await store.recordMaterial(a.id, other.id, {
      kind: 'photo', mime_type: 'image/jpeg', cos_key: `courses/${other.id}/keep.jpg`,
      size_bytes: 512, exif_stripped: true, contains_children: false,
    });

    // No deleter: the keys are the caller's obligation, and it is told so.
    const noDeleter = await store.deleteCourse(a.id, course.id);
    assert.equal(noDeleter.deleted, true);
    assert.equal(noDeleter.objects_deleted, false, 'the store owns no COS client');
    assert.deepEqual(
      [...noDeleter.cos_keys].sort(),
      [`courses/${course.id}/one.jpg`, `courses/${course.id}/two.png`],
      '每个对象键都要回到调用方手上，否则那张照片再也找不到了',
    );
    assert.deepEqual(
      (await store.listMaterials(a.id, course.id)), [], '行也删掉了，不是只删了课程',
    );
    assert.equal((await store.listMaterials(a.id, other.id)).length, 1, '另一门课的素材原封不动');

    // With a deleter: every object is removed BEFORE the row that names it.
    const third = await store.createCourse(a.id, '舞龙');
    await store.recordMaterial(a.id, third.id, {
      kind: 'photo', mime_type: 'image/jpeg', cos_key: `courses/${third.id}/x.jpg`,
      size_bytes: 100, exif_stripped: true, contains_children: true,
    });
    const seen = [];
    const receipt = await store.deleteCourse(a.id, third.id, {
      deleteObject: async (key) => {
        // The row must still exist while the object is being deleted — that IS
        // the ordering rule, and it is what makes a failed run repeatable.
        const still = await store.listMaterials(a.id, third.id);
        assert.equal(still.length, 1, '对象删完之前，行必须还在（否则键就丢了）');
        seen.push(key);
      },
    });
    assert.equal(receipt.deleted, true);
    assert.equal(receipt.objects_deleted, true);
    assert.deepEqual(seen, [`courses/${third.id}/x.jpg`]);
    assert.deepEqual(await store.listMaterials(a.id, third.id), []);
  });

  // MUST PASS UNTOUCHED: a course with no uploads deletes exactly as before,
  // reporting an empty key list rather than null or a missing field.
  t('deleteCourse: a course with no materials reports an empty key list', async (store) => {
    const a = await newUser(store);
    const course = await store.createCourse(a.id, '没有照片的课');
    const r = await store.deleteCourse(a.id, course.id);
    assert.deepEqual(r, { deleted: true, cos_keys: [], objects_deleted: false });
  });

  t('courses: the 30-course quota belongs to the store, per teacher', async (store) => {
    const a = await newUser(store);
    for (let i = 0; i < 30; i += 1) await store.createCourse(a.id, `课${i}`);
    assert.equal((await store.listCourses(a.id)).length, 30);

    await rejectsWithStatus(() => store.createCourse(a.id, '第三十一门'), 409, '超额创建必须被拒');
    assert.equal((await store.listCourses(a.id)).length, 30, '被拒的创建没有留下半门课');

    // MUST PASS UNTOUCHED: the quota counts one teacher, not the instance.
    const b = await newUser(store);
    assert.ok((await store.createCourse(b.id, '别人的课')).id, '别人的额度不受影响');
  });

  t('courses: rename, and the lock that stops auto-titling overwriting a person', async (store) => {
    const a = await newUser(store);
    const c = await store.createCourse(a.id);
    assert.ok(c.title.length > 0, 'an untitled course still has a name to render');
    assert.equal(await store.isUntitled(c.id), true, '还没起名的课程才允许自动命名');

    const auto = await store.renameCourse(a.id, c.id, '醒狮', { auto: true });
    assert.equal(auto.title, '醒狮');
    assert.equal(await store.isUntitled(c.id), false, '有名字之后自动命名就不再看它');

    await store.renameCourse(a.id, c.id, '龙舟');                      // human rename locks
    const refused = await store.renameCourse(a.id, c.id, '自动名', { auto: true });
    assert.equal(refused.title, '龙舟', '人取的名字，自动命名不许覆盖');
    assert.equal((await store.getCourse(a.id, c.id)).title, '龙舟');

    // Both directions on the length rule: a rail row, not a sentence.
    await rejectsWithStatus(() => store.renameCourse(a.id, c.id, '   '), 400, '空名字要拒');
    await rejectsWithStatus(() => store.renameCourse(a.id, c.id, 'x'.repeat(64)), 400, '过长的名字要拒');
    const b = await newUser(store);
    await rejectsWithStatus(() => store.renameCourse(b.id, c.id, '抢名字'), 404, '别人的课程改不了名');
    assert.equal((await store.getCourse(a.id, c.id)).title, '龙舟', '而且什么都没改');
  });

  // ==================== messages, and the subject tag ====================

  t('messages: one ordered log per course, the subject is a tag over it', async (store) => {
    const a = await newUser(store);
    const c = await store.createCourse(a.id, '龙舟');
    assert.deepEqual(await store.getMessages(c.id), [], '新课程没有历史');

    // Exactly the call every pre-subject caller makes. It must not change shape
    // — that default is what makes the tag additive (ADR-0010 §1).
    const m1 = await store.appendMessage(c.id, { role: 'teacher', content: '整体怎么排' });
    assert.equal(m1.subject, 'course', '没有主题的消息就是课程级的');
    assert.equal(m1.role, 'teacher');
    assert.equal(m1.content, '整体怎么排');
    assert.ok(m1.id != null);
    assert.ok(Date.parse(m1.created_at) > 0);

    const m2 = await store.appendMessage(c.id, { role: 'teacher', content: '3.2.1 太难了', subject: '3.2.1' });
    const m3 = await store.appendMessage(c.id, {
      role: 'agent', content: '拆成两步', subject: '3.2.1',
      provider: 'mock', provider_label: '演示模型',
      usage: { prompt_tokens: 7, completion_tokens: 3 },
      turn_contract: { reply_markdown: '拆成两步', evidence_refs: [] },
    });
    const m4 = await store.appendMessage(c.id, { role: 'teacher', content: '周2 我改一下', subject: '周2' });

    const all = await store.getMessages(c.id);
    assert.deepEqual(all.map((r) => r.id), [m1, m2, m3, m4].map((r) => r.id), '一条日志，按时间读回来');
    for (let i = 1; i < all.length; i += 1) {
      // Ids are opaque and only ever increase. Their ABSOLUTE values are the
      // implementation's business (per-course counter here, global identity in
      // the Postgres shape) and no caller may depend on them.
      assert.ok(all[i].id > all[i - 1].id, 'message ids increase along the log');
    }
    // The turn's own record rides with the row: cost tracking and audit both
    // read these back out of storage, never out of the live turn.
    const agent = all.find((r) => r.id === m3.id);
    assert.equal(agent.provider, 'mock');
    assert.deepEqual(agent.usage, { prompt_tokens: 7, completion_tokens: 3 });
    assert.equal(agent.turn_contract.reply_markdown, '拆成两步');

    const node = await store.getMessages(c.id, { subject: '3.2.1' });
    assert.deepEqual(node.map((r) => r.id), [m2.id, m3.id], '过滤之后仍是同一批全局 id');
    const week = await store.getMessages(c.id, { subject: '周2' });
    // The whole reason for one log rather than a log per node: this comparison
    // is possible at all.
    assert.ok(node.at(-1).id < week[0].id, '她先问了 3.2.1，之后才改 周2 —— 顺序可证');
    assert.deepEqual(await store.getMessages(c.id, { subject: '没人聊过的节点' }), []);

    // Paging composes with the filter instead of replacing it.
    assert.deepEqual((await store.getMessages(c.id, { subject: '3.2.1', limit: 1 })).map((r) => r.id), [m3.id]);
    assert.deepEqual((await store.getMessages(c.id, { subject: '3.2.1', before: m3.id })).map((r) => r.id), [m2.id]);
    assert.deepEqual((await store.getMessages(c.id, { limit: 2 })).map((r) => r.id), [m3.id, m4.id], 'limit 取最近 N 条');

    // Logs do not leak across courses.
    const other = await store.createCourse(a.id, '别的课');
    await store.appendMessage(other.id, { role: 'teacher', content: '另一门课的第一句' });
    assert.equal((await store.getMessages(c.id)).length, 4, '别的课程的消息不会串进来');
    assert.equal((await store.getMessages(other.id)).length, 1);
  });

  t('messages: the subject is engine-owned — what the model asked for is ignored', async (store) => {
    const a = await newUser(store);
    const c = await store.createCourse(a.id, '龙舟');

    // A model choosing its own subject would be choosing its own blast radius
    // (ADR-0010 §2). Its words stay on the record; the tag comes from the
    // caller alone.
    const stray = await store.appendMessage(c.id, {
      role: 'agent', content: '好的',
      turn_contract: { reply_markdown: '好的', subject: '9.9.9' },
    });
    assert.equal(stray.subject, 'course', '模型自选的主题不会变成标签');
    assert.equal(stray.turn_contract.subject, '9.9.9', '但它说过什么仍然留在记录里');

    const tagged = await store.appendMessage(c.id, {
      role: 'agent', content: '拆成两步', subject: '3.2.1',
      turn_contract: { reply_markdown: '拆成两步', subject: '9.9.9' },
    });
    assert.equal(tagged.subject, '3.2.1', '调用方给的主题赢过模型给的');
    assert.deepEqual(await store.getMessages(c.id, { subject: '9.9.9' }), [], '模型自选的主题从未落库');
  });

  t('messages: a missing course refuses the write and reads as empty history', async (store) => {
    // A random UUID rather than a made-up string: the Postgres shape types
    // course ids as uuid, and 'nope' would fail as a cast error instead of the
    // 404 this contract is about.
    const ghost = randomUUID();
    await rejectsWithStatus(
      () => store.appendMessage(ghost, { role: 'teacher', content: '写进不存在的课程' }),
      404, '不存在的课程不能追加消息',
    );
    assert.deepEqual(await store.getMessages(ghost), [], '读不存在的课程是空历史，不是异常');
  });

  // ==================== snapshots and the optimistic lock ====================

  t('saveState: optimistic lock, and a snapshot trail that can be replayed', async (store) => {
    const a = await newUser(store);
    const c = await store.createCourse(a.id, '醒狮');
    const head = await store.getCourse(a.id, c.id);

    const v1 = await store.saveState(
      c.id, { theme_resource: { name: '醒狮' } },
      { ...head.course_state, theme_resource: { name: '醒狮' } }, head.state_version,
    );
    assert.equal(v1.state_version, 1, '每次应用的 delta 把版本推进一格');
    const afterOne = await store.getCourse(a.id, c.id);
    assert.equal(afterOne.state_version, 1);
    assert.equal(afterOne.course_state.theme_resource.name, '醒狮');

    // The lock. A caller holding a stale version loses, and loses cleanly —
    // DATABASE.md §3: 「a stale write aborts the whole transaction — no
    // half-applied turns」.
    await rejectsWithStatus(
      () => store.saveState(c.id, {}, { ...afterOne.course_state, stage: 9 }, 0),
      409, '拿着旧版本号的写入必须冲突',
    );
    const unchanged = await store.getCourse(a.id, c.id);
    assert.equal(unchanged.state_version, 1, '冲突之后版本没动');
    assert.notEqual(unchanged.course_state.stage, 9, '也没有留下半个状态');

    // Stage change forces a checkpoint (DATABASE.md §2).
    const v2 = await store.saveState(c.id, { stage: 1 }, { ...afterOne.course_state, stage: 1 }, 1);
    assert.equal(v2.state_version, 2);

    // Omitting the version is an unconditional write. The facade's own
    // signature makes it the last argument, and a caller that never read the
    // head (an importer, a repair script) must not have to invent one.
    const v3 = await store.saveState(c.id, { note: 'unconditional' }, { ...afterOne.course_state, stage: 1, note: 'x' });
    assert.equal(v3.state_version, 3);

    await rejectsWithStatus(() => store.saveState(randomUUID(), {}, {}, 0), 404, '不存在的课程不能存状态');

    const record = await store.adminGetCourse(c.id);
    const snaps = record.snapshots;
    assert.equal(snaps.length, 3, '三次成功的写入留下三行，冲突的那次没有留行');
    const byVersion = new Map(snaps.map((s) => [s.state_version, s]));
    assert.deepEqual([...byVersion.keys()].sort((x, y) => x - y), [1, 2, 3]);
    for (const s of snaps) {
      assert.ok(s.state_delta && typeof s.state_delta === 'object', '每一行都带着它应用的 delta');
      // checkpoint ⇔ full document. Reconstruction is 「nearest checkpoint <= V,
      // then replay deltas forward」, so a checkpoint without a document, or a
      // document on a row nobody will look at, both break replay.
      assert.equal(s.is_checkpoint, s.course_state != null, 'is_checkpoint 与全量文档必须同进同出');
    }
    assert.equal(byVersion.get(1).is_checkpoint, true, '第 1 版是检查点，重放永远有起点');
    assert.equal(byVersion.get(2).is_checkpoint, true, '换阶段一定写全量');
    assert.equal(byVersion.get(2).course_state.stage, 1);
  });

  t('workbench: scratch, not history — it must not move the version', async (store) => {
    const a = await newUser(store);
    const c = await store.createCourse(a.id, '醒狮');
    const before = await store.adminGetCourse(c.id);

    const saved = await store.setWorkbench(a.id, c.id, {
      blueprint_comments: [{ id: 'n1', number: '3.2.1', title: '看龙舟', text: '这个对中班太难' }],
      question_cards: {
        questions: [{ text: '班上有多少孩子？', why: '影响分组' }],
        answers: [{ value: '30', skipped: false, locked: true }],
      },
    });
    assert.equal(saved.blueprint_comments[0].text, '这个对中班太难');
    assert.equal(saved.question_cards.answers[0].locked, true);
    assert.ok(Date.parse(saved.updated_at) > 0);

    const head = await store.getCourse(a.id, c.id);
    assert.equal(head.state_version, 0, '未发送的草稿不是一次修订');
    assert.equal((await store.adminGetCourse(c.id)).snapshots.length, (before.snapshots ?? []).length, '也不写快照');

    const b = await newUser(store);
    await rejectsWithStatus(() => store.setWorkbench(b.id, c.id, {}), 404, '别人的工作台写不了');
  });

  t('confirmBlueprintNode: a teacher confirmation IS a revision', async (store) => {
    const a = await newUser(store);
    const c = await store.createCourse(a.id, '醒狮');
    // The engine's confirm function is INJECTED, which is what lets this
    // contract test the store's half — version bump, snapshot, ownership —
    // without pulling the engine's blueprint rules into the persistence proof.
    const engineConfirm = (state, nodeId) => (nodeId === 'known'
      ? { confirmed: true, state: { ...state, course_plan_blueprint: { version: 2, modules: [] }, confirmed_node: nodeId } }
      : { confirmed: false, state });

    const blueprint = await store.confirmBlueprintNode(a.id, c.id, 'known', engineConfirm);
    assert.equal(blueprint.version, 2, 'the store hands back the blueprint the engine produced');
    const head = await store.getCourse(a.id, c.id);
    assert.equal(head.state_version, 1, '确认要升版本，回放和审计才看得见它');
    assert.equal(head.course_state.confirmed_node, 'known');
    assert.equal((await store.adminGetCourse(c.id)).snapshots.length, 1);

    await rejectsWithStatus(() => store.confirmBlueprintNode(a.id, c.id, 'missing', engineConfirm), 400, '引擎说没确认，就不能落库');
    assert.equal((await store.getCourse(a.id, c.id)).state_version, 1, '被拒的确认没有升版本');
    const b = await newUser(store);
    await rejectsWithStatus(() => store.confirmBlueprintNode(b.id, c.id, 'known', engineConfirm), 404, '别人的课程确认不了');
  });

  // ==================== users ====================

  t('users: creation rules both ways, login, and a shape that never carries a hash', async (store) => {
    const s = suffix();
    const uname = `c_${s}`;
    const { user, temp_password } = await store.createUser({
      username: uname.toUpperCase(), displayName: `陈老师_${s}`,
    });
    users.add(user.id);

    assert.equal(user.username, uname, '用户名统一转小写');
    assert.equal(user.role, 'teacher', 'the default role is the least powerful one');
    assert.equal(user.status, 'active');
    assert.equal(user.must_change_password, true, '管理员发的临时口令必须换');
    assert.ok(!('password' in user) && !('password_hash' in user), '公开的用户对象永远不带口令');
    assert.ok(typeof temp_password === 'string' && temp_password.length >= 8);

    await rejectsWithStatus(() => store.createUser({ username: uname }), 409, '用户名不能重');
    await rejectsWithStatus(() => store.createUser({ username: `d_${s}`, displayName: `陈老师_${s}` }), 409, '昵称不能重');
    await rejectsWithStatus(() => store.createUser({ username: 'ab' }), 400, '太短的用户名要拒');
    await rejectsWithStatus(() => store.createUser({ username: `bad name ${s}` }), 400, '带空格的用户名要拒');

    assert.equal((await store.getUser(user.id)).username, uname);
    assert.equal(await store.getUser(randomUUID()), null, '查不到的用户是 null，不是异常');
    assert.ok((await store.listUsers()).some((u) => u.id === user.id));
    assert.ok((await store.listUsers()).every((u) => !('password' in u)), '列表同样不带口令');

    assert.equal(await store.verifyLogin(uname, 'wrong-password'), null);
    assert.equal(await store.verifyLogin(`nobody_${s}`, temp_password), null);
    // Trimmed on purpose: temp passwords are pasted out of chat apps with stray
    // edge whitespace, and no stored password ever has any. Recorded here so a
    // second implementation cannot drop it silently and produce a wave of
    // 「密码不对」 for teachers who typed nothing wrong.
    const ok = await store.verifyLogin(uname.toUpperCase(), ` ${temp_password} `);
    assert.equal(ok?.id, user.id);
    assert.ok(ok.last_login_at, '登录要留时间戳');

    await rejectsWithStatus(() => store.changePassword(user.id, 'not-the-old-one', 'newpass-123'), 403, '旧口令不对就不能改');
    await rejectsWithStatus(() => store.changePassword(user.id, temp_password, 'short'), 400, '太短的新口令要拒');
    assert.equal(await store.changePassword(user.id, temp_password, 'newpass-123'), true);
    assert.equal((await store.getUser(user.id)).must_change_password, false, '换过之后强制换口令的旗子落下');
    assert.equal(await store.verifyLogin(uname, temp_password), null, '旧口令立刻失效');
    assert.ok(await store.verifyLogin(uname, 'newpass-123'));

    const fresh = await store.resetPassword(user.id);
    assert.notEqual(fresh, temp_password);
    assert.equal(await store.verifyLogin(uname, 'newpass-123'), null, '重置之后自己设的口令也失效');
    assert.ok(await store.verifyLogin(uname, fresh));
    assert.equal((await store.getUser(user.id)).must_change_password, true, '重置又把旗子举起来');
    await rejectsWithStatus(() => store.resetPassword(randomUUID()), 404, '不存在的用户重置不了');
  });

  t('users: display name uniqueness and the profile that follows the account', async (store) => {
    const s = suffix();
    const a = await newUser(store);
    const b = await newUser(store);

    const renamed = await store.setDisplayName(a.id, `番禺陈老师_${s}`);
    assert.equal(renamed.display_name, `番禺陈老师_${s}`);
    assert.ok(renamed.display_name_changed_at, '改名要留时间戳，6 个月的锁才有依据');
    // Uniqueness is the store's job; charset and profanity rules are the
    // caller's (auth-util), which is why nothing here asserts them.
    await rejectsWithStatus(() => store.setDisplayName(b.id, `番禺陈老师_${s}`), 409, '昵称被占用了就不能取');
    assert.ok(await store.setDisplayName(a.id, `番禺陈老师_${s}`), '改成自己已有的昵称不算冲突');
    await rejectsWithStatus(() => store.setDisplayName(randomUUID(), `谁_${s}`), 404, '不存在的用户改不了昵称');

    // users.settings.profile (DATABASE.md §2) — prefs, never secrets.
    assert.equal((await store.getUser(a.id)).profile, null, '还没填档案就是 null');
    assert.equal(await store.saveUserProfile(a.id, { age_band: '中班', class_size: 30, region: '番禺' }), true);
    assert.deepEqual((await store.getUser(a.id)).profile, { age_band: '中班', class_size: 30, region: '番禺' });
    await store.saveUserProfile(a.id, null);
    assert.equal((await store.getUser(a.id)).profile, null, '清空档案也要读得回来');
    await rejectsWithStatus(() => store.saveUserProfile(randomUUID(), {}), 404, '不存在的用户没有档案');
  });

  // ==================== sessions ====================

  t('sessions: resolve, list, revoke — and never hand a bearer token back out', async (store) => {
    const a = await newUser(store);
    const { token, sid } = await store.createSession(a.id, 'Mozilla/5.0 番禺一台平板');
    assert.ok(token && sid && token !== sid, 'cookie 值和公开的 sid 是两个不同的字符串');

    const resolved = await store.getSessionUser(token);
    assert.equal(resolved.user.id, a.id);
    assert.equal(resolved.session.sid, sid);
    assert.ok(!('password' in resolved.user));
    assert.equal(await store.getSessionUser('not-a-real-token'), null);
    assert.equal(await store.getSessionUser(null), null);
    assert.equal(await store.getSessionUser(''), null);

    const devices = await store.listSessions(a.id, token);
    const mine = devices.find((d) => d.sid === sid);
    assert.ok(mine, '自己的设备在列表里');
    assert.equal(mine.current, true, '当前设备要标出来');
    assert.equal(mine.user_agent, 'Mozilla/5.0 番禺一台平板');
    // 用户中心 renders this list. A token in it is a token in the DOM.
    assert.equal(JSON.stringify(devices).includes(token), false, '设备列表里没有可用来登录的令牌');

    const b = await newUser(store);
    assert.deepEqual(await store.listSessions(b.id, token), [], '别人的设备列表是空的');
    assert.equal(await store.revokeSession(b.id, sid), false, '不能撤销别人的设备');
    assert.ok(await store.getSessionUser(token), '被拒的撤销什么都没改');

    assert.equal(await store.revokeSession(a.id, sid), true);
    assert.equal(await store.getSessionUser(token), null, '撤销之后令牌立刻不认');
    assert.equal(await store.revokeSession(a.id, sid), false, '重复撤销是 false，不是异常');
    assert.deepEqual(await store.listSessions(a.id, token), [], '撤销之后设备也不再列出来');

    const second = await store.createSession(a.id, 'ua-2');
    assert.equal(await store.revokeByToken(second.token), true);
    assert.equal(await store.getSessionUser(second.token), null);
    assert.equal(await store.revokeByToken(second.token), false);
    assert.equal(await store.revokeByToken('not-a-real-token'), false);
  });

  t('sessions: a user who is no longer active stops resolving', async (store) => {
    const a = await newUser(store);
    const { token } = await store.createSession(a.id, 'ua');
    assert.ok(await store.getSessionUser(token), 'MUST PASS — an active user resolves');

    await store.updateUser(a.id, { status: 'disabled' });
    assert.equal(await store.getSessionUser(token), null, '停用之后会话不再解析');
    assert.equal(await store.verifyLogin(a.username, a.password), null, '也登不进来');

    const back = await store.updateUser(a.id, { status: 'active' });
    assert.equal(back.status, 'active');
    assert.ok(await store.verifyLogin(a.username, a.password), '恢复之后能登录');
    assert.equal(await store.getSessionUser(token), null, '但旧会话已经死了，恢复不会把它救回来');

    const promoted = await store.updateUser(a.id, { role: 'admin' });
    assert.equal(promoted.role, 'admin');
    await rejectsWithStatus(() => store.updateUser(randomUUID(), { role: 'admin' }), 404, '不存在的用户改不了');
  });

  // ==================== audit ====================

  t('audit: every admin action leaves a row, newest first', async (store) => {
    const a = await newUser(store);
    // A unique action name, because a Postgres runner points at a database that
    // already holds rows — this suite may never assert on a total.
    const action = `contract_probe_${suffix()}`;
    await store.audit(null, action, a.id, { note: 'first' });
    await store.audit(a.id, action, a.id, { note: 'second' });

    const rows = await store.listAudit({ limit: 50 });
    const mine = rows.filter((r) => r.action === action);
    assert.equal(mine.length, 2);
    assert.deepEqual(mine.map((r) => r.detail.note), ['second', 'first'], '最新的在前');
    assert.equal(mine[0].admin_id, a.id);
    assert.equal(mine[1].admin_id, null, '没有管理员身份的动作也留痕');
    assert.equal(mine[0].target_user, a.id);
    assert.ok(Date.parse(mine[0].created_at) > 0);
  });

  // ==================== the per-account key vault ====================

  t('keys: ciphertext in, scoped per teacher, and out of every export path', async (store) => {
    const a = await newUser(store);
    const b = await newUser(store);
    assert.deepEqual(await store.getUserKeys(a.id), {}, '没有存过密钥就是 {}，不是 null');

    // The store never sees plaintext — serve.mjs encrypts before it gets here
    // (ADR-0005) — so these are deliberately opaque strings.
    await store.setUserKey(a.id, 'glm', 'ciphertext-a-glm');
    await store.setUserKey(a.id, 'kimi', 'ciphertext-a-kimi');
    await store.setUserKey(b.id, 'glm', 'ciphertext-b-glm');
    assert.deepEqual(await store.getUserKeys(a.id), { glm: 'ciphertext-a-glm', kimi: 'ciphertext-a-kimi' });
    assert.deepEqual(await store.getUserKeys(b.id), { glm: 'ciphertext-b-glm' }, '一个老师的密钥不会串到另一个老师名下');

    await store.setUserKey(a.id, 'glm', 'ciphertext-a-glm-rotated');
    assert.equal((await store.getUserKeys(a.id)).glm, 'ciphertext-a-glm-rotated', '重复写入是替换');
    await store.setUserKey(a.id, 'glm', null);
    assert.deepEqual(await store.getUserKeys(a.id), { kimi: 'ciphertext-a-kimi' }, 'null 是删除，不是空串');

    // The returned map is a copy: the vault is not editable by accident.
    const copy = await store.getUserKeys(a.id);
    copy.kimi = 'tampered';
    assert.equal((await store.getUserKeys(a.id)).kimi, 'ciphertext-a-kimi');

    const course = await store.createCourse(a.id, '醒狮');
    assert.equal(JSON.stringify(await store.adminExportAll()).includes('ciphertext-a-kimi'), false, '密钥不进一键导出');
    assert.equal(JSON.stringify(await store.adminGetCourse(course.id)).includes('ciphertext-a-kimi'), false, '也不进课程原始记录');
    assert.equal(JSON.stringify(await store.listUsers()).includes('ciphertext-a-kimi'), false, '也不进用户列表');
  });

  // ==================== rate-gate state ====================

  t('rate state: an opaque blob, written and read back whole', async (store) => {
    // Singleton, shared state. The suite restores whatever it found, so a
    // second run — or a live rate gate on the same database — is not clobbered
    // by the act of testing.
    const before = await store.loadRateState();
    try {
      const blob = { windows: { 'user:abc': [1, 2, 3] }, updated_at: '2026-08-11T00:00:00.000Z' };
      await store.saveRateState(blob);
      assert.deepEqual(await store.loadRateState(), blob, '存进去什么，读回来什么');
      await store.saveRateState({ windows: {} });
      assert.deepEqual(await store.loadRateState(), { windows: {} }, '第二次写入覆盖第一次');
    } finally {
      if (before != null) await store.saveRateState(before);
    }
  });

  // ==================== scope shell log ====================

  t('scope log: the 60-character excerpt cap is the interface\'s, not one store\'s', async (store) => {
    const a = await newUser(store);
    const rule = `contract_rule_${suffix()}`;
    // 180 characters of teacher message. Length is counted in characters, which
    // for these CJK code points is also JavaScript's string length.
    const long = '今天番禺天气怎么样'.repeat(20);
    assert.ok(long.length > 60, 'the fixture must actually exceed the cap');

    await store.logScope({ rule, enforced: false, refused: false, excerpt: '短的一句', userId: a.id });
    await store.logScope({ rule, enforced: true, refused: true, excerpt: long, userId: a.id });

    const { rows, total, byRule } = await store.listScope({ limit: 50 });
    const mine = rows.filter((r) => r.rule === rule);
    assert.equal(mine.length, 2);
    // Newest first — the admin tab reads the top of this list.
    assert.equal(mine[0].excerpt.length, 60, '摘录上限属于接口，不属于某一个实现');
    assert.equal(mine[0].enforced, true);
    assert.equal(mine[0].refused, true);
    assert.equal(mine[0].user_id, a.id);
    // MUST PASS UNTOUCHED: a short excerpt is stored as written. The cap is a
    // ceiling, not a transformation.
    assert.equal(mine[1].excerpt, '短的一句');
    assert.equal(mine[1].enforced, false);
    assert.equal(mine[1].refused, false);
    assert.ok(Date.parse(mine[0].created_at) > 0);

    assert.equal(byRule[rule], 2, '按规则的计数是这个页签的全部价值');
    assert.ok(total >= 2, 'total counts the whole log, not the page');
  });

  // ==================== the three account states ====================

  t('account states: revoke keeps the data, erase takes it', async (store) => {
    const a = await newUser(store);
    const course = await store.createCourse(a.id, '醒狮');
    await store.appendMessage(course.id, { role: 'teacher', content: '第一问' });
    await store.setUserKey(a.id, 'glm', 'ciphertext-to-be-erased');
    const rule = `contract_erase_${suffix()}`;
    await store.logScope({ rule, enforced: false, refused: false, excerpt: '被擦除的人问过的话', userId: a.id });
    const { token } = await store.createSession(a.id, 'ua');

    // REVOKE — login refused, sessions dead, DATA KEPT (ADR-0013 §11).
    const revoked = await store.revokeUser(null, a.id);
    assert.equal(revoked.status, 'revoked');
    assert.ok(revoked.revoked_at, '保留期的时钟从这里开始走');
    assert.equal(await store.getSessionUser(token), null, '会话立刻停');
    assert.equal(await store.verifyLogin(a.username, a.password), null, '也登不进来');
    assert.ok(await store.getCourse(a.id, course.id), '园里可能还要用去年的课程');
    assert.equal((await store.getMessages(course.id)).length, 1);

    const again = await store.revokeUser(null, a.id);
    assert.equal(again.revoked_at, revoked.revoked_at, '第二次撤销不许把时钟往后拨——否则「已撤销」会悄悄变成「永久保留」');

    assert.equal((await store.dueForErasure(Date.now(), 365)).includes(a.id), false, '刚撤销的账号没到期');
    assert.equal((await store.dueForErasure(Date.now(), 0)).includes(a.id), true, '窗口为 0 天就是立刻到期');
    await rejectsWithStatus(() => store.dueForErasure(Date.now(), Number.NaN), 400, '坏掉的保留期必须报错，不能默默地什么都不删');
    // dueForErasure RETURNS IDS AND ERASES NOTHING: a scheduled job that both
    // finds and deletes has no step where a human can look.
    assert.ok(await store.getUser(a.id), '查到期不等于删账号');

    // ERASE — everything goes.
    const receipt = await store.eraseUser(null, a.id);
    users.delete(a.id);
    assert.equal(receipt.username, a.username, '回执告诉管理员删掉的是谁');
    assert.equal(receipt.deleted.courses, 1);
    assert.equal(receipt.deleted.messages, 1);
    assert.equal(receipt.deleted.key_providers, 1);

    assert.equal(await store.getUser(a.id), null);
    assert.equal(await store.verifyLogin(a.username, a.password), null);
    assert.equal(await store.getCourse(a.id, course.id), null);
    assert.equal(await store.adminGetCourse(course.id), null, '课程不是从列表消失，是真的没了');
    assert.deepEqual(await store.getUserKeys(a.id), {}, '密钥不能比账号活得久');
    assert.equal((await store.adminExportAll()).some((c) => c.id === course.id), false);

    // Operational history survives, the person does not.
    const kept = (await store.listScope({ limit: 50 })).rows.find((r) => r.rule === rule);
    assert.ok(kept, '范围护栏的记录留下来');
    assert.equal(kept.user_id, null, '但那个人没有留下来');
  });

  // ==================== admin console reads ====================

  t('admin: counts, the username join, and delete across owners', async (store) => {
    const a = await newUser(store);
    const course = await store.createCourse(a.id, '醒狮');
    await store.appendMessage(course.id, { role: 'teacher', content: '整体怎么排' });
    await store.appendMessage(course.id, { role: 'teacher', content: '3.2.1 太难了', subject: '3.2.1' });
    await store.appendMessage(course.id, { role: 'agent', content: '拆成两步', subject: '3.2.1' });
    const head = await store.getCourse(a.id, course.id);
    await store.saveState(course.id, {}, {
      ...head.course_state,
      course_plan: {
        version: 8,
        roots: [{
          id: 'p1',
          title: '东乡龙舟',
          children: [
            { id: 'w1', title: '周1', children: [{ id: 'a1', title: '看龙舟', stale_since: '8', stale_reason: '上游改了' }] },
            { id: 'w2', title: '周2', children: [] },
          ],
        }],
      },
    }, head.state_version);

    const row = (await store.adminListCourses()).find((c) => c.id === course.id);
    assert.equal(row.user_id, a.id);
    assert.equal(row.username, a.username, '控制台看的是人，不是 UUID');
    assert.equal(row.messages, 3);
    assert.equal(row.snapshots, 1);
    assert.equal(row.state_version, 1);
    // Scanning-level plan visibility: 「哪些课程有计划」 and 「有多少被标了待复查」
    // are the questions the staleness stamp exists to answer.
    assert.equal(row.plan_version, 8);
    assert.equal(row.plan_nodes, 4);
    assert.equal(row.plan_stale_nodes, 1);
    assert.deepEqual(row.messages_by_subject, { course: 1, '3.2.1': 2 }, '节点级活跃度不用翻原始记录');

    const full = await store.adminGetCourse(course.id);
    assert.equal(full.id, course.id);
    assert.equal(full.user_id, a.id);
    assert.equal(full.messages.length, 3, '完整记录带着消息');
    assert.ok(Array.isArray(full.snapshots), '也带着快照');
    assert.equal(await store.adminGetCourse(randomUUID()), null);
    assert.ok((await store.adminExportAll()).some((c) => c.id === course.id));

    // MUST PASS UNTOUCHED: an empty course reports zeros rather than breaking
    // the console. 「还没消息」 and 「字段没了」 are not the same thing.
    const bare = await store.createCourse(a.id, '空课程');
    const bareRow = (await store.adminListCourses()).find((c) => c.id === bare.id);
    assert.equal(bareRow.plan_version, null);
    assert.equal(bareRow.plan_nodes, 0);
    assert.equal(bareRow.plan_stale_nodes, 0);
    assert.equal(bareRow.messages, 0);
    assert.deepEqual(bareRow.messages_by_subject, {});

    assert.equal((await store.adminDelete(course.id)).deleted, true, '管理员删得了任何人的课程');
    assert.equal((await store.adminDelete(course.id)).deleted, false, '重复删除是 false，不是异常');
    assert.equal(await store.getCourse(a.id, course.id), null);
  });

  // ==================== materials (COS references, never bytes) ====================

  t('materials: allowlists both ways, and owner scoping', async (store, ctx) => {
    if (typeof store.recordMaterial !== 'function') {
      return ctx.skip('this store has no materials surface yet');
    }
    const a = await newUser(store);
    const b = await newUser(store);
    const course = await store.createCourse(a.id, '醒狮');

    const row = await store.recordMaterial(a.id, course.id, {
      kind: 'photo', mime_type: 'image/jpeg', cos_key: `courses/${course.id}/${randomUUID()}.jpg`,
      size_bytes: 2_400_000, exif_stripped: true, contains_children: true,
    });
    assert.ok(row.id);
    assert.equal(row.user_id, a.id);
    assert.equal(row.course_id, course.id);
    assert.equal(row.exif_stripped, true);
    assert.equal(row.contains_children, true, '这条旗子决定保留期和访问规则，必须存住');
    assert.ok(Date.parse(row.created_at) > 0);

    // Reject by default, never blocklist (ADR-0013 §6).
    const key = `courses/${course.id}/${randomUUID()}.exe`;
    await rejectsWithStatus(() => store.recordMaterial(a.id, course.id, { kind: 'video', mime_type: 'image/jpeg', cos_key: key }), 400, '不在白名单里的素材类型要拒');
    await rejectsWithStatus(() => store.recordMaterial(a.id, course.id, { kind: 'photo', mime_type: 'application/x-msdownload', cos_key: key }), 400, '不在白名单里的文件类型要拒');
    // A material with no key is an object nobody can find to delete.
    await rejectsWithStatus(() => store.recordMaterial(a.id, course.id, { kind: 'photo', mime_type: 'image/jpeg', cos_key: '  ' }), 400, '没有对象键的素材要拒');

    assert.deepEqual((await store.listMaterials(a.id, course.id)).map((m) => m.id), [row.id]);
    assert.deepEqual((await store.listMaterials(a.id)).map((m) => m.id), [row.id], '不带课程就是这位老师的全部素材');
    assert.deepEqual(await store.listMaterials(b.id, course.id), [], '别人的素材看不到');
    assert.deepEqual(await store.listMaterials(a.id, randomUUID()), [], '别的课程下也没有');

    // WRITING against someone else's course is refused, not merely unreadable.
    // The Postgres tier gets this from materials_owner's WITH CHECK; the JSON
    // tier used to write the row with whatever course id it was handed, so the
    // two tiers disagreed about a security property and this suite could not
    // see it. Filing a material against B's course would make B's course
    // deletion remove A's row while the object survived — an orphaned child
    // photo, ADR-0013 §6's named failure mode.
    await rejectsWithStatus(
      () => store.recordMaterial(b.id, course.id, {
        kind: 'photo', mime_type: 'image/jpeg', cos_key: `courses/${course.id}/${randomUUID()}.jpg`,
      }),
      404, '别人的课程下不能挂素材',
    );
    assert.deepEqual((await store.listMaterials(a.id, course.id)).map((m) => m.id), [row.id], '被拒的写入没有留下行');
  });

  // ==================== memory facts (ADR-0011 / ADR-0013 §9) ====================

  t('facts: the closed taxonomy is what keeps child observations out of memory', async (store, ctx) => {
    // No store implements facts yet — the JSON tier only knows to SWEEP them on
    // erasure (USER_SCOPED_FILES). This block is written now so that whoever
    // lands the surface lands it identically in both tiers; if the signature
    // below turns out wrong, change the contract and the implementation
    // together, in one commit.
    if (typeof store.recordFact !== 'function' || typeof store.listFacts !== 'function') {
      return ctx.skip('this store has no facts surface yet (ADR-0013 §9 unimplemented in both tiers)');
    }
    const a = await newUser(store);
    const b = await newUser(store);
    const course = await store.createCourse(a.id, '醒狮');

    const fact = await store.recordFact(a.id, {
      scope: 'course', course_id: course.id, kind: 'equipment',
      body: '班上没有鼓', quote: '我们班没有鼓', source: 'extracted',
    });
    assert.equal(fact.kind, 'equipment');
    assert.equal(fact.scope, 'course');
    assert.equal(fact.body, '班上没有鼓');

    // The structural guard. 「孩子们对鼓声特别有反应」 is a child observation and
    // has NO kind to be filed under, so it cannot enter memory and bypass the
    // evidence rules. This is non-negotiable #1 expressed as a CHECK
    // constraint rather than a keyword heuristic — refuse, never guess.
    await rejectsWithStatus(() => store.recordFact(a.id, {
      scope: 'course', course_id: course.id, kind: 'child_observation',
      body: '孩子们对鼓声特别有反应', source: 'extracted',
    }), 400, '儿童观察没有可以归档的类别，必须被拒');

    assert.deepEqual((await store.listFacts(a.id)).map((f) => f.id), [fact.id]);
    assert.deepEqual(await store.listFacts(b.id), [], '别的老师的记忆里没有这条');
  });
}
