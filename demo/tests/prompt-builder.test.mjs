// prompt-builder must be byte-compatible with the legacy serve.mjs assembly
// (no-profile case), inject the 教师档案 section only when filled, and the
// profile must NEVER be model-writable (bad_delta strips it). Both directions
// per the repo's runtime-harness discipline.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildSystemPrompt, profileSectionText, stageModuleName, STAGE_MODULE, STYLE_DIRECTIVES } from '../src/prompt-builder.mjs';
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

test('mock light touch: 年段 is addressed in the intent question, absent otherwise', () => {
  const withBand = mockTurn(createInitialState('prof1'), [], '我想带孩子做醒狮', { profile: { ageBand: '大班' } });
  assert.ok(withBand.question.text.includes('大班孩子'), withBand.question.text);
  const plain = mockTurn(createInitialState('prof2'), [], '我想带孩子做醒狮');
  assert.ok(!plain.question.text.includes('大班'));
  assert.ok(plain.question.text.includes('孩子'));
});
