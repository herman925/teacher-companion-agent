// memory-view.mjs — the PURE layer behind 记忆, the class picker and the six
// interaction handles (ADR-0011 §3, ADR-0013 §9, ADR-0009).
//
// It follows the plan-view.mjs precedent for the same reason that module exists:
// the decisions here have non-negotiables riding on them, and a decision made
// inside a DOM factory is a decision no test can reach. render.js draws what
// this module says; main.js wires the taps and owns every network call.
//
// WHAT THE MEMORY PAGE IS, AND WHAT IT MUST NEVER BECOME. Every row on it exists
// because the teacher SAID something and the extractor filed it. There is no add
// button, no blank field, no kind picker — and no create route behind one
// (serve.mjs refuses to grow one, and demo/tests/memory-routes.test.mjs pins the
// absence). That is not tidiness. A fact-entry form would ask her to perform the
// state machine (non-negotiable #2), and it would walk past every guard on the
// write path in one call: the closed taxonomy, the quote-must-be-in-this-turn
// check, the child-claim archive, the scope clamp. The only way a fact can come
// into being is that the agent heard it; the only thing this page does is show
// her what it heard and let her retire or widen it.
//
// 改一下 IS NOT AN EDIT, and there is deliberately no update method behind it.
// Correcting a fact means SAYING the correction: `correctionPrompt` hands a
// sentence to the composer and the ordinary extraction path re-files it with a
// fresh quote from a fresh turn. An in-place text edit would produce a fact
// whose `quote` no longer contains its own words — exactly the state the quote
// check exists to make impossible.

import {
  AXES, bandOf, axisDirective, describeVector, isReadableVector,
} from '../interaction-axes.mjs';

/**
 * The scopes the viewer shows, WIDEST FIRST — the same order the prompt band
 * renders in (memory-scopes.PROMPT_SCOPES), because this page is meant to be a
 * readable picture of what the model is actually carrying.
 *
 * `node` is here and NOT in the prompt band, deliberately: node memory is
 * generated rather than extracted and reaches the model through the focus band,
 * so rendering it into the memory band would ship it twice — but it is still
 * something the agent holds, and a viewer that hid it would under-report.
 * @type {ReadonlyArray<{scope: string, label: string, hint: string}>}
 */
export const SCOPE_VIEWS = Object.freeze([
  { scope: 'teacher', label: '我带的每个班', hint: '不管哪门课、哪个班，我都记着。' },
  { scope: 'class', label: '这个班', hint: '跟着班走，换一门课也还算数。' },
  { scope: 'course', label: '这门课', hint: '只在这门课里管用。' },
  { scope: 'node', label: '某一项活动', hint: '跟着那一项走，是我自己整理出来的。' },
]);

/** The closed taxonomy in the teacher's words. Keys are FACT_KINDS
 * (memory-scopes.mjs). A kind with no label shows its raw id rather than
 * vanishing — a row the page cannot name is still a row the model carries. */
export const FACT_KIND_LABELS = Object.freeze({
  equipment: '器材',
  space: '场地',
  schedule: '时间安排',
  class_composition: '班里的情况',
  teacher_preference: '你的习惯',
});

/**
 * Why an archived fact is archived, said plainly.
 *
 * FOUR REASONS, FOUR DIFFERENT ANSWERS TO 「它为什么不记得了」. Collapsing them
 * into one 「已归档」 would give the same wrong explanation for events that are
 * not alike: `child_claim` is the agent refusing to remember something about
 * children with no evidence behind it, `cap` is the ceiling evicting the
 * least-used row, `superseded` is a newer statement taking over, and
 * `teacher_removed` is HER — and she is owed an answer that says so.
 */
export const ARCHIVE_REASON_TEXT = Object.freeze({
  child_claim: '这句讲的是孩子已经做到的事——那要凭现场证据，没有记进记忆。',
  cap: '记忆装满了，这一条最久没用到，先收了起来。',
  superseded: '后来有更新的说法，这一条让位了。',
  teacher_removed: '你让我忘掉的。',
  unknown: '收起来了，没有记下原因。',
});

/** Where a row came from, in one phrase. `source` arrives already collapsed by
 * the store (`factRow`): 'auto' = the extractor heard it in passing, 'teacher' =
 * she confirmed it or widened it by hand. */
export const SOURCE_LABEL = Object.freeze({ auto: '我听来的', teacher: '你定过的' });

/** The ladder, one rung at a time. Mirrors memory-scopes.widenScope's own steps
 * — course → class → teacher, never skipping, never narrowing — so a rung the
 * policy refuses is a button that never exists rather than a request the server
 * rejects. */
const WIDEN_STEP = Object.freeze({ course: 'class', class: 'teacher' });

/** @param {string} kind */
export function kindLabel(kind) {
  const key = String(kind ?? '');
  return FACT_KIND_LABELS[key] ?? (key || '未分类');
}

/** @param {{source?: string}} fact */
export function sourceLabel(fact) {
  return SOURCE_LABEL[fact?.source] ?? SOURCE_LABEL.auto;
}

/** One line saying WHY an archived row left. Never blank, never generic when a
 * specific reason exists. @param {string} reason */
export function archiveReasonText(reason) {
  const key = String(reason ?? '') || 'unknown';
  return ARCHIVE_REASON_TEXT[key] ?? ARCHIVE_REASON_TEXT.unknown;
}

/** Same thing, taking the row instead of the field — for callers that have the
 * fact in hand. @param {{archive_reason?: string}} fact */
export function archiveNote(fact) {
  return archiveReasonText(fact?.archive_reason);
}

/**
 * What 扩大 this row may offer, or null when it may offer nothing.
 *
 * `class` needs a class to widen INTO, and the caller only has one when the
 * course is bound (`courses.class_id`). With none the offer is WITHHELD rather
 * than shown-and-refused: a button that always errors teaches her to distrust
 * the buttons that work.
 *
 * ONE RUNG, EVER. 「这个班就是这样」 and 「我带的每个班都这样」 are
 * different-sized claims and one tap must not assert both — the same reason
 * memory-scopes.widenScope refuses to skip a rung, and the reason the second tap
 * (the caller's confirm) spells out the reach before it commits.
 * @param {{scope?: string, archived?: boolean}} fact
 * `confirm` is the REACH spelled out — what the second tap actually commits to.
 * It ships from here rather than being assembled at the button because the two
 * rungs commit to different-sized things, and a confirm string built next to the
 * button is one that can drift away from the rung the server will accept.
 * @param {{classId?: string|null}} [opts]
 * @returns {{to: string, label: string, confirm: string, classId: string|null}|null}
 */
export function widenOffer(fact, opts = {}) {
  if (!fact || fact.archived) return null; // 退休的判断不再升级
  const to = WIDEN_STEP[String(fact.scope ?? '')];
  if (!to) return null;
  const classId = opts.classId ?? null;
  if (to === 'class') {
    if (!classId) return null;
    return { to, classId, label: '扩大到这个班', confirm: '这个班的每门课都会带上它' };
  }
  return { to, classId: null, label: '扩大到我所有班', confirm: '你带的每个班、每一门课都会带上它' };
}

/** Newest first inside a group: the thing she said last is the thing she is
 * most likely looking for. */
const byNewest = (a, b) => String(b?.at ?? '').localeCompare(String(a?.at ?? ''));

/**
 * Split one `listFacts(..., {includeArchived: true})` result into the shape the
 * page draws: live rows grouped by scope, widest first, plus one archived
 * section carrying every reason.
 *
 * `facts === null` IS NOT AN EMPTY MEMORY and never renders as one. `listFacts`
 * throws rather than returning `[]` precisely so a read failure stays
 * distinguishable from a teacher who has said nothing memorable, and this page
 * keeps that distinction: `loaded: false` shows 「没读到」, `loaded: true` with no
 * rows shows 「还没有记住什么」. Telling her the agent remembers nothing when in
 * fact it could not look is the same lie the prompt band refuses to tell the
 * model.
 *
 * Empty scopes are dropped rather than drawn as empty headers: the count line
 * above already states absence once, and four empty sections only dilute it.
 *
 * @param {Array<Object>|null|undefined} facts
 * @returns {{loaded: boolean, total: number, liveCount: number,
 *   groups: Array<{scope: string, label: string, hint: string, rows: Array<Object>}>,
 *   archived: Array<Object>}}
 */
export function groupMemory(facts) {
  if (!Array.isArray(facts)) {
    return { loaded: false, total: 0, liveCount: 0, groups: [], archived: [] };
  }
  const rows = facts.filter((f) => f && typeof f === 'object');
  const archived = rows.filter((f) => f.archived).sort(byNewest);
  const live = rows.filter((f) => !f.archived);
  const groups = SCOPE_VIEWS
    .map((view) => ({ ...view, rows: live.filter((f) => f.scope === view.scope).sort(byNewest) }))
    .filter((g) => g.rows.length);
  return { loaded: true, total: rows.length, liveCount: live.length, groups, archived };
}

/**
 * Does she need to be asked which class this course is for?
 *
 * ONLY WHEN THE ANSWER IS GENUINELY UNKNOWN. Bound already: no. One class: no —
 * asking a teacher with one class which class this is would be asking her to
 * fill a field the system already knows, which is the form-filling this product
 * exists not to do (non-negotiable #2); the caller binds it silently instead.
 * Zero classes: no — there is nothing to pick, and a class comes into being by
 * her NAMING one in conversation, never through a management screen.
 * @param {Array<Object>|null|undefined} classes
 * @param {{class_id?: string|null}|null|undefined} course
 * @returns {boolean}
 */
export function shouldAskClass(classes, course) {
  if (course && course.class_id) return false;
  const list = Array.isArray(classes) ? classes.filter((k) => k && k.id) : [];
  return list.length > 1;
}

/**
 * The class the caller should bind SILENTLY, or null when it must ask (or when
 * there is nothing to bind). Exactly one class means exactly one answer, and a
 * question with one possible answer is not a question.
 * @param {Array<Object>|null|undefined} classes
 * @param {{class_id?: string|null}|null|undefined} course
 * @returns {string|null}
 */
export function silentClassBinding(classes, course) {
  if (course && course.class_id) return null;
  const list = Array.isArray(classes) ? classes.filter((k) => k && k.id) : [];
  return list.length === 1 ? list[0].id : null;
}

/**
 * The sentence 改一下 hands to the composer.
 *
 * A QUESTION TO THE AGENT, not a patch: she then says what is actually wrong and
 * the ordinary turn re-files it, quote and all. It opens with her own recorded
 * words so she can see which row she is talking about after the page closes.
 * @param {{text?: string}} fact
 * @returns {string}
 */
export function correctionPrompt(fact) {
  const text = String(fact?.text ?? '').trim();
  return text ? `你记着的「${text}」要改一下：` : '有一条记忆要改一下：';
}

// ------------------------------------------------- 六轴 handles (ADR-0009)

/** How sure the agent is, in words rather than a number. The numbers exist so
 * inference can move a value by one step; they stay backstage — interaction-
 * axes' own doctrine (后台判断稳定，前台表达灵活). */
export function confidenceLabel(confidence, source) {
  if (source === 'explicit') return '你说的算';
  const c = Number(confidence) || 0;
  if (c >= 0.6) return '比较有把握';
  if (c >= 0.3) return '大致有个印象';
  return '还没看出来';
}

/** Where a handle's value came from, in her words. An agent that profiles its
 * user and cannot show its work is a trust defect regardless of accuracy
 * (ADR-0009 §4), so every row states this, every time. */
export const AXIS_SOURCE_LABEL = Object.freeze({
  explicit: '你设定的',
  inferred: '根据你最近几次的操作推断',
  onboarding: '开头那几个问题里说过',
  default: '还没看出来，先用默认的',
});

/**
 * The six rows the profile pane draws.
 *
 * EVERY ROW ALWAYS HAS A VALUE AND A SOURCE, which is the whole difference
 * between this pane and a settings form: it opens showing what the agent
 * currently believes about her and why, so moving a handle is a CORRECTION of a
 * stated belief rather than the completion of an empty field.
 * @param {any} vector `profile.interaction_vector` (or anything, including junk)
 * @returns {Array<{axis: string, zh: string, value: number, band: string,
 *   bandLabel: string, low: string, mid: string, high: string, pinned: boolean,
 *   source: string, sourceLabel: string, confidence: number,
 *   confidenceLabel: string, signal: string, directive: string}>}
 */
export function axisHandleRows(vector) {
  const meta = new Map(AXES.map((a) => [a.id, a]));
  return describeVector(vector).map((row) => {
    const a = meta.get(row.axis);
    return {
      axis: row.axis,
      zh: row.zh,
      value: row.value,
      band: row.band,
      bandLabel: row.bandLabel,
      low: a?.low ?? '',
      mid: a?.mid ?? '',
      high: a?.high ?? '',
      pinned: row.pinned,
      source: row.source,
      sourceLabel: AXIS_SOURCE_LABEL[row.source] ?? AXIS_SOURCE_LABEL.default,
      confidence: row.confidence,
      confidenceLabel: confidenceLabel(row.confidence, row.source),
      signal: row.signal,
      // The exact sentence the model is told. 「回应风格 is a promise, not a
      // label」 (DESIGN.md §4): she reads what the agent was actually asked to
      // do, not a marketing word for it.
      directive: axisDirective(row.axis, row.value),
    };
  });
}

/**
 * One session-log payload per handle move — axis, from, to, source, confidence
 * and the signal, which is ADR-0009 §4's audit trail of the profiling.
 *
 * Built here rather than at the call site so the shape cannot drift between the
 * pin path, the unpin path, the preset path and whatever inference layer lands
 * later. A profiling event that each caller formats its own way is an audit
 * trail nobody can read across.
 * @param {string} axis @param {any} before @param {any} after
 * @param {{signal?: string}} [opts]
 * @returns {{axis: string, from: number|null, to: number|null, band_from: string,
 *   band_to: string, source: string, confidence: number, pinned: boolean, signal: string}}
 */
export function axisChangeEvent(axis, before, after, opts = {}) {
  const pick = (v) => describeVector(v).find((r) => r.axis === axis) ?? null;
  const a = pick(before);
  const b = pick(after);
  return {
    axis,
    from: a ? a.value : null,
    to: b ? b.value : null,
    band_from: a ? bandOf(a.value) : '',
    band_to: b ? bandOf(b.value) : '',
    source: b ? b.source : '',
    confidence: b ? b.confidence : 0,
    pinned: Boolean(b && b.pinned),
    signal: String(opts.signal ?? (b ? b.signal : '') ?? ''),
  };
}

/**
 * The export/debug projection of both features — the observability half
 * (AGENTS.md; ADR-0011 and ADR-0009 §4 each name it).
 *
 * MEMORY: counts and reasons, not bodies. The session-log events
 * (`memory_fact_recorded` / `memory_fact_refused` / `memory_forgotten` /
 * `memory_widened`) already carry the text, and repeating every fact body in the
 * export `context` would duplicate teacher content for no extra diagnostic
 * power. What a reader CANNOT reconstruct from the events — how many rows are
 * live right now, at which scope, and what has been retired and why — is exactly
 * what this returns.
 *
 * AXES: the whole vector, because it is six numbers plus their provenance, and a
 * drawer showing the values without the sources would be showing a profile with
 * its justification removed.
 * @param {{facts?: Array<Object>|null, vector?: any, classes?: Array<Object>|null,
 *   courseClassId?: string|null}} [input]
 * @returns {Object}
 */
export function memorySnapshot(input = {}) {
  const grouped = groupMemory(input.facts);
  let memory;
  if (grouped.loaded) {
    const byScope = {};
    const byKind = {};
    for (const g of grouped.groups) {
      byScope[g.scope] = g.rows.length;
      for (const row of g.rows) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
    }
    const archivedByReason = {};
    for (const row of grouped.archived) {
      const key = String(row.archive_reason ?? '') || 'unknown';
      archivedByReason[key] = (archivedByReason[key] ?? 0) + 1;
    }
    memory = {
      loaded: true,
      live: grouped.liveCount,
      archived: grouped.archived.length,
      by_scope: byScope,
      by_kind: byKind,
      archived_by_reason: archivedByReason,
    };
  } else {
    // STATED, never omitted: an absent key in an export reads as 「the feature
    // is off」, and this is 「the feature ran and could not read」.
    memory = { loaded: false, note: '这次没读到记忆（不是没有，是没读到）' };
  }

  const classes = Array.isArray(input.classes) ? input.classes : [];
  return {
    memory,
    classes: {
      count: classes.length,
      bound_class_id: input.courseClassId ?? null,
      // Names, because a class identity IS its name, and an export of anonymous
      // uuids answers no question anyone opens an export to ask.
      names: classes.map((k) => String(k?.name ?? '')).filter(Boolean),
    },
    // `readable` is the isReadableVector verdict the prompt assembler uses.
    // When it is false the model is steered by the legacy stylePref line
    // instead, and an export that did not say so would misexplain every reply
    // in the file.
    interaction_vector: {
      readable: isReadableVector(input.vector),
      axes: axisHandleRows(input.vector).map((r) => ({
        axis: r.axis, zh: r.zh, value: r.value, band: r.band, band_label: r.bandLabel,
        source: r.source, confidence: r.confidence, pinned: r.pinned, signal: r.signal,
      })),
    },
  };
}
