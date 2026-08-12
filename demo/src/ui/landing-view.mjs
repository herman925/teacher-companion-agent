// landing-view.mjs — what she lands on, decided by where the course already is.
//
// PURE. render.js draws it (renderLanding) and main.js wires it, for the
// plan-view.mjs reason: this picks what a teacher sees first, and a choice made
// inside a DOM factory is one no test can reach.
//
// THE POINT OF THE FEATURE. On a phone there is no 工作台 beside the
// conversation — the panel is an edge sheet she has to go and open — so a course
// with a live plan opened at the same blank greeting as a course that does not
// exist yet. Three states, three answers:
//
//   fork      — nothing has happened. The two ways in (ADR-0010's entry fork).
//   step_zero — she has been talking, there is no plan. Name what is still
//               unknown, because that is what the next turns are for.
//   plan      — there is a plan. Say what is dated for today, what was missed,
//               and what is next — the question a teacher opens the app with.
//
// EVERY BRANCH REPORTS; NONE ASKS. Nothing here makes her declare a stage,
// confirm a phase, or tell the app something it could have read off the state it
// already holds (non-negotiable #2). The step-zero branch lists what is MISSING
// as conversation topics, not as fields: the checklist is the agent saying what
// it does not know yet, and the only control under it is 接着聊.
//
// 今天 IS A FILTER, NOT A LEVEL. `PLAN_KINDS` is phase → week → activity and a
// day is a `dates` FIELD on an activity (ADR-0010 §5b). 今天要做什么 is therefore
// computed by filtering dated activities; there is no 日 node and there must
// never be one.
//
// NOTHING HERE READS EVIDENCE OR CHILD CONTENT. Every field it emits comes off
// the plan tree the engine wrote — id, number, title, the two status axes, the
// staleness flag, the stored dates. A landing card that summarised what children
// had done would be non-negotiable #1 wearing a UI costume.

import { planViewModel } from './plan-view.mjs';

/** How many rows one landing card will name. More than this and the card stops
 * being an answer and becomes a second plan tree. */
export const LANDING_MAX = 5;

/** ISO calendar day (local) — the shape plan `dates` carry. */
function dayKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Whole days between two ISO day strings, positive when `to` is later.
 *
 * Parsed as UTC midnight on purpose: these are CALENDAR days, and applying a
 * timezone offset to a date-only string is how 「今天」 silently becomes 「昨天」
 * after 8pm — which on this surface means an activity she is about to run
 * appearing under 「过去几天没来得及的」.
 * @returns {number|null} null when either side is not a parseable date
 */
export function daysBetween(fromKey, toKey) {
  const a = Date.parse(`${fromKey}T00:00:00Z`);
  const b = Date.parse(`${toKey}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

/** 今天 / 明天 / 后天 / n 天后 / n 天前 — plain words, with the ISO date kept
 * beside them wherever the wording alone could be ambiguous. */
export function dayLabel(days) {
  if (days === 0) return '今天';
  if (days === 1) return '明天';
  if (days === 2) return '后天';
  if (days > 0) return `${days} 天后`;
  if (days === -1) return '昨天';
  return `${Math.abs(days)} 天前`;
}

/** An activity is DONE when its work_status says so, so it is not something she
 * still has to do. It is never removed from the plan — the tree is the record. */
const isDone = (n) => n.work_status === 'settled';

/** The projection a landing row may carry. Deliberately not the node itself:
 * the card must not become a place where plan fields quietly accumulate. */
const rowOf = (n, date) => ({
  id: n.id,
  number: n.number,
  title: n.title,
  date: date ?? '',
  status: n.status,
  work_status: n.work_status,
  stale: n.stale,
});

/**
 * Decide the landing.
 *
 * @param {Object|null|undefined} state course_state
 * @param {{transcript?: Array<Object>, now?: Date|string, max?: number}} [opts]
 * @returns {{mode: 'fork'|'step_zero'|'plan', today: Array<Object>,
 *   overdue: Array<Object>, next: {days: number, date: string, label: string,
 *   items: Array<Object>}|null, undated: number, version: number}}
 */
export function landingModel(state, opts = {}) {
  const model = planViewModel(state);
  const transcript = Array.isArray(opts.transcript) ? opts.transcript : [];
  const spoken = transcript.some((r) => r && r.role === 'user');
  const max = Number.isInteger(opts.max) && opts.max > 0 ? opts.max : LANDING_MAX;

  if (!model.hasPlan) {
    // Nothing said AND no plan is a course that has not started. One teacher
    // message is enough to leave the fork behind: offering 「两条路都行」 again
    // after she has already chosen one is the app forgetting the turn.
    return {
      mode: spoken ? 'step_zero' : 'fork',
      today: [], overdue: [], next: null, undated: 0, version: model.version,
    };
  }

  const today = dayKey(opts.now ? new Date(opts.now) : new Date());
  const dated = [];
  let undated = 0;
  for (const n of model.nodes) {
    if (n.kind !== 'activity') continue;     // a date is a field on an ACTIVITY and nowhere else
    const dates = (n.dates ?? []).filter(Boolean).map(String);
    if (!dates.length) { if (!isDone(n)) undated += 1; continue; }
    if (isDone(n)) continue;
    for (const d of dates) dated.push(rowOf(n, d));
  }
  dated.sort((a, b) => a.date.localeCompare(b.date) || String(a.number).localeCompare(String(b.number)));

  const todayRows = dated.filter((r) => r.date === today).slice(0, max);
  // Overdue is SHOWN, never hidden: a plan that quietly drops a missed day is a
  // plan that has stopped matching the room. Most-recent miss first — that is
  // the one she can still do something about.
  const overdue = dated.filter((r) => (daysBetween(today, r.date) ?? 0) < 0).slice(-max).reverse();

  let next = null;
  const ahead = dated.filter((r) => (daysBetween(today, r.date) ?? 0) > 0);
  if (ahead.length) {
    const date = ahead[0].date;
    const days = daysBetween(today, date);
    next = { days, date, label: dayLabel(days), items: ahead.filter((r) => r.date === date).slice(0, max) };
  }

  return { mode: 'plan', today: todayRows, overdue, next, undated, version: model.version };
}

/**
 * The one-line headline for a course that has a plan.
 *
 * Pinned by a test on purpose: 「今天没有安排」 must not quietly become 「今天没有
 * 活动」 in a refactor, because those two sentences say different things about a
 * plan that has undated activities sitting in it.
 * @param {{today?: Array<Object>, next?: {label: string, items: Array<Object>}|null,
 *   undated?: number}} landing
 * @returns {string}
 */
export function landingHeadline(landing) {
  const today = landing?.today ?? [];
  if (today.length) return `今天有 ${today.length} 项安排`;
  if (landing?.next) return `今天没有安排，${landing.next.label}有 ${landing.next.items.length} 项`;
  if (landing?.undated) return `今天没有安排，还有 ${landing.undated} 项没有定日子`;
  return '今天没有安排';
}
