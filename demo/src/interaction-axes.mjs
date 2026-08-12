// interaction-axes.mjs — the six teacher interaction axes (ADR-0009 §1/§2).
//
// Replaces the single 回应风格 selector with a six-dimensional vector. The old
// selector is not deleted, it is RE-EXPRESSED: PRESET_VECTORS holds the seven
// shipped styles as named points in this space, so a teacher already on
// 极简速览 keeps behaving the same way until she touches a handle. That
// migration promise is the reason presets exist here at all — without it every
// shipped fixture and every stored profile would quietly change meaning.
//
// WHY PROSE, NEVER NUMBERS. vectorToDirectives renders bands into sentences.
// A number in a prompt invites the model to reason about the scale （「四分算
// 高吗」）instead of behaving; the poster's own low/mid/high words are what the
// model can act on. The numbers exist so inference can move a value by one
// step and so the teacher's handles have something to hold — they stay
// backstage. 后台判断稳定，前台表达灵活。
//
// WHY STYLE NEVER TOUCHES EVIDENCE. Several axes （主动性「合理补全」、开放度
// 「开放式共创」）read like licence to fill gaps. The rendered block therefore
// always ends with the evidence invariant: expression may flex, non-negotiable
// #1 may not. Any future axis must keep that clause downstream of it.
//
// Pure module: no I/O, no clock, no mutation of the caller's vector. The
// signal log （interaction_signals, ADR-0009 §3）is a store concern and lives
// elsewhere; this module only says where an observation moves the vector.

/** Bump when the axis set or the vector shape changes, so a stored profile
 * from an older build fails loudly instead of being read one axis short. */
export const VECTOR_VERSION = 'v1';

/**
 * The six axes, in prompt order. `low`/`mid`/`high` are the poster's own words
 * （ADR-0009 §1 table）— they are what the profile UI labels the handles with,
 * so the teacher reads the same vocabulary the model is steered by.
 * `directives` is the prose actually injected.
 * @type {ReadonlyArray<{id: string, zh: string, low: string, mid: string, high: string,
 *   directives: {low: string, mid: string, high: string}}>}
 */
export const AXES = Object.freeze([
  {
    id: 'guidance',
    zh: '引导强度',
    low: '直接执行',
    mid: '适度提醒',
    high: '深度共创',
    directives: {
      // 不写「不反问」：蓝图共创坐在这一档，而它本身允许每轮再问两三个关键问题。
      low: '教师说做什么就直接做，不反复确认，也不额外追加流程建议。',
      mid: '按教师的要求推进，只在关键处提醒一句可能的遗漏或风险。',
      high: '把教师当共创伙伴：先一起理清思路与取舍，再共同把方案打磨出来。',
    },
  },
  {
    id: 'structure',
    zh: '结构化程度',
    low: '自然交流',
    mid: '有结构',
    high: '清单表格化',
    directives: {
      low: '用自然的口语段落回应，不加小标题和编号。',
      mid: '分几个小标题写，要点用短列表列出，其余用段落。',
      high: '尽量用清单和表格呈现：步骤、材料、观察点分条列出，一眼能扫完。',
    },
  },
  {
    id: 'pacing',
    zh: '输出节奏',
    low: '一次性完整输出',
    mid: '先框架后展开',
    high: '逐步确认推进',
    directives: {
      low: '一次给出完整的一版，要改的地方留到后面谈，不要挤牙膏。',
      mid: '先给整体框架，教师认可后再展开细节。',
      high: '一次只推进一步，每一步结束前先与教师确认再往下走。',
    },
  },
  {
    id: 'depth',
    zh: '解释深度',
    low: '只看结论',
    mid: '结论＋简要理由',
    high: '深入逻辑分析',
    directives: {
      low: '只给结论和做法，理由除非教师追问，否则不展开。',
      mid: '给出结论，并用一两句话说明为什么这样安排。',
      high: '把判断依据讲透：这样设计的原因、参照的经验、有哪些取舍与风险。',
    },
  },
  {
    id: 'initiative',
    zh: '智能体主动性',
    low: '严格按输入',
    mid: '合理补全',
    high: '主动提醒与挑战',
    directives: {
      low: '严格按教师给出的信息作答，缺什么就问，不自行补设定。',
      mid: '教师没说到的常规细节可以合理补全，并说明哪些是补的。',
      high: '主动指出被忽略的问题、提出更好的可能，必要时挑战教师的设想。',
    },
  },
  {
    id: 'openness',
    zh: '方案开放度',
    low: '明确方案',
    mid: '两三个选择',
    high: '开放式共创',
    directives: {
      low: '直接给一个明确方案，不摆选项。',
      mid: '给出两三个各有取舍的方案，说清差别，由教师挑。',
      high: '不预设答案，先抛出方向与可能性，和教师一起把方案生成出来。',
    },
  },
]);

/** Axis ids in prompt order — the rendering contract. */
export const AXIS_IDS = Object.freeze(AXES.map((a) => a.id));

/** The clause that closes every rendered block. Style flexes; non-negotiable
 * #1 does not. Kept as its own constant so a test can pin it and so nobody
 * has to reconstruct it from the render to check it is still there. */
export const EVIDENCE_INVARIANT =
  '以上只调节表达方式，不改变判断标准：未发生的儿童反应一律标注为预设、待现场验证，没有记录的事情不能写成已经发生。';

/** Where a value came from. Precedence is exactly this order （ADR-0009 §2）：
 * explicit ＞ inferred ＞ onboarding ＞ default. */
export const SOURCES = Object.freeze(['default', 'onboarding', 'inferred', 'explicit']);

/** @param {string} source @returns {number} higher wins */
export function sourceRank(source) {
  const i = SOURCES.indexOf(source);
  return i < 0 ? 0 : i;
}

// Tuning constants, not derived quantities. They are starting values chosen so
// the ordering below holds; pilot data, not arithmetic, should revise them.
//   0 …………………… no evidence at all （the default vector）
//   ONBOARDING …… a few answers, explicitly low-confidence （ADR-0009 §2）
//   NUDGE_STEP … one observation's worth
//   CEILING ……… inference can approach certainty but never reach it, because
//                full confidence means the teacher said so herself
//   1 …………………… the teacher set this handle
export const ONBOARDING_CONFIDENCE = 0.3;
export const NUDGE_STEP = 0.1;
export const INFERENCE_CEILING = 0.9;

/** 画像来自真实互动，不靠一次性判断：inference does not fire on the opening
 * turns of a session （ADR-0009 §2）. The turn index belongs to the caller, so
 * the guard only runs when the caller passes one. */
export const MIN_TURN_FOR_INFERENCE = 3;

const AXIS_BY_ID = new Map(AXES.map((a) => [a.id, a]));
const AXIS_BY_ZH = new Map(AXES.map((a) => [a.zh, a]));

/**
 * Accept either the code id （`guidance`）or the Chinese label （引导强度）,
 * because the profile UI holds the label and the inference layer holds the id.
 * @param {string} axis
 * @returns {string|null} canonical axis id, or null when unknown
 */
export function resolveAxisId(axis) {
  const key = String(axis ?? '').trim();
  if (AXIS_BY_ID.has(key)) return key;
  const byZh = AXIS_BY_ZH.get(key);
  return byZh ? byZh.id : null;
}

/** @param {string} axisId @returns {{id: string, zh: string}|undefined} */
export function axisMeta(axisId) {
  return AXIS_BY_ID.get(resolveAxisId(axisId) ?? '');
}

const clampValue = (v) => Math.min(5, Math.max(1, Math.round(Number(v))));
const clampConfidence = (c) => Math.min(1, Math.max(0, Number.isFinite(Number(c)) ? Number(c) : 0));

/** A short LABEL saying why an axis moved (`'asked_for_detail'`,
 * `'skipped_card'`), never a sentence. */
export const SIGNAL_MAX = 60;

/**
 * Clip a signal to a label.
 *
 * The axis vector lives in `users.settings` and the observations in
 * `interaction_signals` (DATABASE.md §2e), and every other teacher-derived
 * string in this codebase is capped — `scope_log.excerpt` at 60 with a database
 * CHECK, the access log at 60 code points, workbench fields at 500/2000. This
 * one was stored uncapped, so a caller passing a teacher sentence as the signal
 * would quietly put conversation text into a settings blob that has no
 * retention story of its own.
 *
 * Code points, not UTF-16 units, for the same reason access-log.mjs counts them
 * that way: `.slice()` can cut a character in half, and Postgres `length()`
 * counts characters.
 * @param {unknown} raw
 */
export const clipSignal = (raw) => Array.from(String(raw ?? '')).slice(0, SIGNAL_MAX).join('');

/**
 * Numbers only, and NOT via bare Number(): `Number(null)` and `Number('')` are
 * both 0, which would clamp to 1 — an empty handle in the profile UI would
 * silently read as 「最低档」 instead of as "no answer".
 * @param {any} v @returns {number|null}
 */
const numericOrNull = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};

/** 1–2 low · 3 mid · 4–5 high. The band, not the number, is what ships. */
export function bandOf(value) {
  const v = clampValue(value);
  if (v <= 2) return 'low';
  if (v === 3) return 'mid';
  return 'high';
}

/**
 * Coerce anything （a stored profile, a hand-written fixture, junk）into a
 * complete vector. Missing axes fall back to the default point rather than to
 * a midpoint: see defaultVector for why.
 * @param {any} data
 * @returns {{version: string, flavor: string, axes: Record<string, {value: number,
 *   confidence: number, source: string, pinned: boolean, signal?: string,
 *   turn_override?: boolean}>}}
 */
export function normalizeVector(data) {
  const src = data && typeof data === 'object' ? data : {};
  const rawAxes = src.axes && typeof src.axes === 'object' ? src.axes : {};
  const axes = {};
  for (const axis of AXES) {
    const raw = rawAxes[axis.id] && typeof rawAxes[axis.id] === 'object' ? rawAxes[axis.id] : {};
    const fallback = DEFAULT_POINT[axis.id];
    const given = numericOrNull(raw.value);
    const out = {
      value: given === null ? fallback : clampValue(given),
      confidence: clampConfidence(raw.confidence),
      source: SOURCES.includes(raw.source) ? raw.source : 'default',
      pinned: raw.pinned === true,
    };
    if (raw.signal) out.signal = clipSignal(raw.signal);
    if (raw.turn_override === true) out.turn_override = true;
    axes[axis.id] = out;
  }
  return { version: VECTOR_VERSION, flavor: String(src.flavor ?? ''), axes };
}

/** Deep copy used by every mutator, so the caller's vector is never touched. */
const cloneVector = (v) => {
  const axes = {};
  for (const id of AXIS_IDS) axes[id] = { ...v.axes[id] };
  return { version: v.version, flavor: v.flavor, axes };
};

/**
 * The seven shipped 回应风格 presets as points in the six-axis space
 * （ADR-0009 §1）. Keys are the exact legacy STYLE_DIRECTIVES keys, so
 * migration is a lookup and never a guess.
 *
 * `flavor` carries the residue the six axes cannot express — warmth, worked
 * examples, and 极简速览's completeness floor. Dropping it would be a silent
 * behaviour change, and in 极简速览's case a SAFETY change: without that
 * clause, brevity is free to delete the safety reminders and material lists.
 * A preset is therefore a point plus at most one sentence, not a parallel
 * mechanism — the axes still carry the behaviour.
 * @type {Readonly<Record<string, {axes: Record<string, number>, flavor: string}>>}
 */
export const PRESET_VECTORS = Object.freeze({
  '简洁要点（直接给做法）': {
    axes: { guidance: 1, structure: 4, pacing: 1, depth: 3, initiative: 2, openness: 1 },
    flavor: '',
  },
  '温和鼓励（多肯定、慢慢来）': {
    axes: { guidance: 3, structure: 2, pacing: 4, depth: 3, initiative: 2, openness: 3 },
    flavor: '先肯定教师已有的做法，语气温和，不催促。',
  },
  '详细讲解（讲清为什么）': {
    axes: { guidance: 3, structure: 3, pacing: 2, depth: 5, initiative: 3, openness: 2 },
    flavor: '',
  },
  '案例参照（多给真实例子）': {
    axes: { guidance: 3, structure: 3, pacing: 2, depth: 4, initiative: 3, openness: 3 },
    flavor: '多用贴近幼儿园现场的具体例子说明建议，让教师能直接对照。',
  },
  '提问引导（先问再建议）': {
    axes: { guidance: 4, structure: 2, pacing: 4, depth: 3, initiative: 4, openness: 4 },
    flavor: '',
  },
  '极简速览（电报体、越短越好）': {
    axes: { guidance: 1, structure: 4, pacing: 1, depth: 1, initiative: 2, openness: 1 },
    flavor: '用电报体：先结论后原因，短句，删客套；但活动步骤、材料清单、安全提醒、观察点必须完整列出，不因求短而漏项；对教师仍保持友善，不显得冷硬。',
  },
  '蓝图共创（先给完整方案再一起改）': {
    axes: { guidance: 2, structure: 3, pacing: 2, depth: 3, initiative: 3, openness: 2 },
    flavor: '每轮先交付内容，最多再问两三个关键问题；教师回传证据后，先对照原方案说明哪些保留、哪些调整，再给下一步。',
  },
});

/** The preset the product ships on （ADR-0009 §1）. */
export const DEFAULT_PRESET = '蓝图共创（先给完整方案再一起改）';

const DEFAULT_POINT = PRESET_VECTORS[DEFAULT_PRESET].axes;

/**
 * The starting vector for a teacher we know nothing about.
 *
 * Neutral means NO EVIDENCE （every confidence is zero, every source is
 * `default`）— it deliberately does not mean the midpoint of every axis. The
 * point is 蓝图共创's, because that is what the product ships on today
 * （ADR-0009 §1）; starting everyone at all-mid would change the behaviour of
 * every existing teacher on the day this lands, which is the one thing the
 * migration may not do.
 * @returns {ReturnType<typeof normalizeVector>}
 */
export function defaultVector() {
  const axes = {};
  for (const axis of AXES) {
    axes[axis.id] = { value: DEFAULT_POINT[axis.id], confidence: 0, source: 'default', pinned: false };
  }
  return { version: VECTOR_VERSION, flavor: PRESET_VECTORS[DEFAULT_PRESET].flavor, axes };
}

/**
 * A teacher picking a named style is an explicit choice of all six values at
 * once, so the axes land pinned: 「a teacher on 极简速览 must behave
 * identically until she touches a handle」. Unpinning one handle hands that
 * axis back to inference.
 * @param {string} name a PRESET_VECTORS key
 * @returns {ReturnType<typeof normalizeVector>|null} null when the name is unknown
 */
export function vectorFromPreset(name) {
  const preset = PRESET_VECTORS[String(name ?? '')];
  if (!preset) return null;
  const axes = {};
  for (const axis of AXES) {
    axes[axis.id] = { value: clampValue(preset.axes[axis.id]), confidence: 1, source: 'explicit', pinned: true };
  }
  return { version: VECTOR_VERSION, flavor: preset.flavor, axes };
}

/**
 * Apply onboarding answers. Onboarding outranks only the default, so a
 * returning teacher who re-runs it cannot overwrite what inference learned or
 * what she set by hand.
 * @param {any} vector
 * @param {Record<string, number>} values axis id or 中文 label → 1–5
 * @returns {ReturnType<typeof normalizeVector>}
 */
export function applyOnboarding(vector, values) {
  const next = cloneVector(normalizeVector(vector));
  for (const [rawAxis, rawValue] of Object.entries(values ?? {})) {
    const id = resolveAxisId(rawAxis);
    const value = numericOrNull(rawValue);
    if (!id || value === null) continue; // 跳过的问题就是没答，不是答了最低档
    const cur = next.axes[id];
    if (sourceRank(cur.source) > sourceRank('onboarding')) continue; // 显式与推断都压过引导问答
    next.axes[id] = {
      ...cur,
      value: clampValue(value),
      confidence: Math.max(cur.confidence, ONBOARDING_CONFIDENCE),
      source: 'onboarding',
    };
  }
  return next;
}

/**
 * One observation, one axis, AT MOST one step （ADR-0009 §2）. The cap is the
 * whole point: wrong inference costs trust faster than absent inference buys
 * it, so no single turn can swing an axis across a band boundary and out the
 * other side.
 *
 * Refuses silently — rather than throwing — on an unknown axis, because the
 * caller here is the heuristic inference layer and a bad axis name must not
 * take down a teacher's turn. The teacher-facing setters below throw instead.
 *
 * @param {any} vector
 * @param {string} axis axis id or 中文 label
 * @param {'up'|'down'|number} direction sign only; magnitude is ignored by design
 * @param {{signal?: string, turnIndex?: number, step?: number}} [opts]
 *   `signal` is recorded on the axis so the debug drawer can say WHICH
 *   observation moved WHICH axis （ADR-0009 §4）; `step` adjusts the confidence
 *   increment only, never the value increment.
 * @returns {ReturnType<typeof normalizeVector>}
 */
export function nudge(vector, axis, direction, opts = {}) {
  const next = cloneVector(normalizeVector(vector));
  const id = resolveAxisId(axis);
  if (!id) return next;

  const cur = next.axes[id];
  if (cur.pinned) return next; // 教师钉住的轴，推断不再移动

  const turnIndex = Number(opts.turnIndex);
  if (Number.isFinite(turnIndex) && turnIndex < MIN_TURN_FOR_INFERENCE) return next;

  const sign = direction === 'up' ? 1 : direction === 'down' ? -1 : Math.sign(Number(direction) || 0);
  if (!sign) return next;

  const step = Number.isFinite(Number(opts.step)) ? Math.abs(Number(opts.step)) : NUDGE_STEP;
  const moved = {
    ...cur,
    value: clampValue(cur.value + sign), // ±1 — magnitude of `direction` is deliberately dropped
    confidence: Math.min(INFERENCE_CEILING, Math.max(cur.confidence, clampConfidence(cur.confidence + step))),
    source: 'inferred',
  };
  if (opts.signal) moved.signal = clipSignal(opts.signal);
  next.axes[id] = moved;
  return next;
}

/**
 * The teacher's handle: pins the axis at full confidence and stops inference
 * touching it until she unpins （ADR-0009 §2）.
 * @param {any} vector @param {string} axis @param {number} value 1–5
 * @returns {ReturnType<typeof normalizeVector>}
 */
export function pinAxis(vector, axis, value) {
  const id = resolveAxisId(axis);
  if (!id) throw new Error(`interaction axes: unknown axis "${axis}"`);
  const v = numericOrNull(value);
  if (v === null) throw new Error(`interaction axes: ${id} needs a 1–5 value`);
  const next = cloneVector(normalizeVector(vector));
  next.axes[id] = { ...next.axes[id], value: clampValue(v), confidence: 1, source: 'explicit', pinned: true };
  return next;
}

/**
 * Hand an axis back to inference. The value stays where the teacher left it —
 * that is still the best estimate we have — but the source drops to `inferred`
 * so precedence stays honest: an unpinned axis is no longer the teacher's
 * word, and confidence comes back under the inference ceiling.
 * @param {any} vector @param {string} axis
 * @returns {ReturnType<typeof normalizeVector>}
 */
export function unpinAxis(vector, axis) {
  const id = resolveAxisId(axis);
  if (!id) throw new Error(`interaction axes: unknown axis "${axis}"`);
  const next = cloneVector(normalizeVector(vector));
  const cur = next.axes[id];
  next.axes[id] = {
    ...cur,
    pinned: false,
    source: cur.source === 'explicit' ? 'inferred' : cur.source,
    confidence: Math.min(INFERENCE_CEILING, cur.confidence),
  };
  return next;
}

/**
 * 「这次直接给我一版就好」— one turn only. Returns a vector for THIS render;
 * the stored profile is untouched （this module is pure, so "untouched" is
 * structural, not a promise the caller has to keep）. 后台判断稳定，前台表达
 * 灵活。
 *
 * Deliberately overrides a pinned axis too: the pin stops INFERENCE from
 * drifting the profile, it was never meant to stop the teacher from asking
 * for something different this once.
 * @param {any} vector @param {string} axis @param {number} value 1–5
 * @returns {ReturnType<typeof normalizeVector>} a render-only vector
 */
export function turnOverride(vector, axis, value) {
  const id = resolveAxisId(axis);
  if (!id) throw new Error(`interaction axes: unknown axis "${axis}"`);
  const v = numericOrNull(value);
  if (v === null) throw new Error(`interaction axes: ${id} needs a 1–5 value`);
  const next = cloneVector(normalizeVector(vector));
  // source/confidence keep the STORED judgment; only the value and the marker
  // change, so the drawer can show "本轮临时" without losing the real profile.
  next.axes[id] = { ...next.axes[id], value: clampValue(v), turn_override: true };
  return next;
}

/** The single directive sentence for one axis at one value. */
export function axisDirective(axis, value) {
  const meta = axisMeta(axis);
  if (!meta) return '';
  return meta.directives[bandOf(value)];
}

/**
 * Render the vector for the system prompt. Prose only — the numbers stay in
 * storage. Shape mirrors the legacy 回应风格 line so the surrounding prompt
 * assembly does not have to change how it thinks about this block.
 * @param {any} vector
 * @returns {string}
 */
export function vectorToDirectives(vector) {
  const v = normalizeVector(vector);
  const lines = ['回应风格（按这位教师的互动偏好调整表达方式）：'];
  for (const axis of AXES) lines.push(`${axis.zh}：${axis.directives[bandOf(v.axes[axis.id].value)]}`);
  if (v.flavor) lines.push(`另外，${v.flavor}`); // 逗号而非冒号：flavor 自己常带冒号
  lines.push(EVIDENCE_INVARIANT); // last, so nothing above it reads as an exception
  return lines.join('\n');
}

/**
 * Is this a STORED vector this build can read whole?
 *
 * `normalizeVector` is deliberately forgiving — it coerces junk into a complete
 * vector so a mutator never crashes on a half-written profile. That is exactly
 * the wrong behaviour at the prompt boundary: junk would there render as the
 * DEFAULT vector, and a teacher whose stored axes failed to load would be
 * steered by 蓝图共创's directives while the profile pane showed her something
 * else. So the assembler asks this first, and renders no axis block at all when
 * the answer is no.
 *
 * The version check is what `VECTOR_VERSION` was declared for （「so a stored
 * profile from an older build fails loudly instead of being read one axis
 * short」）and nothing was calling it. Loudly, here, means REFUSED rather than
 * thrown: a stale vector must not take a teacher's turn down, and the caller's
 * fallback — the legacy `stylePref` line — is a visible difference she and the
 * drawer can both see, not a silently-wrong six-axis block.
 *
 * @param {any} data
 * @returns {boolean}
 */
export function isReadableVector(data) {
  if (!data || typeof data !== 'object') return false;
  if (String(data.version ?? '') !== VECTOR_VERSION) return false;
  const axes = data.axes;
  if (!axes || typeof axes !== 'object') return false;
  // At least one axis must actually be there. An `axes: {}` is a write that
  // failed halfway, not a teacher who happens to hold every default.
  return AXIS_IDS.some((id) => axes[id] && typeof axes[id] === 'object');
}

/**
 * Row-per-axis view for the debug drawer and the exports （ADR-0009 §4）. A
 * teacher must be able to see where the vector is AND why: an agent that
 * profiles its user and cannot show its work is a trust defect regardless of
 * accuracy.
 *
 * HALF-WIRED AS OF 2026-08-13, and recorded here rather than left to be
 * rediscovered. THE PROMPT PATH IS LIVE: `prompt-builder.mjs` reads
 * `profile.interaction_vector`, renders `vectorToDirectives` into the
 * cache-stable prefix, and renders a per-turn override into the volatile note —
 * with the legacy `stylePref` line kept as the fallback for a profile that
 * carries no vector, so nobody's behaviour changes until a vector is written.
 *
 * STILL MISSING: nothing WRITES a vector. No UI sets `interaction_vector`, no
 * inference layer calls `nudge`, and no session-log event records one （so
 * `signal` — which observation moved which axis, the entire audit trail of the
 * profiling — is still written into a vector nobody keeps）. The storage slot
 * needs no new plumbing: `settings.profile.interaction_vector`, which
 * json-store's `saveUserProfile` persists wholesale and `sanitizeUser` returns
 * wholesale. The missing halves are the client writing it, the drawer rendering
 * these rows, and `interaction_signals` recording the nudges. See HANDOFF.md.
 * @param {any} vector
 * @returns {Array<{axis: string, zh: string, value: number, band: string,
 *   bandLabel: string, confidence: number, source: string, pinned: boolean,
 *   signal: string, turnOverride: boolean}>}
 */
export function describeVector(vector) {
  const v = normalizeVector(vector);
  return AXES.map((axis) => {
    const a = v.axes[axis.id];
    const band = bandOf(a.value);
    return {
      axis: axis.id,
      zh: axis.zh,
      value: a.value,
      band,
      bandLabel: axis[band],
      confidence: a.confidence,
      source: a.source,
      pinned: a.pinned,
      signal: a.signal ?? '',
      turnOverride: a.turn_override === true,
    };
  });
}

/**
 * What moved between two vectors, as `interaction_signals` rows.
 *
 * THE TABLE EXISTS AND NOTHING WROTE TO IT. `recordSignal` / `listSignals` are
 * implemented in both tiers and were reachable from nowhere, so ADR-0009 §3's
 * 「为什么这个把手动了」 had no answer at all: the vector changed in
 * `users.settings` and left no trace of when or by how much. An agent that
 * profiles its user and cannot show its work is a trust defect, and the fix has
 * to be a WRITER, not another read method.
 *
 * PURE AND HERE rather than inline in the request handler, because 「did this
 * axis move」 is a question about the vector, and the same diff has to be
 * available to the inference path when it lands.
 *
 * `signal` is a LABEL, never a sentence — clipped like every other
 * teacher-derived string in this codebase (see `clipSignal`).
 *
 * @param {any} before the stored vector （null on a first save）
 * @param {any} after the incoming one
 * @returns {Array<{axis: string, signal: string, delta: number}>} one row per
 *   axis that actually changed; empty when nothing did
 */
export function diffVectors(before, after) {
  const a = normalizeVector(before);
  const b = normalizeVector(after);
  const rows = [];
  for (const id of AXIS_IDS) {
    const was = a.axes[id];
    const now = b.axes[id];
    const moved = now.value !== was.value;
    const pinChanged = now.pinned !== was.pinned;
    if (!moved && !pinChanged) continue;
    // Four different events, and they are not the same fact about her. Handing
    // a handle back to inference （unpin） is the one that would otherwise be
    // invisible: the value need not change at all, and yet what the agent is
    // allowed to do with that axis just changed completely.
    let signal;
    if (pinChanged && !now.pinned) signal = 'unpinned';
    else if (pinChanged) signal = moved ? 'moved_and_pinned' : 'pinned';
    else if (now.source === 'explicit') signal = 'teacher_moved';
    else if (now.source === 'onboarding') signal = 'onboarding';
    else signal = `${now.source}_moved`;
    rows.push({ axis: id, signal: clipSignal(signal), delta: now.value - was.value });
  }
  return rows;
}
