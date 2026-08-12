// prompt-builder must be byte-compatible with the legacy serve.mjs assembly
// (no-profile case), inject the 教师档案 section only when filled, and the
// profile must NEVER be model-writable (bad_delta strips it). Both directions
// per the repo's runtime-harness discipline.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildSystemPrompt, buildPromptParts, cacheStableHistory, profileSectionText, stageModuleName,
  stateNoteText, skeletonBandText, memoryBandText, focusBandText, assertMemoryBand,
  interactionSectionText, turnStyleNoteText,
  STAGE_MODULE, STYLE_DIRECTIVES,
} from '../src/prompt-builder.mjs';
import {
  AXES, EVIDENCE_INVARIANT, defaultVector, pinAxis, turnOverride, vectorFromPreset,
} from '../src/interaction-axes.mjs';
import { createInitialState, applyDelta } from '../src/engine.mjs';
import { mockTurn } from '../src/mock.mjs';

const stub = (name) => '[' + name + ']';
const loadPromptFile = (name) => readFileSync(new URL('../src/prompts/' + name + '.zh.md', import.meta.url), 'utf8');

/** Verbatim replica of the legacy serve.mjs assembly (pre-extraction). */
function legacyBuildSystemPrompt(state) {
  const stageDoc = loadPromptFile(STAGE_MODULE[state.stage] ?? 'stage0');
  const snapshot = JSON.stringify(state, null, 1);
  const pacing = state.awaiting_feedback
    ? '当前 awaiting_feedback 为 true：上一轮已收尾，教师尚未回传现场反馈。若这条消息就是回传，先提取证据；若只是追问或要素材，就地支持，不虚构课堂进展。'
    : '';
  return [
    loadPromptFile('base'),
    loadPromptFile('contract'),
    stageDoc,
    '# 当前 course_state（只读快照）\n\n```json\n' + snapshot + '\n```\n\n' + pacing,
  ].join('\n\n---\n\n');
}

test('assembly order: base → contract → stage module → state snapshot', async () => {
  const state = { stage: 2, awaiting_feedback: false };
  const out = await buildSystemPrompt(state, stub);
  const parts = out.split('\n\n---\n\n');
  assert.equal(parts.length, 4);
  assert.equal(parts[0], '[base]');
  assert.equal(parts[1], '[contract]');
  assert.equal(parts[2], '[stage2]');
  assert.ok(parts[3].startsWith('# 当前 course_state（只读快照）'));
  assert.ok(parts[3].includes('```json'));
});

test('stage module mapping: stage 4 reuses stage3; unknown falls back to stage0', () => {
  assert.equal(stageModuleName({ stage: 4 }), 'stage3');
  assert.equal(stageModuleName({ stage: 99 }), 'stage0');
  assert.equal(stageModuleName({}), 'stage0');
});

test('pacing note: present iff awaiting_feedback', async () => {
  const waiting = await buildSystemPrompt({ stage: 1, awaiting_feedback: true }, stub);
  assert.ok(waiting.includes('awaiting_feedback 为 true'));
  const active = await buildSystemPrompt({ stage: 1, awaiting_feedback: false }, stub);
  assert.ok(!active.includes('awaiting_feedback 为 true'));
});

test('profile section: injected iff the profile has content (both directions)', async () => {
  assert.equal(profileSectionText(null), '');
  assert.equal(profileSectionText({}), '');
  assert.equal(profileSectionText({ region: '  ' }), '');
  const text = profileSectionText({ region: '番禺', ageBand: '中班', classSize: 30, stylePref: '户外' });
  assert.ok(text.includes('地区：番禺') && text.includes('年段：中班') && text.includes('班额：30') && text.includes('偏好：户外'));
  assert.ok(text.includes('不要向教师复述档案内容'));

  const withProfile = await buildSystemPrompt({ stage: 0 }, stub, { profile: { ageBand: '大班' } });
  assert.ok(withProfile.endsWith('。据此调整举例与语气，不要向教师复述档案内容。'));
  assert.equal(withProfile.split('\n\n---\n\n').length, 5);
  const without = await buildSystemPrompt({ stage: 0 }, stub, { profile: {} });
  assert.equal(without.split('\n\n---\n\n').length, 4);
});

test('profile v2 fields: injected when present, absent when empty (both directions)', () => {
  const full = profileSectionText({
    province: '广东', region: '番禺区', ageRange: '26–30岁', teachYears: '3–5年',
    tenureYears: '1–3年', role: '班主任', classBands: ['中班', '大班'], classSize: 28,
    stylePref: '提问引导（先问再建议）',
  });
  assert.ok(full.includes('地区：广东番禺区'));
  assert.ok(full.includes('年龄段：26–30岁') && full.includes('教龄：3–5年') && full.includes('本园年资：1–3年'));
  assert.ok(full.includes('角色：班主任') && full.includes('任教班级：中班、大班'));
  assert.ok(!full.includes('年段：'), 'classBands supersedes legacy ageBand');
  // legacy ageBand still renders when classBands is absent
  assert.ok(profileSectionText({ ageBand: '中班' }).includes('年段：中班'));
  // absent direction: empty arrays/blank strings inject nothing
  assert.equal(profileSectionText({ province: ' ', classBands: [], role: '' }), '');
});

test('回应风格: known styles inject their exact directive; free text falls back to 偏好 (both directions)', () => {
  for (const [label, directive] of Object.entries(STYLE_DIRECTIVES)) {
    const text = profileSectionText({ stylePref: label });
    assert.ok(text.includes(`回应风格：${directive}`), label);
    assert.ok(!text.includes('偏好：'), 'directive replaces the raw label');
  }
  const free = profileSectionText({ stylePref: '喜欢户外和动手类活动' });
  assert.ok(free.includes('偏好：喜欢户外和动手类活动') && !free.includes('回应风格：'));
  assert.equal(profileSectionText({ stylePref: ' ' }), '');
});

// ---------------- interaction axes in the prompt (ADR-0009 §1/§2) ----------------
//
// Every test here comes in both directions, and the MUST-PASS direction is the
// migration promise: a profile with no vector — which today is every profile
// that exists — must keep getting the legacy 回应风格 sentence, unchanged.

const VECTOR_PROFILE = (v) => ({ ageBand: '中班', stylePref: '极简速览（电报体、越短越好）', interaction_vector: v });

test('axes: a profile WITHOUT a vector keeps the legacy 回应风格 line, to the byte', () => {
  const legacyOnly = { ageBand: '中班', stylePref: '极简速览（电报体、越短越好）' };
  assert.equal(interactionSectionText(legacyOnly), '', 'no vector → no axis block');
  assert.equal(interactionSectionText(null), '');
  assert.equal(interactionSectionText({}), '');
  const text = profileSectionText(legacyOnly);
  assert.ok(text.includes(`回应风格：${STYLE_DIRECTIVES['极简速览（电报体、越短越好）']}`), 'nobody is stranded');
});

test('axes: a profile WITH a vector renders six directives and drops the preset sentence', () => {
  const profile = VECTOR_PROFILE(vectorFromPreset('极简速览（电报体、越短越好）'));
  const block = interactionSectionText(profile);
  assert.ok(block.startsWith('回应风格（按这位教师的互动偏好调整表达方式）：'));
  for (const axis of AXES) assert.ok(block.includes(`${axis.zh}：`), axis.zh);
  assert.equal(block.split('\n').filter((l) => AXES.some((a) => l.startsWith(`${a.zh}：`))).length, 6);
  // ONE style instruction, never two.
  const profileText = profileSectionText(profile);
  assert.ok(!profileText.includes('回应风格：'), 'the preset sentence steps aside for the axes');
  assert.ok(profileText.includes('年段：中班'), 'the rest of the profile is untouched');
});

test('axes: the evidence invariant closes the block, and style never loosens it', () => {
  const openEverything = { ...defaultVector() };
  for (const axis of AXES) openEverything.axes[axis.id] = { value: 5, confidence: 1, source: 'explicit', pinned: true };
  const block = interactionSectionText(VECTOR_PROFILE(openEverything));
  assert.ok(block.endsWith(EVIDENCE_INVARIANT), 'nothing above it may read as an exception');
  assert.ok(block.includes('主动指出被忽略的问题'), 'the permissive directive really is in there');
});

test('axes: a free-text 偏好 survives the vector; a known preset does not (both directions)', () => {
  // 「喜欢户外和动手类活动」 is a CONTENT preference the six axes cannot express.
  const free = profileSectionText({ stylePref: '喜欢户外和动手类活动', interaction_vector: defaultVector() });
  assert.ok(free.includes('偏好：喜欢户外和动手类活动'));
  const preset = profileSectionText({ stylePref: '详细讲解（讲清为什么）', interaction_vector: defaultVector() });
  assert.equal(preset, '', 'the preset is fully expressed by the axes, so the profile section empties out');
});

test('axes: an UNREADABLE vector falls back to the legacy line rather than to the default vector', () => {
  // VECTOR_VERSION exists so a stored profile from an older build fails loudly
  // instead of being read one axis short. Rendering the default block here would
  // steer her by 蓝图共创 while her pane showed something else.
  const stale = { version: 'v0', axes: { guidance: { value: 5 } } };
  const halfWritten = { version: 'v1', axes: {} };
  for (const bad of [stale, halfWritten, { version: 'v1' }, 'nonsense', 42]) {
    const profile = VECTOR_PROFILE(bad);
    assert.equal(interactionSectionText(profile), '', `unreadable: ${JSON.stringify(bad)}`);
    assert.ok(profileSectionText(profile).includes('回应风格：'), 'the legacy line comes back');
  }
  // MUST PASS: a current, whole vector is read.
  assert.notEqual(interactionSectionText(VECTOR_PROFILE(defaultVector())), '');
});

test('axes: moving one handle changes exactly one directive', () => {
  const before = interactionSectionText(VECTOR_PROFILE(defaultVector()));
  const after = interactionSectionText(VECTOR_PROFILE(pinAxis(defaultVector(), '解释深度', 5)));
  assert.notEqual(before, after);
  const diff = after.split('\n').filter((l, i) => l !== before.split('\n')[i]);
  assert.deepEqual(diff, [`解释深度：${AXES[3].directives.high}`], 'one handle, one sentence');
});

test('one-turn override: rides the VOLATILE note, never the cache-stable prefix (both directions)', async () => {
  const stored = pinAxis(defaultVector(), '输出节奏', 5);   // 逐步确认推进
  const profile = VECTOR_PROFILE(stored);
  const once = turnOverride(stored, '输出节奏', 1);          // 「这次直接给我一版就好」
  const state = createInitialState('override');

  const plain = await buildPromptParts(state, stub, { profile });
  const flexed = await buildPromptParts(state, stub, { profile, turnVector: once });
  assert.equal(plain.system, flexed.system, 'the prefix is byte-identical → the cache survives the override');
  assert.notEqual(plain.stateNote, flexed.stateNote, 'volatility confined to the tail');

  assert.ok(flexed.system.includes(AXES[2].directives.high), 'the prefix still states the STORED preference');
  assert.ok(flexed.stateNote.includes('# 本轮临时表达调整'), 'the override is in the note');
  assert.ok(flexed.stateNote.includes(AXES[2].directives.low), 'with this turn’s directive');
  // The invariant must sit downstream of the LAST directive, not only the first:
  // 主动性「主动提醒与挑战」 reads like licence to fill gaps, and this block is
  // later in the assembled prompt than the prefix's copy of the clause.
  assert.ok(flexed.stateNote.lastIndexOf(EVIDENCE_INVARIANT) > flexed.stateNote.lastIndexOf(AXES[2].directives.low));
  assert.ok(!plain.stateNote.includes('# 本轮临时表达调整'), 'no override → no band');
});

test('band order in the note: snapshot → 骨架 → 记忆 → 本轮临时 → 焦点', () => {
  const stored = pinAxis(defaultVector(), '输出节奏', 5);
  const state = { ...createInitialState('band-order'), course_plan: PLAN };
  const note = stateNoteText(state, {
    subject: 'p1.1.1', facts: FACTS,
    profile: VECTOR_PROFILE(stored), turnVector: turnOverride(stored, '输出节奏', 1),
  });
  const at = (h) => {
    const i = note.indexOf(h);
    assert.ok(i >= 0, `${h} is in the note`);
    return i;
  };
  const order = ['# 当前 course_state', '# 课程计划骨架', '# 记忆（教师、班级与课程', '# 本轮临时表达调整', '# 焦点节点 p1.1.1'];
  const positions = order.map(at);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), order.join(' → '));
});

test('one-turn override: silent when nothing actually changed band', () => {
  const stored = pinAxis(defaultVector(), '解释深度', 4);
  const profile = VECTOR_PROFILE(stored);
  // 4 → 5 is the same band, so the sentence the model would read is identical.
  assert.equal(turnStyleNoteText(profile, turnOverride(stored, '解释深度', 5)), '',
    'repeating an instruction the prefix already gave teaches the model this block is noise');
  // 4 → 1 crosses a band, so it is said.
  assert.ok(turnStyleNoteText(profile, turnOverride(stored, '解释深度', 1)).includes(AXES[3].directives.low));
  // No override marker at all, and no vector at all: nothing either way.
  assert.equal(turnStyleNoteText(profile, stored), '', 'an unmarked vector is not an override');
  assert.equal(turnStyleNoteText(profile, null), '');
  assert.equal(turnStyleNoteText(null, null), '');
});

test('one-turn override: compared against the DEFAULT point when she has no stored vector', () => {
  // Otherwise an override on a vector-less teacher would look like a no-op
  // against nothing, and her 「这次直接给我一版就好」 would silently do nothing.
  const once = turnOverride(defaultVector(), '结构化程度', 5);
  const note = turnStyleNoteText({ stylePref: '详细讲解（讲清为什么）' }, once);
  assert.ok(note.includes(AXES[1].directives.high), 'the override is still heard');
});

test('byte-parity with the legacy serve.mjs assembly (real prompt files, no profile)', async () => {
  for (const [stage, awaiting] of [[0, false], [1, true], [4, false], [5, true]]) {
    const state = createInitialState('parity');
    state.stage = stage;
    state.awaiting_feedback = awaiting;
    const modern = await buildSystemPrompt(state, loadPromptFile);
    assert.equal(modern, legacyBuildSystemPrompt(state), 'stage ' + stage + ' awaiting ' + awaiting);
  }
});

test('async loaders work: loadPrompt may return promises', async () => {
  const asyncStub = (name) => Promise.resolve('<' + name + '>');
  const out = await buildSystemPrompt({ stage: 3 }, asyncStub);
  assert.ok(out.startsWith('<base>') && out.includes('<stage3>'));
});

// ---------------- prompt caching: stable prefix + volatile tail ----------------

test('buildPromptParts: static system carries rules + profile and NO snapshot; stateNote carries snapshot + pacing (both directions)', async () => {
  const state = { stage: 1, awaiting_feedback: true, course_id: 'cache-1' };
  const { system, stateNote } = await buildPromptParts(state, stub, { profile: { ageBand: '大班' } });
  assert.ok(system.startsWith('[base]') && system.includes('[contract]') && system.includes('[stage1]'));
  assert.ok(system.includes('不要向教师复述档案内容'), 'profile lives in the static prefix');
  assert.ok(!system.includes('course_state'), 'no snapshot in the cacheable prefix');
  assert.ok(stateNote.includes('cache-1') && stateNote.includes('awaiting_feedback 为 true'), 'snapshot + pacing in the tail');
  // Same content overall: parts vs legacy single prompt agree section-for-section.
  const legacy = await buildSystemPrompt(state, stub);
  assert.ok(legacy.includes(stateNote), 'the tail is the same section the legacy prompt embeds');
});

test('buildPromptParts: static system is byte-stable while state churns within a stage', async () => {
  const a = await buildPromptParts({ stage: 2, awaiting_feedback: false, children_evidence: [] }, stub);
  const b = await buildPromptParts({ stage: 2, awaiting_feedback: true, children_evidence: [{ id: 'ev1' }] }, stub);
  assert.equal(a.system, b.system, 'prefix identical across turns → vendor cache hit');
  assert.notEqual(a.stateNote, b.stateNote, 'volatility confined to the tail');
});

test('cacheStableHistory: ≤36 messages pass through untouched', () => {
  const h = Array.from({ length: 36 }, (_, i) => ({ role: 'user', content: String(i) }));
  assert.deepEqual(cacheStableHistory(h), h);
  assert.deepEqual(cacheStableHistory([]), []);
});

test('cacheStableHistory: window start moves in 12-message blocks, size stays 24–35', () => {
  let prevStart = null;
  let jumps = 0;
  for (let len = 37; len <= 72; len += 1) {
    const h = Array.from({ length: len }, (_, i) => ({ role: 'user', content: String(i) }));
    const kept = cacheStableHistory(h);
    assert.ok(kept.length >= 24 && kept.length <= 35, `len ${len} keeps ${kept.length}`);
    assert.equal(kept.at(-1).content, String(len - 1), 'newest message always kept');
    const start = Number(kept[0].content);
    if (prevStart !== null && start !== prevStart) {
      assert.equal(start - prevStart, 12, 'start only ever jumps by a whole block');
      jumps += 1;
    }
    prevStart = start;
  }
  assert.ok(jumps >= 2, 'the window does advance');
});

test('profile is never model-writable: profile keys in state_delta strip as bad_delta', () => {
  const { state, violations } = applyDelta(createInitialState('p1'), {
    profile: { region: '广州' },
    region: '广州',
    ageBand: '中班',
    theme_fit_level: 'theme_inquiry',
  });
  assert.equal(violations.filter((v) => v.kind === 'bad_delta').length, 3);
  assert.ok(!('profile' in state) && !('region' in state) && !('ageBand' in state));
  assert.equal(state.theme_fit_level, 'theme_inquiry', 'whitelisted field still applies');
});

// ---------------- context bands (ADR-0007 §1, §4) ----------------
//
// Every band test comes in both directions, and the MUST-PASS direction is the
// acceptance test: a caller that passes no plan, no facts and no subject must
// get byte-for-byte what it got before the bands existed.

/** Verbatim replica of the per-turn note as it stood before the bands. */
function legacyStateNote(state) {
  const pacing = state.awaiting_feedback
    ? '当前 awaiting_feedback 为 true：上一轮已收尾，教师尚未回传现场反馈。若这条消息就是回传，先提取证据；若只是追问或要素材，就地支持，不虚构课堂进展。'
    : '';
  return '# 当前 course_state（只读快照）\n\n```json\n' + JSON.stringify(state, null, 1) + '\n```\n\n' + pacing;
}

/** A plan whose activity is a HYPOTHESIS with a body about children who have
 * not met yet — the shape that must never reach the model unlabelled. */
const PLAN = {
  version: 'v0.3',
  roots: [{
    id: 'p1', kind: 'phase', title: '醒狮主题月',
    summary: '一个月，从看狮到自己做狮头',
    body: '整月脉络：先看、再拆、再做、再演。',
    status: 'teacher_preset', work_status: 'settled',
    children: [{
      id: 'p1.1', kind: 'week', title: '第一周：去看醒狮',
      summary: '带孩子实地看一次醒狮排练',
      body: '周内三次外出，重点在看和问。',
      status: 'confirmed', work_status: 'settled',
      children: [{
        id: 'p1.1.1', kind: 'activity', title: '狮头细看',
        body: '孩子会数狮头上有几个角（预设，待现场验证）。',
        status: 'hypothesis', work_status: 'draft', dates: ['2026-09-07'],
        revisions: [
          { version: 2, at: '2026-08-01', by: 'teacher', reason: '把鼓换成木棍，班上没有鼓' },
          { version: 3, at: '2026-08-02', by: 'teacher', reason: '   ' },
        ],
      }],
    }],
  }],
};

// `kind` is REQUIRED since ADR-0013 §9 closed the child-observation bypass by
// construction: a fact without one of the five kinds is refused, not filed, so
// a fixture without one would render an empty memory band.
const FACTS = [
  { id: 'f-class-1', kind: 'equipment', scope: 'class', text: '我们班没有鼓', quote: '我们班没有鼓', at: '2026-07-30T09:00:00Z', source: 'teacher' },
  { id: 'f-course-1', kind: 'teacher_preference', scope: 'course', text: '这门课想落在醒狮上', at: '2026-07-30T09:05:00Z', source: 'auto' },
  { id: 'f-old-1', kind: 'teacher_preference', scope: 'course', text: '原本打算做龙舟', at: '2026-07-01T09:00:00Z', source: 'auto', archived: true, archive_reason: 'superseded' },
];

test('ACCEPTANCE — no course_plan, no facts, no subject: the note is byte-identical to the pre-band assembly', async () => {
  for (const [stage, awaiting] of [[0, false], [1, true], [4, false], [5, true]]) {
    const state = createInitialState('bands-degrade');
    state.stage = stage;
    state.awaiting_feedback = awaiting;
    assert.equal(stateNoteText(state), legacyStateNote(state), `stage ${stage}`);
    assert.equal(stateNoteText(state, {}), legacyStateNote(state), 'empty opts object');
    assert.equal(stateNoteText(state, { subject: 'course', facts: null }), legacyStateNote(state), 'course subject + unwired memory');
    const { stateNote } = await buildPromptParts(state, stub);
    assert.equal(stateNote, legacyStateNote(state), 'buildPromptParts degrades the same way');
  }
  // An empty plan is not a plan: no rows to render, so no band and no snapshot rewrite.
  const empty = { ...createInitialState('bands-empty'), course_plan: { version: 'v0.1', roots: [] } };
  assert.equal(stateNoteText(empty), legacyStateNote(empty));
});

test('bands fire when they are wired: the same note is NOT the legacy one once a plan, facts and a subject arrive', () => {
  const state = { ...createInitialState('bands-on'), course_plan: PLAN };
  const note = stateNoteText(state, { subject: 'p1.1.1', facts: FACTS });
  assert.notEqual(note, legacyStateNote(state), 'a silently dropped band would slip through without this');
  assert.ok(note.includes('# 课程计划骨架'), 'skeleton band');
  assert.ok(note.includes('# 记忆（教师、班级与课程'), 'memory band');
  assert.ok(note.includes('# 焦点节点 p1.1.1'), 'focus band');
  // Order: focus sits last, nearest the teacher's newest message.
  assert.ok(note.indexOf('# 课程计划骨架') < note.indexOf('# 记忆（教师、班级与课程'));
  assert.ok(note.indexOf('# 记忆（教师、班级与课程') < note.indexOf('# 焦点节点 p1.1.1'));
});

test('skeleton band: rows for every node, titles only — and no plan renders nothing (both directions)', () => {
  assert.equal(skeletonBandText(null), '');
  assert.equal(skeletonBandText(undefined), '');
  assert.equal(skeletonBandText({ roots: [] }), '');
  const band = skeletonBandText(PLAN);
  for (const id of ['p1', 'p1.1', 'p1.1.1']) assert.ok(band.includes(id), id);
  assert.ok(band.includes('# plan-skeleton v1'), 'the version marker rides the table');
  assert.ok(band.includes('hypothesis') && band.includes('teacher_preset'), 'provenance travels with every row');
  assert.ok(!band.includes('整月脉络'), 'bodies never enter the skeleton');
});

test('skeleton band: the plan tree is shipped once, not twice', () => {
  const state = { ...createInitialState('once'), course_plan: PLAN };
  const note = stateNoteText(state);
  assert.equal(note.indexOf('狮头细看'), note.lastIndexOf('狮头细看'), 'titles appear in the skeleton only');
  assert.ok(note.includes('见下方「课程计划骨架」表'), 'the snapshot points at where the tree went');
  assert.ok(!note.includes('"roots"'), 'the pretty-printed tree is gone from the snapshot');
  assert.ok(note.includes('"course_plan"'), 'the key stays, so nothing reads as "this course has no plan"');
});

test('memory band: whole, unfiltered, every turn — and omitted only when memory is not wired (both directions)', () => {
  assert.equal(memoryBandText(null), '', 'not wired → no band');
  assert.equal(memoryBandText(undefined), '', 'not wired → no band');

  // A new class legitimately having no facts must stay distinguishable from a
  // refactor that silently stopped appending memory: the headers still render.
  const empty = memoryBandText([]);
  assert.ok(empty.includes('scope=class') && empty.includes('scope=course'), 'both scope headers survive an empty store');

  const band = memoryBandText(FACTS);
  assert.ok(band.includes('我们班没有鼓'), 'the class fact rides every turn');
  assert.ok(band.includes('这门课想落在醒狮上'), 'the course fact too');
  assert.ok(!band.includes('原本打算做龙舟'), 'archived facts stay out of the prompt');
  assert.ok(band.indexOf('scope=class') < band.indexOf('scope=course'), 'class first');
});

// ---------------- ADR-0011 §5: 「we looked and found nothing」 vs 「we did not look」
//
// The two absences produce opposite instructions to the model, and until now
// nothing asserted the difference. An empty band says this class has no
// constraints; an absent band says nothing about constraints at all. A layer
// that coerces a failed memory load into `[]` therefore hands the model a
// confident falsehood, and the symptom — 敲鼓感受节奏 offered to a class with no
// drums — is indistinguishable from the feature never having shipped.

test('memory band: an EMPTY store and an UNWIRED path are different prompts, and both say which they are', () => {
  const missing = memoryBandText(null);
  const empty = memoryBandText([]);
  assert.equal(missing, '', 'not looked up → no band at all');
  assert.notEqual(empty, '', 'looked up and empty → a band that says so');

  assert.ok(empty.includes('共 0 条'), 'the count is stated, not implied by absence');
  assert.ok(empty.includes('是查过之后没有，不是没查'), 'the model is told which absence this is');
  for (const scope of ['teacher', 'class', 'course']) {
    assert.ok(empty.includes(`scope=${scope}`), `${scope} header survives an empty store`);
  }

  // And the opposite direction: a populated band never claims to be empty.
  const full = memoryBandText(FACTS);
  assert.ok(full.includes('共 2 条'), 'live facts are counted');
  assert.ok(!full.includes('不是没查'), 'the empty notice appears only when it is true');
});

test('memory band: teacher scope rides the prompt too — widening must not delete a fact from context', () => {
  // 「这对我带的每个班都成立」 is her deliberate tap on 扩大. A band rendering only
  // class and course would answer that tap by dropping the fact out of every
  // future prompt — 「我早就跟你说过」, caused by the widen button.
  const widened = [{
    id: 'f-course-9', kind: 'space', scope: 'teacher', text: '下雨就用不了户外场地',
    quote: '我们下雨天就出不去', at: '2026-07-20T09:00:00Z', source: 'teacher',
    widened_from: 'course', widened_at: '2026-07-25T09:00:00Z',
  }];
  const band = memoryBandText(widened);
  assert.ok(band.includes('下雨就用不了户外场地'), 'a teacher-scope fact is in the band');
  assert.ok(band.includes('scope=teacher'), 'under its own scope header');
  assert.ok(band.indexOf('scope=teacher') < band.indexOf('scope=class'), 'widest first');
  assert.ok(band.indexOf('scope=class') < band.indexOf('scope=course'), 'then class, then course');
  assert.ok(band.includes('共 1 条'));
});

test('ASSERTION (ADR-0011 §5) FIRES: memory looked up, band dropped from the note', () => {
  // The regression the ADR names — a refactor that keeps fetching facts and
  // stops appending the band. It cannot be produced through today's inputs
  // (every array yields a band), which is exactly what a tripwire for a future
  // refactor should look like, so the rule is exercised as the function it is.
  const noBand = ['# 当前 course_state（只读快照）', '# 课程计划骨架（只读…）'];
  assert.throws(() => assertMemoryBand(noBand, []), /记忆 band is missing/, 'empty lookup dropped');
  assert.throws(() => assertMemoryBand(noBand, FACTS), /记忆 band is missing/, 'populated lookup dropped');
  assert.throws(() => assertMemoryBand([], FACTS), /ADR-0011/, 'and it names the ADR that requires it');
  // A band under the OLD heading is still a dropped band: renaming the heading
  // without updating the constant is how an assertion stops asserting.
  assert.throws(() => assertMemoryBand(['# 记忆（班级与课程；…）'], FACTS), /记忆 band is missing/);
});

test('ASSERTION (ADR-0011 §5) STAYS SILENT: not looked up, or looked up and shipped', () => {
  const withBand = [memoryBandText([])];
  assert.doesNotThrow(() => assertMemoryBand([], null), 'null = not looked up, absence is correct');
  assert.doesNotThrow(() => assertMemoryBand([], undefined), 'undefined = not looked up');
  assert.doesNotThrow(() => assertMemoryBand(withBand, []), 'empty and shipped');
  assert.doesNotThrow(() => assertMemoryBand([memoryBandText(FACTS)], FACTS), 'populated and shipped');

  // And through the real assembler, on every stage and every band combination.
  const state = createInitialState('assert-memory');
  assert.doesNotThrow(() => stateNoteText(state, { facts: null }));
  assert.doesNotThrow(() => stateNoteText(state, {}));
  assert.doesNotThrow(() => stateNoteText(state, { facts: [] }));
  assert.ok(stateNoteText(state, { facts: [] }).includes('# 记忆（教师、班级与课程'));
});

test('the assertion is wired into stateNoteText, not merely exported', async () => {
  for (const stage of [0, 1, 2, 3, 4, 5]) {
    const s = createInitialState(`assert-${stage}`);
    s.stage = stage;
    s.course_plan = PLAN;
    const { stateNote } = await buildPromptParts(s, stub, { facts: FACTS, subject: 'p1.1.1' });
    assert.ok(stateNote.includes('# 记忆（教师、班级与课程'), `stage ${stage} ships the band`);
  }
});

test('memory band is NOT retrieved by relevance: a class fact about drums rides a turn about lion heads', () => {
  const state = { ...createInitialState('no-retrieval'), course_plan: PLAN };
  const note = stateNoteText(state, { subject: 'p1.1.1', facts: FACTS });
  assert.ok(note.includes('我们班没有鼓'), 'one retrieval miss here is exactly 「我早就跟你说过」');
});

test('focus band: subject node body + ancestor summaries + revision reasons; no subject renders nothing (both directions)', () => {
  assert.equal(focusBandText(PLAN, undefined), '', 'no subject → no band');
  assert.equal(focusBandText(PLAN, 'course'), '', 'a course turn has no focus node');
  assert.equal(focusBandText(PLAN, 'p9.9'), '', 'an id that names no node renders nothing');
  assert.equal(focusBandText(null, 'p1.1.1'), '', 'no plan → no band');

  const band = focusBandText(PLAN, 'p1.1.1');
  assert.ok(band.includes('孩子会数狮头上有几个角（预设，待现场验证）。'), "the subject node's own body arrives whole");
  assert.ok(band.includes('p1「醒狮主题月」：一个月，从看狮到自己做狮头'), 'ancestor summary');
  assert.ok(band.includes('p1.1「第一周：去看醒狮」：带孩子实地看一次醒狮排练'), 'ancestor summary, root-first chain');
  assert.ok(!band.includes('整月脉络') && !band.includes('周内三次外出'), 'ancestor BODIES are never inlined, clipped or paraphrased');
  assert.ok(band.includes('把鼓换成木棍，班上没有鼓'), 'the recorded reason travels with the node');
  assert.ok(band.includes('v2 · 2026-08-01 · teacher'), 'and carries its stamp');
  assert.equal(band.split('\n').filter((l) => l.startsWith('- v')).length, 1, 'a revision with no reason is not a bullet');
});

test('focus band: both status axes label the body, so a hypothesis cannot read as confirmed', () => {
  const band = focusBandText(PLAN, 'p1.1.1');
  assert.ok(band.includes('来源状态：hypothesis'), 'provenance is on the header line');
  assert.ok(band.includes('工作状态：draft'), 'work status is a separate axis');
  // A node that states nothing about itself still gets the weaker claim, never
  // the stronger one.
  const bare = { roots: [{ id: 'n1', title: '无状态节点', body: '孩子提到了鼓。' }] };
  const bareBand = focusBandText(bare, 'n1');
  assert.ok(bareBand.includes('来源状态：ai_suggestion') && bareBand.includes('工作状态：draft'));
  assert.ok(!bareBand.includes('confirmed'));
});

test('focus band: staleness is shown, and an over-long revision log says what it left out', () => {
  const stale = {
    roots: [{
      id: 'n1', title: '被上游改动波及', body: '正文', status: 'confirmed', work_status: 'settled',
      stale_since: 'v0.4', stale_reason: '上一周的材料改了',
      revisions: Array.from({ length: 10 }, (_, i) => ({ version: i + 1, at: '2026-08-01', by: 'teacher', reason: `r${i + 1}` })),
    }],
  };
  const band = focusBandText(stale, 'n1');
  assert.ok(band.includes('待复查（自 v0.4，因 上一周的材料改了）'), 'the reason travels with the badge');
  assert.ok(band.includes('来源状态：confirmed'), 'staleness never demotes provenance');
  assert.ok(band.includes('（更早的 2 条未列出'), 'truncation is never silent');
  const kept = band.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.split('：').at(-1));
  assert.deepEqual(kept, ['r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10'], 'the newest eight, oldest first');
});

test('focus band reads the node, never the conversation', () => {
  const band = focusBandText(PLAN, 'p1.1.1');
  for (const marker of ['user', 'assistant', 'role', 'reply_markdown']) {
    assert.ok(!band.includes(marker), `${marker} has no business in a focus band`);
  }
});

test('buildPromptParts: bands ride the volatile note, never the cache-stable prefix', async () => {
  const state = { ...createInitialState('cache-bands'), course_plan: PLAN };
  const plain = await buildPromptParts(state, stub);
  const banded = await buildPromptParts(state, stub, { subject: 'p1.1.1', facts: FACTS });
  assert.equal(plain.system, banded.system, 'the prefix stays byte-stable → vendor cache hit');
  assert.notEqual(plain.stateNote, banded.stateNote, 'volatility confined to the tail');
  assert.ok(!banded.system.includes('我们班没有鼓') && !banded.system.includes('# 焦点节点'));
});

test('mock light touch: 年段 personalizes the blueprint (title + reply), defaults otherwise', () => {
  const withBand = mockTurn(createInitialState('prof1'), [], '我想带孩子做醒狮', { profile: { ageBand: '大班' } });
  const bp = withBand.artifacts.find((a) => a.type === 'blueprint');
  assert.ok(bp.title.includes('大班'), bp.title);
  assert.ok(withBand.reply_markdown.includes('大班孩子'));
  const plain = mockTurn(createInitialState('prof2'), [], '我想带孩子做醒狮');
  const bp2 = plain.artifacts.find((a) => a.type === 'blueprint');
  assert.ok(!bp2.title.includes('大班'), 'no profile → default band, never the wrong one');
});
