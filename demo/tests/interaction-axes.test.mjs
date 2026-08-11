// interaction-axes.test.mjs — the six teacher interaction axes (ADR-0009).
//
// Every rule here gets both directions, and the MUST-PASS direction is the one
// that matters: the migration promise （a teacher on 极简速览 behaves the same
// until she touches a handle）and the evidence invariant are things that must
// survive untouched, not things that must trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AXES, AXIS_IDS, VECTOR_VERSION, SOURCES, EVIDENCE_INVARIANT,
  PRESET_VECTORS, DEFAULT_PRESET, INFERENCE_CEILING, NUDGE_STEP,
  ONBOARDING_CONFIDENCE, MIN_TURN_FOR_INFERENCE,
  defaultVector, normalizeVector, vectorFromPreset, applyOnboarding,
  nudge, pinAxis, unpinAxis, turnOverride,
  vectorToDirectives, axisDirective, describeVector, bandOf, sourceRank, resolveAxisId,
} from '../src/interaction-axes.mjs';

// prompt-builder is READ here only — the legacy style table is the migration
// contract this module has to honour, so the test reads it rather than
// restating it.
import { STYLE_DIRECTIVES } from '../src/prompt-builder.mjs';

/** Deep snapshot, so "pure" is asserted rather than assumed. */
const snap = (v) => JSON.parse(JSON.stringify(v));
const close = (a, b) => Math.abs(a - b) < 1e-9;

// ---------- shape ----------

test('axes: six of them, each with the poster wording and three directives', () => {
  assert.equal(AXES.length, 6);
  assert.deepEqual(AXIS_IDS, ['guidance', 'structure', 'pacing', 'depth', 'initiative', 'openness']);
  const zh = AXES.map((a) => a.zh);
  assert.deepEqual(zh, ['引导强度', '结构化程度', '输出节奏', '解释深度', '智能体主动性', '方案开放度']);
  for (const axis of AXES) {
    for (const band of ['low', 'mid', 'high']) {
      assert.ok(axis[band], `${axis.zh} 缺 ${band} 档标签`);
      assert.ok(axis.directives[band].length > 8, `${axis.zh} 的 ${band} 档指令太短`);
    }
  }
});

test('band: 1–2 low, 3 mid, 4–5 high, and out-of-range values clamp', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(bandOf), ['low', 'low', 'mid', 'high', 'high']);
  assert.equal(bandOf(0), 'low');
  assert.equal(bandOf(99), 'high');
});

test('axis lookup: id and 中文 label both resolve, junk does not', () => {
  assert.equal(resolveAxisId('guidance'), 'guidance');
  assert.equal(resolveAxisId('引导强度'), 'guidance');
  assert.equal(resolveAxisId('速度'), null);
});

test('precedence order is explicit ＞ inferred ＞ onboarding ＞ default', () => {
  assert.deepEqual(SOURCES, ['default', 'onboarding', 'inferred', 'explicit']);
  assert.ok(sourceRank('explicit') > sourceRank('inferred'));
  assert.ok(sourceRank('inferred') > sourceRank('onboarding'));
  assert.ok(sourceRank('onboarding') > sourceRank('default'));
  assert.equal(sourceRank('从天上掉下来的'), 0);
});

// ---------- the default ----------

test('default vector: no evidence anywhere, sitting on the shipped preset', () => {
  const v = defaultVector();
  assert.equal(v.version, VECTOR_VERSION);
  for (const id of AXIS_IDS) {
    assert.equal(v.axes[id].confidence, 0, '「中性」指没有证据，不是每轴都取中值');
    assert.equal(v.axes[id].source, 'default');
    assert.equal(v.axes[id].pinned, false);
    assert.equal(v.axes[id].value, PRESET_VECTORS[DEFAULT_PRESET].axes[id]);
  }
});

test('normalize: junk, partial and legacy input all become a complete vector', () => {
  for (const junk of [null, undefined, 'nope', 42, {}, { axes: null }]) {
    const v = normalizeVector(junk);
    assert.deepEqual(Object.keys(v.axes), AXIS_IDS);
  }
  const partial = normalizeVector({ axes: { depth: { value: 9, source: '天启', confidence: 7 } } });
  assert.equal(partial.axes.depth.value, 5, '越界值收进 1–5');
  assert.equal(partial.axes.depth.source, 'default', '未知来源不能冒充显式设定');
  assert.equal(partial.axes.depth.confidence, 1);
  assert.equal(partial.axes.guidance.value, PRESET_VECTORS[DEFAULT_PRESET].axes.guidance);
});

test('normalize: an empty handle is「没答」, not「最低档」', () => {
  // Number(null) and Number('') are both 0, which would clamp to 1. A blank
  // field in the profile UI must not read as the teacher asking for the
  // bottom of the scale.
  const fallback = PRESET_VECTORS[DEFAULT_PRESET].axes.depth;
  for (const blank of [null, undefined, '', '  ', [], {}, NaN]) {
    assert.equal(normalizeVector({ axes: { depth: { value: blank } } }).axes.depth.value, fallback,
      `空值 ${JSON.stringify(blank)} 不能变成 1`);
  }
  assert.equal(normalizeVector({ axes: { depth: { value: '4' } } }).axes.depth.value, 4, '数字字符串仍然认');
});

// ---------- presets: the migration promise ----------

test('presets: every shipped 回应风格 has a point in the space', () => {
  // If this fails, migrating a stored profile would silently drop a teacher's
  // setting — the one thing ADR-0009 §1 says must not happen.
  assert.deepEqual(Object.keys(PRESET_VECTORS).sort(), Object.keys(STYLE_DIRECTIVES).sort());
  assert.ok(DEFAULT_PRESET in STYLE_DIRECTIVES);
  assert.ok(DEFAULT_PRESET.startsWith('蓝图共创'));
});

test('presets: every point is a complete, in-range six-tuple', () => {
  for (const [name, preset] of Object.entries(PRESET_VECTORS)) {
    assert.deepEqual(Object.keys(preset.axes).sort(), [...AXIS_IDS].sort(), `${name} 少了轴`);
    for (const id of AXIS_IDS) {
      const v = preset.axes[id];
      assert.ok(Number.isInteger(v) && v >= 1 && v <= 5, `${name}.${id} = ${v}`);
    }
  }
});

test('presets: each renders to prose you can recognise as that style', () => {
  const MARKERS = {
    '简洁要点（直接给做法）': ['直接做', '清单和表格', '不摆选项'],
    '温和鼓励（多肯定、慢慢来）': ['一次只推进一步', '先肯定教师已有的做法'],
    '详细讲解（讲清为什么）': ['把判断依据讲透'],
    '案例参照（多给真实例子）': ['具体例子'],
    '提问引导（先问再建议）': ['共创伙伴', '不预设答案'],
    '极简速览（电报体、越短越好）': ['电报体', '只给结论和做法'],
    '蓝图共创（先给完整方案再一起改）': ['教师回传证据后', '一次给出完整的一版'],
  };
  for (const [name, markers] of Object.entries(MARKERS)) {
    const text = vectorToDirectives(vectorFromPreset(name));
    for (const m of markers) assert.ok(text.includes(m), `${name} 的散文里读不出「${m}」`);
  }
});

test('presets: no two of them render the same prose', () => {
  const rendered = Object.keys(PRESET_VECTORS).map((n) => vectorToDirectives(vectorFromPreset(n)));
  assert.equal(new Set(rendered).size, rendered.length, '两个风格渲染成同一段话，教师换风格就没有意义了');
});

test('presets: 极简速览 keeps its completeness floor — brevity may not delete safety', () => {
  const text = vectorToDirectives(vectorFromPreset('极简速览（电报体、越短越好）'));
  for (const must of ['活动步骤', '材料清单', '安全提醒', '观察点']) {
    assert.ok(text.includes(must), `求短不能漏掉「${must}」`);
  }
});

test('presets: an unknown name yields null instead of a wrong vector', () => {
  assert.equal(vectorFromPreset('八段锦（不存在的风格）'), null);
  assert.equal(vectorFromPreset(undefined), null);
});

test('presets: picking a style pins all six, so behaviour is frozen until a handle moves', () => {
  const v = vectorFromPreset('极简速览（电报体、越短越好）');
  for (const id of AXIS_IDS) {
    assert.equal(v.axes[id].pinned, true);
    assert.equal(v.axes[id].source, 'explicit');
    assert.equal(v.axes[id].confidence, 1);
  }
  // MUST-PASS direction: a whole session of observations changes nothing.
  let after = v;
  for (let i = 0; i < 20; i += 1) after = nudge(after, 'depth', 'up', { turnIndex: 10 + i });
  assert.deepEqual(snap(after), snap(v), '没碰把手之前，行为必须一模一样');
});

// ---------- rendering ----------

test('render: the model never sees the numbers', () => {
  const vectors = [
    defaultVector(),
    ...Object.keys(PRESET_VECTORS).map((n) => vectorFromPreset(n)),
    AXIS_IDS.reduce((v, id) => pinAxis(v, id, 1), defaultVector()),
    AXIS_IDS.reduce((v, id) => pinAxis(v, id, 5), defaultVector()),
  ];
  for (const v of vectors) {
    const text = vectorToDirectives(v);
    assert.ok(!/[0-9]/.test(text), `散文里出现了数字，模型会去推算刻度：${text}`);
  }
});

test('render: the evidence invariant closes every block, at every extreme', () => {
  // 主动性 5 ＋ 开放度 5 is the most licence-sounding corner of the space
  // （「合理补全」「开放式共创」）— exactly where non-negotiable #1 must still
  // be the last word.
  const loud = pinAxis(pinAxis(defaultVector(), 'initiative', 5), 'openness', 5);
  for (const v of [defaultVector(), loud, vectorFromPreset('极简速览（电报体、越短越好）')]) {
    const text = vectorToDirectives(v);
    assert.ok(text.includes(EVIDENCE_INVARIANT), '风格块里必须带证据不变量');
    assert.ok(text.trimEnd().endsWith(EVIDENCE_INVARIANT), '证据不变量必须在最后，否则上面的话读起来像例外');
  }
});

test('render: one sentence per axis, in the declared order', () => {
  const lines = vectorToDirectives(defaultVector()).split('\n');
  const axisLines = lines.filter((l) => AXES.some((a) => l.startsWith(`${a.zh}：`)));
  assert.equal(axisLines.length, 6);
  assert.deepEqual(axisLines.map((l) => l.split('：')[0]), AXES.map((a) => a.zh));
});

test('axisDirective: reads the band, tolerates a 中文 label, refuses to invent', () => {
  assert.equal(axisDirective('depth', 5), AXES.find((a) => a.id === 'depth').directives.high);
  assert.equal(axisDirective('解释深度', 1), AXES.find((a) => a.id === 'depth').directives.low);
  assert.equal(axisDirective('心情', 3), '');
});

// ---------- inference ----------

test('nudge: one observation moves an axis exactly one step, never two', () => {
  const base = defaultVector();
  const start = base.axes.depth.value;
  // Same assertion under every shape of "shout louder": a worded direction, an
  // oversized numeric magnitude, and a fat confidence step.
  for (const dir of ['up', 3, 99]) {
    const after = nudge(base, 'depth', dir, { turnIndex: 9 });
    assert.equal(after.axes.depth.value, start + 1, `方向 ${dir} 一次只能走一步`);
  }
  const big = nudge(base, 'depth', 'up', { turnIndex: 9, step: 5 });
  assert.equal(big.axes.depth.value, start + 1, 'step 只调置信度，不调步长');
  const down = nudge(base, 'depth', 'down', { turnIndex: 9 });
  assert.equal(down.axes.depth.value, start - 1);
});

test('nudge: raises confidence but never to the teacher-set level', () => {
  const first = nudge(defaultVector(), 'openness', 'up', { turnIndex: 9 });
  assert.ok(close(first.axes.openness.confidence, NUDGE_STEP));
  assert.equal(first.axes.openness.source, 'inferred');

  let v = defaultVector();
  for (let i = 0; i < 30; i += 1) v = nudge(v, 'openness', 'up', { turnIndex: 9 + i });
  assert.ok(v.axes.openness.confidence <= INFERENCE_CEILING, '推断不能装作和教师本人一样确定');
  assert.ok(v.axes.openness.confidence > 0.5);
  assert.equal(v.axes.openness.value, 5, '一路上调最终停在上界，不会越界');
});

test('nudge: a pinned axis resists inference, an unpinned one does not', () => {
  const pinned = pinAxis(defaultVector(), 'pacing', 4);
  const before = snap(pinned);
  const after = nudge(pinned, 'pacing', 'down', { turnIndex: 9, signal: '教师连续要求一次给完' });
  assert.deepEqual(snap(after), before, '钉住的轴：值、置信度、来源都不许动');

  // The trip direction: the same observation on the same axis, unpinned.
  const freed = unpinAxis(pinned, 'pacing');
  const moved = nudge(freed, 'pacing', 'down', { turnIndex: 9, signal: '教师连续要求一次给完' });
  assert.equal(moved.axes.pacing.value, 3);
  assert.equal(moved.axes.pacing.signal, '教师连续要求一次给完', '抽屉要能说出是哪条观察动了哪根轴');
});

test('nudge: silent on the opening turns of a session', () => {
  const base = defaultVector();
  for (const turnIndex of [0, 1, MIN_TURN_FOR_INFERENCE - 1]) {
    assert.deepEqual(snap(nudge(base, 'depth', 'up', { turnIndex })), snap(base), '一次性判断不算画像');
  }
  const ok = nudge(base, 'depth', 'up', { turnIndex: MIN_TURN_FOR_INFERENCE });
  assert.equal(ok.axes.depth.value, base.axes.depth.value + 1);
});

test('nudge: an unknown axis or a zero direction is a no-op, not a crash', () => {
  const base = defaultVector();
  assert.deepEqual(snap(nudge(base, '语速', 'up', { turnIndex: 9 })), snap(base));
  assert.deepEqual(snap(nudge(base, 'depth', 0, { turnIndex: 9 })), snap(base));
  assert.deepEqual(snap(nudge(base, 'depth', 'sideways', { turnIndex: 9 })), snap(base));
});

// ---------- the teacher's handles ----------

test('pin: full confidence, explicit source, value clamped into range', () => {
  const v = pinAxis(defaultVector(), '结构化程度', 9);
  assert.equal(v.axes.structure.value, 5);
  assert.equal(v.axes.structure.confidence, 1);
  assert.equal(v.axes.structure.source, 'explicit');
  assert.equal(v.axes.structure.pinned, true);
});

test('pin: a bad axis or a non-number fails loudly — this one is teacher-facing', () => {
  assert.throws(() => pinAxis(defaultVector(), '音量', 3), /unknown axis/);
  assert.throws(() => pinAxis(defaultVector(), 'depth', '高一点'), /1–5/);
  assert.throws(() => unpinAxis(defaultVector(), '音量'), /unknown axis/);
});

test('unpin: keeps the value, drops the claim that the teacher said so', () => {
  const pinnedV = pinAxis(defaultVector(), 'guidance', 5);
  const freed = unpinAxis(pinnedV, 'guidance');
  assert.equal(freed.axes.guidance.value, 5, '值仍是目前最好的估计');
  assert.equal(freed.axes.guidance.pinned, false);
  assert.equal(freed.axes.guidance.source, 'inferred');
  assert.ok(freed.axes.guidance.confidence <= INFERENCE_CEILING);
});

// ---------- precedence ----------

test('precedence: onboarding fills the default but yields to inference and to the teacher', () => {
  const base = defaultVector();
  const onboarded = applyOnboarding(base, { guidance: 5, 解释深度: 1, 心情: 3, openness: 'x', structure: null });
  assert.equal(onboarded.axes.guidance.value, 5, '默认档位让位给引导问答');
  assert.equal(onboarded.axes.guidance.source, 'onboarding');
  assert.ok(close(onboarded.axes.guidance.confidence, ONBOARDING_CONFIDENCE), '起始画像是低置信度的');
  assert.equal(onboarded.axes.depth.value, 1, '中文轴名也能用');
  assert.equal(onboarded.axes.openness.value, base.axes.openness.value, '非数字答案被忽略');
  assert.equal(onboarded.axes.structure.value, base.axes.structure.value, '跳过的题保持默认');
  assert.equal(onboarded.axes.structure.source, 'default', '跳过的题不算答过');

  const inferred = nudge(onboarded, 'guidance', 'down', { turnIndex: 9 });
  const explicit = pinAxis(inferred, 'openness', 5);
  const rerun = applyOnboarding(explicit, { guidance: 1, openness: 1 });
  assert.equal(rerun.axes.guidance.value, 4, '重跑引导问答不能覆盖真实互动学到的东西');
  assert.equal(rerun.axes.guidance.source, 'inferred');
  assert.equal(rerun.axes.openness.value, 5, '更不能覆盖教师亲手设的把手');
  assert.equal(rerun.axes.openness.source, 'explicit');
});

test('precedence: the teacher outranks everything, in either direction', () => {
  const inferred = nudge(defaultVector(), 'initiative', 'up', { turnIndex: 9 });
  const set = pinAxis(inferred, 'initiative', 1);
  assert.equal(set.axes.initiative.value, 1);
  assert.equal(set.axes.initiative.source, 'explicit');
});

// ---------- one-turn override ----------

test('override: changes this turn, leaves stored state byte-for-byte alone', () => {
  const stored = applyOnboarding(defaultVector(), { pacing: 5 });
  const before = snap(stored);
  const once = turnOverride(stored, 'pacing', 1); // 「这次直接给我一版就好」

  assert.deepEqual(snap(stored), before, '后台判断稳定：存起来的画像一个字都不能动');
  assert.equal(once.axes.pacing.value, 1);
  assert.equal(once.axes.pacing.turn_override, true);
  assert.equal(once.axes.pacing.source, stored.axes.pacing.source, '临时表达不改来源');
  assert.equal(once.axes.pacing.confidence, stored.axes.pacing.confidence);

  // 前台表达灵活：the render for THIS turn really does read the other band.
  assert.ok(vectorToDirectives(stored).includes(AXES[2].directives.high));
  assert.ok(vectorToDirectives(once).includes(AXES[2].directives.low));
  assert.ok(!vectorToDirectives(once).includes(AXES[2].directives.high));
});

test('override: beats a pin, because the pin was only ever aimed at inference', () => {
  const pinnedV = pinAxis(defaultVector(), 'depth', 5);
  const once = turnOverride(pinnedV, 'depth', 1);
  assert.equal(once.axes.depth.value, 1, '允许老师随时切换当次协作方式');
  assert.equal(once.axes.depth.pinned, true, '把手本身还在');
  assert.equal(pinnedV.axes.depth.value, 5);
});

test('override: rejects an axis it cannot honour', () => {
  assert.throws(() => turnOverride(defaultVector(), '语气', 1), /unknown axis/);
  assert.throws(() => turnOverride(defaultVector(), 'depth', null), /1–5/);
});

// ---------- purity and observability ----------

test('pure: no mutator touches the vector it was handed', () => {
  const v = vectorFromPreset('温和鼓励（多肯定、慢慢来）');
  const before = snap(v);
  nudge(v, 'depth', 'up', { turnIndex: 9 });
  pinAxis(v, 'depth', 1);
  unpinAxis(v, 'depth');
  applyOnboarding(v, { depth: 5 });
  turnOverride(v, 'depth', 2);
  vectorToDirectives(v);
  describeVector(v);
  assert.deepEqual(snap(v), before);
});

test('describe: the drawer can show where each axis is and why', () => {
  let v = defaultVector();
  v = nudge(v, 'depth', 'up', { turnIndex: 9, signal: '教师追问「为什么这样设计」' });
  v = pinAxis(v, 'structure', 5);
  v = turnOverride(v, 'pacing', 1);
  const rows = describeVector(v);

  assert.deepEqual(rows.map((r) => r.axis), AXIS_IDS);
  const depth = rows.find((r) => r.axis === 'depth');
  assert.equal(depth.source, 'inferred');
  assert.equal(depth.signal, '教师追问「为什么这样设计」', '看不出是哪条观察动的轴，就没法判断推断错没错');
  assert.equal(depth.zh, '解释深度');
  assert.equal(depth.bandLabel, AXES.find((a) => a.id === 'depth')[depth.band]);

  const structure = rows.find((r) => r.axis === 'structure');
  assert.equal(structure.pinned, true);
  assert.equal(structure.confidence, 1);
  assert.equal(rows.find((r) => r.axis === 'pacing').turnOverride, true);
  assert.equal(rows.find((r) => r.axis === 'guidance').turnOverride, false);
});
