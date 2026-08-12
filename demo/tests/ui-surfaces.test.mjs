// ui-surfaces.test.mjs — the decisions behind the four surfaces wired on
// 2026-08-13: the 记忆 viewer, the class picker, the six interaction handles and
// the landing card.
//
// EVERY RULE IS TESTED IN BOTH DIRECTIONS, because half of what these surfaces
// do is stay quiet. A class question asked of a teacher who has one class, a
// widen button offered with no class to widen into, an empty memory page shown
// for a failed read, an entry fork shown again after she has already started —
// each of those is a screen telling her something the record does not support,
// which is what these modules exist to prevent.
//
// These tests also PIN THE CONTRACTS render.js consumes. Both modules were
// rewritten repeatedly on 2026-08-13 while the UI was being wired against them,
// and the renderer broke silently each time — `grouped.counts.live` against a
// module that returns `liveCount` throws only when the pane is opened. A test
// per consumed key is how that stops being a browser-only discovery.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  groupMemory, widenOffer, shouldAskClass, silentClassBinding, correctionPrompt,
  axisHandleRows, axisChangeEvent, memorySnapshot, archiveNote, kindLabel, sourceLabel,
  SCOPE_VIEWS,
} from '../src/ui/memory-view.mjs';
import { landingModel, landingHeadline, dayLabel } from '../src/ui/landing-view.mjs';
import { defaultVector, pinAxis, unpinAxis, AXIS_IDS } from '../src/interaction-axes.mjs';
import { FACT_KINDS } from '../src/memory-scopes.mjs';

// ---------------------------------------------------------------- fixtures

/** One row in the shape `listFacts` returns (json-store.factRow). */
const fact = (over = {}) => ({
  id: over.id ?? 'f1',
  kind: 'equipment',
  scope: 'course',
  text: '班上没有鼓',
  quote: '我们班没有鼓',
  source: 'auto',
  widened_from: null,
  widened_at: null,
  used_at: null,
  archived: false,
  archived_at: null,
  archive_reason: null,
  superseded_by: null,
  at: '2026-08-01T09:00:00.000Z',
  ...over,
});

const CLASS_A = { id: 'c-1', name: '中三班', age_band: '中班', class_size: 28, is_default: true };
const CLASS_B = { id: 'c-2', name: '大一班', age_band: '大班', class_size: 30, is_default: false };

// ------------------------------------------------------- 记忆: read vs empty

test('groupMemory: a failed read is NOT an empty memory — the two are distinguishable', () => {
  const failed = groupMemory(null);
  const empty = groupMemory([]);
  assert.equal(failed.loaded, false, 'null 必须读作「没读到」');
  assert.equal(empty.loaded, true, '[] 必须读作「查过了，确实没有」');
  assert.equal(empty.liveCount, 0);
  // The pane branches on exactly this, and it is the same distinction the
  // prompt band draws for the model. If they ever collapse, the viewer starts
  // telling her the agent remembers nothing whenever the server hiccups.
  assert.notEqual(failed.loaded, empty.loaded);
});

test('groupMemory: undefined and a non-array both read as a failed read, never as empty', () => {
  for (const bad of [undefined, 'nope', 42, {}]) {
    assert.equal(groupMemory(bad).loaded, false, `${JSON.stringify(bad)} 不能读作空记忆`);
  }
});

test('groupMemory: the keys render.js reads exist and are the shape it reads them as', () => {
  // Pinning the CONSUMED SURFACE, not the implementation. renderMemoryView
  // reads exactly these; a rename to `counts`/`facts` broke the pane on open
  // with nothing failing until a human clicked 记忆.
  const g = groupMemory([fact(), fact({ id: 'f2', archived: true, archive_reason: 'cap' })]);
  assert.equal(typeof g.loaded, 'boolean');
  assert.equal(typeof g.liveCount, 'number');
  assert.equal(typeof g.total, 'number');
  assert.ok(Array.isArray(g.groups));
  assert.ok(Array.isArray(g.archived));
  for (const group of g.groups) {
    assert.ok(Array.isArray(group.rows), `${group.scope} 组必须有 rows`);
    assert.ok(group.label && group.hint);
  }
});

test('groupMemory: an archived row leaves its scope group and lands in 已归档', () => {
  const live = fact({ id: 'f-live' });
  const gone = fact({ id: 'f-gone', archived: true, archived_at: '2026-08-02T00:00:00.000Z', archive_reason: 'child_claim' });
  const grouped = groupMemory([live, gone]);
  const course = grouped.groups.find((g) => g.scope === 'course');
  assert.deepEqual(course.rows.map((f) => f.id), ['f-live'], '归档的条目不能混在在用的里面');
  assert.deepEqual(grouped.archived.map((f) => f.id), ['f-gone']);
  assert.equal(grouped.liveCount, 1);
});

test('groupMemory: groups come back widest first, and an empty scope is not a section', () => {
  const all = groupMemory(['teacher', 'class', 'course', 'node'].map((scope, i) => fact({ id: `f${i}`, scope })));
  assert.deepEqual(all.groups.map((g) => g.scope), ['teacher', 'class', 'course', 'node']);
  assert.deepEqual(all.groups.map((g) => g.scope), SCOPE_VIEWS.map((v) => v.scope));
  // Empty scopes are dropped rather than drawn as empty headings — a 「班级」
  // heading with nothing under it reads as 「I forgot what you told me」.
  assert.deepEqual(groupMemory([fact({ scope: 'course' })]).groups.map((g) => g.scope), ['course']);
  assert.deepEqual(groupMemory([]).groups, []);
});

test('archiveNote: every archive reason the write path produces has its own sentence', () => {
  const seen = new Set();
  for (const reason of ['child_claim', 'cap', 'superseded', 'teacher_removed']) {
    const text = archiveNote({ archive_reason: reason });
    assert.ok(text && text.length > 4, `${reason} 没有说明`);
    assert.equal(seen.has(text), false, `${reason} 与别的原因说了同一句话`);
    seen.add(text);
  }
  // An unknown reason still says something rather than rendering a bare code.
  assert.ok(archiveNote({ archive_reason: 'weird' }).length > 4);
  assert.ok(archiveNote({}).length > 4);
});

test('archiveNote: the child-claim sentence names the evidence rule, not an internal code', () => {
  const text = archiveNote({ archive_reason: 'child_claim' });
  assert.ok(text.includes('孩子'), '要说清这是关于孩子的话');
  assert.ok(text.includes('证据'), '要说清为什么没记：得凭现场证据');
  assert.equal(text.includes('child_claim'), false, '不能把内部代号显示给老师');
});

test('kindLabel: the closed taxonomy is all named, and an unknown kind shows itself', () => {
  for (const kind of FACT_KINDS) {
    assert.notEqual(kindLabel(kind), kind, `${kind} 还没有中文名`);
  }
  assert.equal(kindLabel('made_up'), 'made_up', '不认识的类型要照原样显示，不能藏起来');
});

test('sourceLabel: 你说的 and 我记的 never read the same — provenance is the point', () => {
  const said = sourceLabel(fact({ source: 'teacher' }));
  const heard = sourceLabel(fact({ source: 'auto' }));
  assert.ok(said && heard);
  assert.notEqual(said, heard);
});

// ------------------------------------------------------------- 记忆: 扩大

test('widenOffer: a course fact offers the class rung ONLY when there is a class to widen into', () => {
  const f = fact({ scope: 'course' });
  const withClass = widenOffer(f, { classId: 'c-1', className: '中三班' });
  assert.equal(withClass?.to, 'class');
  assert.equal(withClass.classId, 'c-1');
  assert.ok(withClass.label && withClass.confirm);
  // No class bound: the button is WITHHELD rather than shown-and-refused.
  assert.equal(widenOffer(f, { classId: null }), null);
  assert.equal(widenOffer(f, {}), null);
});

test('widenOffer: one rung only — class widens to teacher, teacher offers nothing', () => {
  assert.equal(widenOffer(fact({ scope: 'class' }), { classId: 'c-1' })?.to, 'teacher');
  assert.equal(widenOffer(fact({ scope: 'teacher' }), { classId: 'c-1' }), null);
  // A course fact never offers the teacher rung directly: two claims, two taps.
  assert.notEqual(widenOffer(fact({ scope: 'course' }), { classId: 'c-1' })?.to, 'teacher');
});

test('widenOffer: an archived fact is never promoted, whatever its scope', () => {
  for (const scope of ['course', 'class']) {
    const f = fact({ scope, archived: true, archive_reason: 'teacher_removed' });
    assert.equal(widenOffer(f, { classId: 'c-1' }), null, `${scope} 的归档条目不该还能扩大`);
  }
});

test('widenOffer: the two rungs never share confirm wording — different-sized claims', () => {
  const toClass = widenOffer(fact({ scope: 'course' }), { classId: 'c-1', className: '中三班' });
  const toTeacher = widenOffer(fact({ scope: 'class' }), { classId: 'c-1' });
  assert.notEqual(toClass.label, toTeacher.label);
  assert.notEqual(toClass.confirm, toTeacher.confirm);
  // render.js reads exactly these four keys and holds the armed sentence itself.
  assert.deepEqual(Object.keys(toClass).sort(), ['classId', 'confirm', 'label', 'to']);
});

// --------------------------------------------------------- 记忆: 改一下

test('correctionPrompt: hands her own recorded words back, and never hands back nothing', () => {
  assert.ok(correctionPrompt(fact()).includes('班上没有鼓'));
  // No text is still a usable sentence: an empty composer would silently eat
  // the tap she just made.
  assert.ok(correctionPrompt({}).trim().length > 0);
  assert.ok(correctionPrompt(null).trim().length > 0);
});

// -------------------------------------------------------------- 班级 picker

test('shouldAskClass: asks at two or more, and is silent at one, none, or already bound', () => {
  assert.equal(shouldAskClass([CLASS_A, CLASS_B], { class_id: null }), true);
  // One class = one possible answer. Asking would be the state machine leaking
  // onto her side of the desk (non-negotiable #2).
  assert.equal(shouldAskClass([CLASS_A], { class_id: null }), false);
  assert.equal(shouldAskClass([], { class_id: null }), false);
  assert.equal(shouldAskClass(null, { class_id: null }), false);
  assert.equal(shouldAskClass([CLASS_A, CLASS_B], { class_id: 'c-1' }), false, '已经认过班就不再问');
});

test('silentClassBinding: binds the single class, and refuses to guess among several', () => {
  assert.equal(silentClassBinding([CLASS_A], { class_id: null }), 'c-1');
  assert.equal(silentClassBinding([CLASS_A, CLASS_B], { class_id: null }), null);
  assert.equal(silentClassBinding([], { class_id: null }), null);
  assert.equal(silentClassBinding([CLASS_A], { class_id: 'c-2' }), null, '已绑定就不再改');
});

test('the picker and the silent binding never both fire for the same course', () => {
  for (const classes of [[], [CLASS_A], [CLASS_A, CLASS_B]]) {
    for (const course of [{ class_id: null }, { class_id: 'c-1' }]) {
      const asks = shouldAskClass(classes, course);
      const binds = Boolean(silentClassBinding(classes, course));
      assert.equal(asks && binds, false, '同一门课不能又问又自动绑');
    }
  }
});

// ------------------------------------------------------------- 六轴 handles

test('axisHandleRows: six rows, each stating a value AND where the value came from', () => {
  const rows = axisHandleRows(defaultVector());
  assert.deepEqual(rows.map((r) => r.axis), [...AXIS_IDS]);
  for (const row of rows) {
    assert.ok(row.value >= 1 && row.value <= 5);
    assert.ok(row.zh, `${row.axis} 没有中文名`);
    assert.ok(row.bandLabel, `${row.axis} 没有档位名`);
    // The provenance sentence is the whole difference between this pane and a
    // settings form; a row without one is a setting, not a stated belief.
    assert.ok(row.sourceLabel, `${row.axis} 没有说这个判断是哪来的`);
    assert.ok(row.directive, `${row.axis} 没有显示给模型的原话`);
    assert.ok(row.low && row.mid && row.high, `${row.axis} 缺少刻度文字`);
  }
});

test('axisHandleRows: an untouched axis and a pinned one read differently', () => {
  const before = axisHandleRows(defaultVector()).find((r) => r.axis === 'depth');
  assert.equal(before.pinned, false);
  const after = axisHandleRows(pinAxis(defaultVector(), 'depth', 5)).find((r) => r.axis === 'depth');
  assert.equal(after.pinned, true);
  assert.equal(after.value, 5);
  assert.notEqual(after.sourceLabel, before.sourceLabel, '钉住之后必须说这是你设定的');
});

test('axisHandleRows: junk renders as a complete, readable set rather than crashing', () => {
  for (const junk of [null, undefined, {}, { axes: {} }, 'nope']) {
    assert.equal(axisHandleRows(junk).length, AXIS_IDS.length);
  }
});

test('axisChangeEvent: the audit trail carries axis, from, to, source, confidence and signal', () => {
  const before = defaultVector();
  const after = pinAxis(before, 'guidance', 5);
  const ev = axisChangeEvent('guidance', before, after, { signal: 'teacher_set_handle' });
  assert.equal(ev.axis, 'guidance');
  assert.equal(ev.to, 5);
  assert.notEqual(ev.from, ev.to);
  assert.equal(ev.source, 'explicit');
  assert.equal(ev.pinned, true);
  assert.equal(ev.signal, 'teacher_set_handle');
  assert.ok(ev.band_from && ev.band_to);
  assert.equal(typeof ev.confidence, 'number');
});

test('axisChangeEvent: an unpin is recorded as a real event, not as silence', () => {
  const pinned = pinAxis(defaultVector(), 'openness', 5);
  const released = unpinAxis(pinned, 'openness');
  const ev = axisChangeEvent('openness', pinned, released, { signal: 'teacher_released_handle' });
  assert.equal(ev.pinned, false);
  assert.notEqual(ev.source, 'explicit');
});

// ------------------------------------------------ observability / export duty

test('memorySnapshot: a failed read is STATED in the export, never omitted', () => {
  const snap = memorySnapshot({ facts: null, vector: defaultVector(), classes: [] });
  assert.equal(snap.memory.loaded, false);
  assert.ok(snap.memory.note, '导出里要写明是「没读到」而不是「没有」');
  // An absent key would read as 「the feature is off」.
  assert.ok('memory' in snap && 'interaction_vector' in snap && 'classes' in snap);
});

test('memorySnapshot: the six axes travel with the export, values and provenance both', () => {
  const snap = memorySnapshot({ facts: [], vector: pinAxis(defaultVector(), 'depth', 1), classes: [CLASS_A], courseClassId: 'c-1' });
  assert.equal(snap.interaction_vector.axes.length, AXIS_IDS.length);
  const depth = snap.interaction_vector.axes.find((a) => a.axis === 'depth');
  assert.equal(depth.value, 1);
  assert.equal(depth.pinned, true);
  assert.equal(snap.classes.bound_class_id, 'c-1');
  assert.deepEqual(snap.classes.names, ['中三班']);
});

test('memorySnapshot: no fact bodies and no teacher quotes in the export summary', () => {
  const snap = memorySnapshot({
    facts: [fact({ id: 'a' }), fact({ id: 'c', archived: true, archive_reason: 'child_claim' })],
    vector: defaultVector(),
    classes: [CLASS_A],
    courseClassId: 'c-1',
  });
  assert.equal(snap.memory.loaded, true);
  // Bodies stay out: the session-log 「记忆与画像」 events already carry the text,
  // and repeating every body here duplicates teacher content for nothing.
  const dumped = JSON.stringify(snap);
  assert.equal(dumped.includes('班上没有鼓'), false, '导出摘要里不该出现记忆正文');
  assert.equal(dumped.includes('我们班没有鼓'), false, '导出摘要里不该出现教师原话');
});

// -------------------------------------------------------------- the landing

const planState = (activities) => ({
  course_plan: {
    version: 2,
    roots: [{
      id: 'p1', kind: 'phase', title: '东乡龙舟', status: 'confirmed', work_status: 'settled',
      children: [{
        id: 'w1', kind: 'week', title: '周1', status: 'confirmed', work_status: 'settled',
        children: activities,
      }],
    }],
  },
});

const NOW = '2026-09-22T08:00:00';
const TODAY = '2026-09-22';
const started = { transcript: [{ role: 'user', content: '想做龙舟' }], now: NOW };

test('landing: nothing said and no plan is the entry fork', () => {
  const landing = landingModel(null, { transcript: [], now: NOW });
  assert.equal(landing.mode, 'fork');
  assert.deepEqual(landing.today, []);
});

test('landing: ONE teacher message is enough to leave the fork behind', () => {
  const landing = landingModel({}, started);
  assert.equal(landing.mode, 'step_zero', '她已经开口了，就不该再问一次「两条路都行」');
});

test('landing: an agent-only transcript does NOT count as having started', () => {
  const landing = landingModel(null, { transcript: [{ role: 'assistant', content: '你好' }], now: NOW });
  assert.equal(landing.mode, 'fork');
});

test('landing: a plan turns the card into 今天要做什么, filtered by the date FIELD', () => {
  const landing = landingModel(planState([
    { id: 'a1', kind: 'activity', title: '看一条真龙舟', dates: [TODAY], status: 'confirmed', work_status: 'draft' },
    { id: 'a2', kind: 'activity', title: '鼓点节奏游戏', dates: ['2026-09-30'], status: 'ai_suggestion', work_status: 'draft' },
  ]), started);
  assert.equal(landing.mode, 'plan');
  assert.deepEqual(landing.today.map((r) => r.id), ['a1']);
  assert.equal(landing.next?.date, '2026-09-30');
  assert.ok(landingHeadline(landing).includes('今天有 1 项'));
});

test('landing: a settled activity is not something she still has to do', () => {
  const landing = landingModel(planState([
    { id: 'a1', kind: 'activity', title: '做过了', dates: [TODAY], status: 'confirmed', work_status: 'settled' },
  ]), started);
  assert.deepEqual(landing.today, []);
  assert.equal(landingHeadline(landing), '今天没有安排');
});

test('landing: a missed day is SHOWN, not dropped', () => {
  const landing = landingModel(planState([
    { id: 'a1', kind: 'activity', title: '上周该做的', dates: ['2026-09-15'], status: 'confirmed', work_status: 'draft' },
  ]), started);
  assert.deepEqual(landing.overdue.map((r) => r.id), ['a1']);
  assert.deepEqual(landing.today, []);
});

test('landing: only activities carry dates — no phase or week ever lands on the card', () => {
  const landing = landingModel(planState([
    { id: 'a1', kind: 'activity', title: '有日子的活动', dates: [TODAY], status: 'confirmed', work_status: 'draft' },
    { id: 'a2', kind: 'activity', title: '没定日子的活动', status: 'ai_suggestion', work_status: 'draft' },
  ]), started);
  for (const row of [...landing.today, ...landing.overdue, ...(landing.next?.items ?? [])]) {
    assert.ok(row.id !== 'p1' && row.id !== 'w1', '阶段和周不该出现在卡片上');
  }
  assert.equal(landing.undated, 1, '没定日子的要被数出来，不能悄悄消失');
});

test('landing: no landing row ever carries anything about children', () => {
  const landing = landingModel(planState([
    { id: 'a1', kind: 'activity', title: '看一条真龙舟', dates: [TODAY], status: 'confirmed', work_status: 'draft' },
  ]), started);
  // The projection is fixed and small on purpose: a landing card that
  // summarised what children had done would be non-negotiable #1 in a costume.
  assert.deepEqual(
    Object.keys(landing.today[0]).sort(),
    ['date', 'id', 'number', 'stale', 'status', 'title', 'work_status'],
  );
});

test('landingHeadline: 「今天没有安排」 and 「还有 n 项没有定日子」 are different sentences', () => {
  assert.equal(landingHeadline({ today: [], next: null, undated: 0 }), '今天没有安排');
  assert.ok(landingHeadline({ today: [], next: null, undated: 3 }).includes('没有定日子'));
  assert.ok(landingHeadline({ today: [], next: { label: '明天', items: [1] }, undated: 0 }).includes('明天'));
  assert.ok(landingHeadline({ today: [1, 2], next: null, undated: 0 }).includes('2 项'));
});

test('dayLabel: the near days are words, the far ones are counts', () => {
  assert.equal(dayLabel(0), '今天');
  assert.equal(dayLabel(1), '明天');
  assert.equal(dayLabel(2), '后天');
  assert.ok(dayLabel(9).includes('9'));
  assert.ok(dayLabel(-9).includes('9'));
});
