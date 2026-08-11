// memory-scopes.mjs — course / class / teacher facts (ADR-0011 §1, §2, §4).
//
// THE HOLE THIS FILLS. A teacher opens 活动 3.2.1 and says 「我们班没有鼓，而且有几个
// 孩子很怕大声」. Two different things came out of that sentence: *this activity now
// uses sticks* (a fact about 3.2.1, which node provenance already carries), and
// *this class has no drums* — which is not a fact about 3.2.1 at all. It
// constrains every activity in every week of every course she will ever plan,
// and node-scoped memory has nowhere to put it except on the node, where 周3
// will never look. Two days later she is offered 敲鼓感受节奏 and thinks
// 「我早就跟你说过」.
//
// WHAT THIS MODULE IS NOT. Node memory is GENERATED, not extracted — it is the
// `rationale` plus the revision history that already exists on every node
// (ADR-0007 §5). Nothing here builds it. Only course, class and teacher facts
// need an agent to notice something and keep it.
//
// DEFAULT NARROW, WIDEN DELIBERATELY. Filing a fact too narrowly makes her
// repeat herself once — annoying. Filing it too broadly follows her invisibly
// into every future course — much worse, and invisible is the expensive half.
// So auto-extraction lands at COURSE scope no matter what it claims, and only
// `widenScope` — her deliberate tap — can move a fact up. This is the same
// asymmetry as provenance escalation, where only a deliberate act reaches
// `confirmed`.
//
// GROWTH IS BOUNDED BY CURATION, NOT COMPRESSION (ADR-0011 §4): merge a
// restatement, supersede a contradiction (archiving the old one WITH A POINTER,
// never deleting it, so the record of what was believed when survives), and cap
// with a visible notice. Silent truncation is barred by AGENTS.md.
//
// Everything here is pure. No clock reads except an explicit `opts.now`
// default, no storage, no I/O — so the whole curation policy is testable.

import { CHILD_CLAIM_RE } from './harness.mjs';

/**
 * The four scopes, narrowest first. Order is the widening ladder and is load
 * bearing — `SCOPE_RANK` and `WIDEN_STEPS` are both derived from it.
 *
 * ROOM CONSTRAINTS ARE NOT A FIFTH SCOPE IN V1 (ADR-0011 §1).
 * 「多功能室才有投影仪」 is filed as a CLASS fact with the room named inside its
 * own text. That is why the room has to survive in `text` rather than being
 * normalized away: if pilots show teachers restating room facts across classes,
 * promoting rooms to a real scope is then a search-and-retag rather than a
 * reconstruction from utterances nobody kept.
 * @type {ReadonlyArray<string>}
 */
export const SCOPES = ['node', 'course', 'class', 'teacher'];

/** Narrow → broad. Used to stop an automatic judgement from retiring a
 * deliberate one; see `supersedeFact`. */
const SCOPE_RANK = Object.fromEntries(SCOPES.map((s, i) => [s, i]));

/** The only legal widenings. One rung at a time, and never downward — see
 * `widenScope` for why skipping a rung is refused. */
const WIDEN_STEPS = new Map([['course', 'class'], ['class', 'teacher']]);

/** Where automatic extraction is allowed to file. The clamp, not a suggestion. */
const AUTO_MAX_SCOPE = 'course';

/** Bump when the column set changes — the header carries it, so a stale reader
 * fails loudly instead of reading column 5 as column 4. */
export const MEMORY_TSV_VERSION = 'v1';

/** The column set. ~8 max (ADR-0011 §6); order is the contract. */
export const MEMORY_COLUMNS = ['id', 'scope', 'fact', 'quote', 'at', 'source'];

/** Written into any cell that would otherwise be empty. Two consecutive tabs
 * are how a model silently mis-reads the next column. Deliberately a local
 * const rather than an import from plan-tsv.mjs: these two tables share a rule,
 * not a schema, and the memory block must not break when the plan skeleton's
 * columns change. */
const EMPTY = '-';

/** Realistic volume is 20–40 short lines (ADR-0011 §4). Callers cap per scope
 * by slicing first — `capFacts` caps whatever list it is handed. */
export const DEFAULT_FACT_CAP = 40;

/** A class fact is one short sentence. Longer means the extractor is writing
 * prose into a row, which the cap makes visible instead of letting it bloat
 * every single turn. Bodies belong in the focus band (ADR-0011 §6). */
const TEXT_MAX = 60;
const QUOTE_MAX = 40;

/** Tabs and newlines would break the table. Facts are short display strings, so
 * stripping is safe here in a way it would never be for a node body. */
const flatten = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();

/** Options for re-normalizing rows that are already on disk: the clock, and
 * deliberately NOT `byTeacher` — see `mergeFact`. */
const stored = (opts) => ({ now: opts?.now });

/** FNV-1a, 32-bit. Not security — just a stable short id derived from scope and
 * text, so the same fact reloaded from storage keeps the same id and every
 * `superseded_by` pointer written against it stays valid.
 *
 * The id records where the fact was MINTED and is never recomputed afterwards,
 * so a widened fact still reads `f-course-…` while sitting at class scope. That
 * looks wrong and is not: recomputing it on every widen would break every
 * pointer aimed at it, which is the one thing the id exists to prevent. Read
 * the scope from the `scope` field, never from the id. */
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * The key two facts must share to count as restatements of each other.
 *
 * Punctuation and spacing carry no meaning for 「is this the same fact」 and
 * teachers type both widths, so both are stripped. NOTHING ELSE IS. This is a
 * restatement check, not paraphrase detection: 「我们班没有鼓」 and 「班上没有鼓」
 * will not merge. That is the deliberate direction to fail in — a missed merge
 * costs one duplicate line she can delete, while a false merge silently loses a
 * distinct constraint and nothing on screen explains the loss. Canonicalizing
 * the wording is the extractor's job upstream, where a model can read meaning.
 *
 * Scope is part of the key: 「这门课不用鼓」 and 「这个班没有鼓」 have different reach,
 * and folding them together would silently widen one of them. The separator is
 * a space, which the stripping guarantees cannot occur inside the text half, so
 * the two halves can never blur across the boundary.
 */
const restatementKey = (f) => `${f.scope} ${String(f.text).replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()}`;

/** Last time this fact mattered. A fact she keeps hitting is worth more than
 * one she happened to state recently, so use beats creation. ISO-8601 sorts
 * lexicographically, which is the whole reason timestamps are stored as
 * strings. */
const lastTouch = (f) => String(f.used_at || f.at || '');

/** NOTHING IS CLIPPED HERE. This block used to truncate at 60 characters —
 * exactly the operation prompt-builder refuses to perform on a node summary,
 * and for exactly its reason: a fact ending 「…，这一条是我的猜测，还没问过她」 loses
 * precisely that qualifier at the cut, and a guess arriving in context as a
 * flat statement is non-negotiable #1 violated by formatting. Over-length rows
 * render WHOLE and are counted in the header instead, so an extractor writing
 * prose into a row stays visible without any fact being quietly rewritten.
 * Growth is bounded by curation (`capFacts`, which says so out loud), never by
 * silent truncation — which AGENTS.md bars outright. */
const overLong = (f) => flatten(f.text).length > TEXT_MAX || flatten(f.quote).length > QUOTE_MAX;

/**
 * Normalize raw facts into the safe shape `{scope, text, quote, at, id}` plus
 * `source`, carrying any curation bookkeeping through untouched.
 *
 * `source` answers 「who put this fact at THIS scope」 — `'auto'` (extracted) or
 * `'teacher'` (she said so, or she tapped widen). It defaults to `'auto'`
 * because an unlabelled fact of unknown origin must be treated as the machine's
 * guess; assuming `'teacher'` would let a mislabelled row sit at teacher scope
 * forever. THE CLAMP LIVES HERE: an `'auto'` fact claiming class or teacher
 * scope is rewritten down to course, on every pass including reload, so a
 * corrupt or over-eager row is repaired rather than trusted.
 *
 * A fact with no text is dropped — there is nothing to file, and an empty row
 * would render as `-` and read to the model as a fact.
 *
 * @param {Array<Object>|Object|null|undefined} raw one fact or a list of them
 * @param {{now?: string, byTeacher?: boolean}} [opts] `now` stamps facts that
 *   arrive without `at`; pass it to keep callers and tests deterministic.
 *   `byTeacher` marks THIS CALL as her deliberate act — a tap in the memory
 *   page — and is the only thing that lets a fact arrive at `source: 'teacher'`
 *   or above course scope. Trust travels in the call, never in the data: a
 *   field on the fact object is a field an extractor can write.
 * @returns {Array<Object>} normalized facts, input untouched
 */
export function normalizeFacts(raw, opts = {}) {
  const now = flatten(opts.now) || new Date().toISOString();
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw] : []);
  const seen = new Set();
  const out = [];

  for (const item of list) {
    const f = item && typeof item === 'object' ? item : {};
    const text = flatten(f.text);
    if (!text) continue;

    // `source: 'teacher'` is never taken on trust from the fact itself. Two
    // things can produce it: `opts.byTeacher` (this call IS her act), and
    // `widenScope`, which stamps `widened_at` at the same moment — so that
    // stamp is what a stored row shows on reload. Without this, one field the
    // extractor controls walks straight around the clamp below, and the whole
    // asymmetry the clamp exists for (narrow by default, widen only by her
    // deliberate tap) is decoration.
    const source = f.source === 'teacher' && (opts.byTeacher === true || flatten(f.widened_at)) ? 'teacher' : 'auto';
    // Node scope is accepted but never produced here: node memory is generated
    // elsewhere, and rewriting an existing node fact to course would move it
    // somewhere its owner will never look for it.
    let scope = SCOPES.includes(f.scope) ? f.scope : 'course';
    if (source === 'auto' && SCOPE_RANK[scope] > SCOPE_RANK[AUTO_MAX_SCOPE]) scope = AUTO_MAX_SCOPE;

    let id = flatten(f.id) || `f-${scope}-${hash32(`${scope} ${text}`)}`;
    while (seen.has(id)) id = `${id}-dup`;
    seen.add(id);

    const fact = {
      id,
      scope,
      text,
      // The utterance this came from. ADR-0011's consequences require knowing
      // WHICH sentence produced WHICH fact, so a wrong extraction is
      // diagnosable rather than mysterious.
      quote: flatten(f.quote),
      at: flatten(f.at) || now,
      source,
    };

    // A FACT IS A CONSTRAINT, NOT A CLAIM ABOUT CHILDREN. 「班上没有鼓」 binds
    // every future week; 「孩子们已经学会了划桨」 is an assertion about what
    // happened in a classroom, and filing it here would give it an unbounded
    // lifetime — sent whole, every turn, under a header that reads as settled.
    // That is non-negotiable #1 with no expiry date, so it is archived on
    // arrival: kept and visible in the store and the export (archiving is not
    // deleting), never rendered into the prompt.
    if (CHILD_CLAIM_RE.test(text)) {
      fact.archived = true;
      fact.archived_at = flatten(f.archived_at) || fact.at;
      fact.archive_reason = 'child_claim';
    }

    // Curation bookkeeping. Present only when it happened, so an ordinary fact
    // stays five short fields wide in storage and in the export.
    if (f.archived === true) {
      fact.archived = true;
      fact.archived_at = flatten(f.archived_at) || fact.at;
      fact.archive_reason = flatten(f.archive_reason) || 'unknown';
    }
    if (f.superseded_by) fact.superseded_by = flatten(f.superseded_by);
    const sup = Array.isArray(f.supersedes) ? f.supersedes : (f.supersedes ? [f.supersedes] : []);
    const supIds = sup.map(flatten).filter(Boolean);
    if (supIds.length) fact.supersedes = supIds;
    if (f.used_at) fact.used_at = flatten(f.used_at);
    if (f.widened_from) fact.widened_from = flatten(f.widened_from);
    if (f.widened_at) fact.widened_at = flatten(f.widened_at);
    if (Number(f.restated) > 0) fact.restated = Number(f.restated);

    out.push(fact);
  }

  return out;
}

/**
 * File an incoming fact, merging it into an existing one when it merely
 * restates it (ADR-0011 §4: update the timestamp, do not append).
 *
 * The merged row keeps the ORIGINAL id and quote. The id, because every
 * `superseded_by` pointer aimed at this fact must stay valid. The quote,
 * because it is the utterance that actually produced the fact — replacing it
 * with the sentence that merely repeated it would make the audit trail name the
 * wrong moment.
 *
 * Archived facts are not merge targets. If she states something that was
 * superseded two weeks ago, she has changed her mind back — that is a live new
 * fact, not a resurrection of a retired row, and the archived row must keep
 * saying what was believed when.
 *
 * @param {Array<Object>} facts current facts, live and archived
 * @param {Object} incoming the candidate fact
 * @param {{now?: string}} [opts]
 * @returns {{facts: Array<Object>, action: 'merged'|'added'|'ignored'}}
 *   `'ignored'` is the third outcome, for input carrying no text: reporting
 *   `'added'` when nothing was added would be exactly the kind of lie this
 *   codebase bans.
 */
export function mergeFact(facts, incoming, opts = {}) {
  // The stored list is normalized WITHOUT `byTeacher`: her tap authorizes the
  // fact she is filing now, not a re-blessing of every row already on disk.
  const list = normalizeFacts(facts, stored(opts));
  const [next] = normalizeFacts(incoming, opts);
  if (!next) return { facts: list, action: 'ignored' };

  const key = restatementKey(next);
  const hit = list.find((f) => !f.archived && restatementKey(f) === key);
  if (!hit) return { facts: [...list, next], action: 'added' };

  const merged = { ...hit, at: next.at, restated: (hit.restated ?? 0) + 1 };
  return { facts: list.map((f) => (f === hit ? merged : f)), action: 'merged' };
}

/**
 * File a contradicting fact, archiving what it contradicts WITH A POINTER.
 *
 * The caller names the target through `incoming.supersedes` (an id or a list of
 * them). This module cannot detect contradiction itself and does not pretend
 * to: 「班上没有鼓」 versus 「园里买了两个鼓」 share no string, and a heuristic that
 * guessed would archive real constraints on a coin flip.
 *
 * Nothing is ever removed from the list. Archiving sets `archived`,
 * `archived_at`, `archive_reason` and `superseded_by`, so the record of what was
 * believed when survives and the memory page can show her the chain.
 *
 * AN AUTOMATIC JUDGEMENT MAY NOT RETIRE A DELIBERATE ONE. An `'auto'` fact —
 * which the clamp has already pinned to course scope — cannot archive a class
 * or teacher fact she widened by hand. That would undo her tap invisibly, the
 * same failure the clamp exists to prevent, arriving from the other direction.
 * The refusal leaves BOTH facts live: two visible contradicting lines she can
 * resolve beat either silently dropping the new one or silently killing hers.
 *
 * @param {Array<Object>} facts current facts, live and archived
 * @param {Object} incoming the contradicting fact, carrying `supersedes`
 * @param {{now?: string}} [opts]
 * @returns {{facts: Array<Object>, archived: Array<Object>, refused: Array<{id: string, reason: string}>}}
 *   `refused` exists so an unarchived target is reportable rather than silent.
 */
export function supersedeFact(facts, incoming, opts = {}) {
  const list = normalizeFacts(facts, stored(opts));
  const [next] = normalizeFacts(incoming, opts);
  if (!next) return { facts: list, archived: [], refused: [] };

  const targets = new Set(next.supersedes ?? []);
  const archived = [];
  const refused = [];

  const out = list.map((f) => {
    if (!targets.has(f.id)) return f;
    if (f.archived) {
      refused.push({ id: f.id, reason: 'already_archived' });
      return f;
    }
    if (next.source === 'auto' && SCOPE_RANK[f.scope] > SCOPE_RANK[next.scope]) {
      refused.push({ id: f.id, reason: 'auto_cannot_archive_wider' });
      return f;
    }
    const a = {
      ...f,
      archived: true,
      archived_at: next.at,
      archive_reason: 'superseded',
      superseded_by: next.id,
    };
    archived.push(a);
    return a;
  });

  for (const id of targets) if (!list.some((f) => f.id === id)) refused.push({ id, reason: 'not_found' });

  return { facts: [...out, next], archived, refused };
}

/**
 * Hold the live set to `max` by archiving the oldest-unused overflow, and SAY SO.
 *
 * Silent truncation is barred (AGENTS.md), so the notice is the point of this
 * function rather than a courtesy: a class constraint that stopped being sent
 * to the model without anyone noticing reproduces 「我早就跟你说过」 exactly, with
 * nothing on screen to explain it.
 *
 * Oldest-UNUSED, not oldest: `used_at` beats `at`, so a fact she keeps hitting
 * survives a fact she stated last week and never touched again. Archived facts
 * do not count toward the cap — they already stopped riding the prompt.
 *
 * @param {Array<Object>} facts current facts, live and archived
 * @param {number} [max] live-fact ceiling; defaults to `DEFAULT_FACT_CAP`
 * @param {{now?: string}} [opts]
 * @returns {{facts: Array<Object>, archived: Array<Object>, notice: string}}
 *   `notice` is teacher-facing prose, empty when nothing was archived.
 */
export function capFacts(facts, max, opts = {}) {
  const now = flatten(opts.now) || new Date().toISOString();
  const list = normalizeFacts(facts, stored(opts));
  const limit = Number.isFinite(max) && max >= 0 ? Math.floor(max) : DEFAULT_FACT_CAP;

  const live = list.filter((f) => !f.archived);
  if (live.length <= limit) return { facts: list, archived: [], notice: '' };

  // Array.prototype.sort is stable, so equal timestamps keep insertion order
  // rather than picking a victim at random.
  const doomed = new Set(
    [...live].sort((a, b) => lastTouch(a).localeCompare(lastTouch(b)))
      .slice(0, live.length - limit)
      .map((f) => f.id),
  );

  const archived = [];
  const out = list.map((f) => {
    if (!doomed.has(f.id) || f.archived) return f;
    const a = { ...f, archived: true, archived_at: now, archive_reason: 'cap' };
    archived.push(a);
    return a;
  });

  const shown = archived.slice(0, 3).map((f) => f.text).join('、');
  const more = archived.length > 3 ? '等' : '';
  const notice = `记忆到了上限（${limit} 条），把最久没用到的 ${archived.length} 条收进了归档：${shown}${more}。归档不是删除，在记忆页随时可以拿回来。`;

  return { facts: out, archived, notice };
}

/**
 * Render the memory block the model reads (ADR-0011 §4, §6).
 *
 * ONE-WAY, unlike the plan skeleton. The store is canonical JSON; this table is
 * a projection into the prompt, so there is no parser to keep in step and no
 * round-trip to test. Timestamps render as the date alone — time of day has
 * never decided whether a class owns a drum, and the full value stays in the
 * store and in the export.
 *
 * Archived facts are excluded. Not sending them is the entire point of
 * archiving; a superseded belief riding the prompt would be worse than never
 * having archived it.
 *
 * The header is emitted even with zero rows, so the assembler's assertion
 * (ADR-0011 §5) can tell 「a new class legitimately has no facts」 apart from
 * 「a refactor silently stopped appending memory」 — which is the one regression
 * that assertion exists to catch.
 *
 * @param {Array<Object>} facts current facts, live and archived
 * @param {string} [scope] one of `SCOPES`; anything else renders every scope
 * @returns {string} header comment + column header + one row per live fact
 */
export function factsToTSV(facts, scope) {
  const list = normalizeFacts(facts).filter((f) => !f.archived);
  const want = SCOPES.includes(scope) ? scope : '';
  const rows = want ? list.filter((f) => f.scope === want) : list;

  // Said out loud rather than fixed silently: an over-length row is an
  // extractor writing prose into a table, and the row it wrote still goes to
  // the model whole (see `overLong`).
  const long = rows.filter(overLong).length;
  const lines = [
    `# memory ${MEMORY_TSV_VERSION} · scope=${want || 'all'} · ${rows.length} 条${long ? ` · 其中 ${long} 条超出建议长度，已完整给出未截断` : ''} · quote 是老师的原话，source=auto 表示她还没有确认过`,
    MEMORY_COLUMNS.join('\t'),
  ];

  for (const f of rows) {
    lines.push([
      f.id,
      f.scope,
      f.text,
      f.quote,
      f.at.slice(0, 10),
      f.source,
    ].map((c) => flatten(c) || EMPTY).join('\t'));
  }

  return lines.join('\n');
}

/**
 * Promote a fact one rung: course → class, or class → teacher. THE ONLY WAY A
 * FACT EVER WIDENS.
 *
 * This is her deliberate act, by tap, so the widened fact becomes
 * `source: 'teacher'` — which is also what makes it survive the clamp in
 * `normalizeFacts` on every later reload.
 *
 * Refused, each for its own reason:
 *   - SKIPPING A RUNG (course → teacher). 「这对我带的每个班、每一年都成立」 is a much
 *     bigger claim than 「这个班就是这样」, and one tap should not assert both. She
 *     can widen twice, and the second tap is where she notices she is doing it.
 *   - NARROWING (class → course). Safe in itself, but it is a different
 *     deliberate act with a different confirmation, and a function named widen
 *     must not quietly do it.
 *   - ARCHIVED facts. Retired beliefs do not get promoted.
 *   - NODE scope, which this module does not own — node memory is generated.
 *
 * `widened_from` records where the fact ORIGINALLY sat, not the previous rung,
 * so a fact that climbed all the way to teacher scope still shows it began as
 * one course's fact.
 *
 * @param {Array<Object>} facts current facts, live and archived
 * @param {string} id the fact to promote
 * @param {string} toScope target scope
 * @param {{now?: string}} [opts]
 * @returns {{facts: Array<Object>, widened: boolean, reason: string}}
 *   `reason` is `''` on success, else `not_found` | `archived` | `already` |
 *   `illegal_step`.
 */
export function widenScope(facts, id, toScope, opts = {}) {
  const now = flatten(opts.now) || new Date().toISOString();
  const list = normalizeFacts(facts, stored(opts));

  const target = list.find((f) => f.id === id);
  if (!target) return { facts: list, widened: false, reason: 'not_found' };
  if (target.archived) return { facts: list, widened: false, reason: 'archived' };
  if (target.scope === toScope) return { facts: list, widened: false, reason: 'already' };
  // One rule covers skipping a rung, narrowing, node scope and anything above
  // teacher: the ladder simply has no such step.
  if (WIDEN_STEPS.get(target.scope) !== toScope) return { facts: list, widened: false, reason: 'illegal_step' };

  const widened = {
    ...target,
    scope: toScope,
    source: 'teacher',
    widened_from: target.widened_from ?? target.scope,
    widened_at: now,
  };
  return { facts: list.map((f) => (f === target ? widened : f)), widened: true, reason: '' };
}
