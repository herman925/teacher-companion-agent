// memory-capture.mjs — the fact WRITE path (ADR-0011, ADR-0013 §9).
//
// memory-scopes.mjs is the pure curation policy and knows nothing about
// storage; the store persists and never curates. This module is the one place
// the two meet: it decides what may be filed at all, files it, and says out
// loud what it refused.
//
// IT LIVES IN ITS OWN FILE SO THE GUARDS CAN BE TESTED AGAINST A REAL STORE.
// Every rule below is a rule that can be satisfied by doing nothing, and a
// guard that is only exercised through a live vendor turn is a guard nobody
// ever proves. The store is INJECTED for the same reason — the test hands it a
// scratch JSON store, production hands it the configured tier, and neither one
// is a special case of the other.

import { screenFacts, mergeFact, capFacts, DEFAULT_FACT_CAP } from './memory-scopes.mjs';
import { extractJson } from './harness.mjs';

/**
 * At most this many facts may be accepted out of ONE turn.
 *
 * More than three constraints out of a single teacher message is not a rich
 * turn, it is an extractor writing prose into a table. The excess is refused
 * and COUNTED — silently dropping it would leave her believing something was
 * remembered when it was not, which is 「我早就跟你说过」 inverted.
 */
export const MEMORY_FACTS_PER_TURN = 3;

/**
 * The model's memory proposals, off the RAW payload.
 *
 * Read from the payload rather than the parsed turn because `parseTurn`
 * rebuilds a turn from a fixed field list, so a new optional field has to be
 * picked up here or it is dropped before anyone sees it.
 *
 * The model PROPOSES and never writes: only a model can read meaning out of a
 * sentence, and ADR-0011 §4 puts canonicalization at the extractor — but every
 * decision about what is kept, at what scope, with what provenance, is made
 * below by the server.
 * @param {unknown} payload the vendor's raw response
 * @returns {Array<{kind?: string, text?: string, quote?: string}>}
 */
export function rawMemoryFacts(payload) {
  try {
    const obj = typeof payload === 'string' ? JSON.parse(extractJson(payload)) : payload;
    const list = obj?.memory_facts;
    return Array.isArray(list) ? list.filter((f) => f && typeof f === 'object') : [];
  } catch { return []; }
}

/** Punctuation and whitespace stripped, exactly as harness.mjs and engine.mjs
 * do it. The fact-quote check, the evidence check and the citation check must
 * never disagree about what counts as the same words. */
const citationKey = (s) => String(s ?? '').replace(/[\s\p{P}\p{S}]/gu, '');

/**
 * The shortest quote that can carry a constraint, in CODE POINTS.
 *
 * WHY MEMORY HAS A FLOOR WHEN THE EVIDENCE PATH STILL DOES NOT (engine.mjs
 * records that as an open question): an evidence citation grounds one assertion
 * in one turn, and a wrong one is visible in the transcript beside it. A fact
 * rides EVERY future prompt, under a header that reads 「quote 是老师的原话」, until
 * somebody archives it by hand. Without a floor, `我们班没有鼓` and `的` are the
 * same guard: any substring of her message — a particle, a comma-stripped 了 —
 * satisfies `said.includes(quote)`, so the model could mint 「班上有几个孩子对龙舟
 * 特别有兴趣」 out of 「今天的活动挺顺利的，谢谢你」 and have it read back forever as
 * something she said. `class_composition` is by design a kind that talks about
 * children, and `CHILD_CLAIM_RE` does not match 有兴趣, so nothing else on this
 * path stops that.
 *
 * FOUR, and the direction of the trade-off is deliberate. A Chinese constraint
 * is a clause — 没有场地, 周三很短, 人太多了 — and below four characters it is a word
 * rather than a statement. A genuine three-character quote (没有鼓) is refused,
 * she is TOLD it was refused, and the extractor can quote the clause she
 * actually typed (我们班没有鼓). Refusing a real constraint costs her one repeat;
 * filing a fabricated one costs every future turn.
 */
export const MIN_QUOTE_CHARS = 4;

/**
 * How much of the quote and the fact must be literally the same words.
 *
 * The floor above stops a particle; this stops the other half of the same
 * attack — quoting a long innocuous span (「今天的活动挺顺利」) to ground a fact
 * about something else entirely. A fact and the sentence it came from share
 * words: 「班上没有鼓」 out of 「我们班没有鼓」 shares 没有鼓.
 *
 * TWO, not more, because the extractor is SUPPOSED to canonicalize (ADR-0011 §4
 * puts canonicalization at the extractor), so 星期三 → 周三 is correct behaviour
 * and must not be punished into silence. Two characters is enough to separate
 * 「rephrased the same thing」 from 「wrote about something else」, and the refusal
 * is stated rather than swallowed, so the rare false refusal is visible and
 * recoverable — she says it again.
 */
export const MIN_QUOTE_OVERLAP = 2;

/**
 * The longest run of characters two strings share, counted in code points.
 *
 * Both arguments are one short clause each (the table caps them at 60 and 40),
 * so the quadratic scan is a few thousand comparisons — no reason to be clever
 * and every reason to be obviously correct.
 * @param {string} a @param {string} b @returns {number}
 */
export function longestSharedSpan(a, b) {
  const A = Array.from(String(a ?? ''));
  const B = Array.from(String(b ?? ''));
  if (!A.length || !B.length) return 0;
  let best = 0;
  let prev = new Array(B.length + 1).fill(0);
  for (let i = 1; i <= A.length; i += 1) {
    const cur = new Array(B.length + 1).fill(0);
    for (let j = 1; j <= B.length; j += 1) {
      if (A[i - 1] === B[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

/**
 * Load one turn's memory. Returns `null` — never `[]` — when the read failed.
 *
 * NO COLUMN MAPPING HAPPENS HERE, deliberately. `listFacts` already returns
 * memory-scopes' vocabulary (`text`, `at`, `source: 'auto'|'teacher'`) in both
 * tiers, and the renames (`body` → `text`, `created_at` → `at`) live at the
 * store boundary where there is exactly one copy of them. A second mapping here
 * would be a second thing to drift.
 *
 * THE null/[] DISTINCTION IS SECURITY-RELEVANT, not an assertion aid. Under
 * row-level security a read with `app.user_id` unset returns zero rows BY
 * DESIGN, and zero rows is indistinguishable from 「this class has no
 * constraints」. If a layer caught that failure into `[]`, `memoryBandText`
 * would render both headers empty, the model would be told this class is
 * unconstrained, and it would offer 敲鼓感受节奏 to the class that has no drums
 * — the exact 「我早就跟你说过」 failure, produced by an infrastructure fault
 * instead of a missing feature. `null` omits the band, which is honest.
 *
 * @param {Object} store the persistence facade
 * @param {string} userId @param {string} courseId @param {string|null} classId
 * @returns {Promise<Array<Object>|null>}
 */
export async function loadFacts(store, userId, courseId, classId = null) {
  try {
    const rows = await store.listFacts(userId, { courseId, classId });
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    console.error('[memory] fact read FAILED — the memory band is omitted for this turn:', e?.message ?? e);
    return null;
  }
}

/**
 * File one turn's proposed facts. The write path that makes memory real.
 *
 * WHERE THE GUARDS ARE, AND WHY EACH ONE:
 *
 *   1. THE CLOSED TAXONOMY does the refusing (`screenFacts`, and the `kind`
 *      CHECK behind it in the table). A child observation has no kind to be
 *      filed under, so the bypass closes by CONSTRUCTION rather than by
 *      pattern-matching. This is the only guard here that is not a heuristic,
 *      and nothing above it pre-filters on keywords: a keyword filter that
 *      guesses wrong in the permissive direction files a child observation into
 *      memory, where it rides every future prompt forever.
 *   2. THE QUOTE MUST BE IN THIS TURN'S TEACHER MESSAGE, MUST BE LONG ENOUGH TO
 *      BE A CLAUSE, AND MUST SHARE WORDS WITH THE FACT IT GROUNDS. The fact-side
 *      analogue of engine.evidenceIsGrounded, and the strongest guard here:
 *      without it the model mints a constraint out of nothing and it rides every
 *      prompt from now on. 「in her message」 ALONE IS NOT ENOUGH and that is not
 *      a theoretical point — `的` is in almost every message, so a bare
 *      `includes` check grounds any fact whatsoever. See `MIN_QUOTE_CHARS` and
 *      `MIN_QUOTE_OVERLAP` for why the two extra floors are where they are. An
 *      empty quote is refused for the same reason as all three.
 *   3. CHILD_CLAIM_RE ARCHIVES ON ARRIVAL — kept, visible, exported, never
 *      rendered into the prompt. `normalizeFacts` stamps it; we persist the row
 *      and then archive it, so the record of what the extractor tried to
 *      remember survives. It is the SECOND belt: the ADR's own example
 *      (「孩子们对鼓声特别有反应」) does not match the pattern, which is exactly
 *      why the taxonomy has to be first.
 *   4. THE SCOPE CLAMP: no `byTeacher` on this path, ever, so an extracted fact
 *      lands at course scope no matter what the payload claims. Widening is her
 *      deliberate tap in the memory viewer, never an extraction.
 *   5. PROVENANCE IS ENGINE-SET: `source` is written as `'extracted'` here and
 *      never read off the payload. `normalizeFacts` refuses a payload's own
 *      `source: 'teacher'` too, so the two agree instead of racing.
 *
 * @param {Object} store
 * @param {{userId: string, courseId: string, classId?: string|null,
 *          teacherText: string, candidates: Array<Object>,
 *          facts: Array<Object>|null, now?: string}} args
 *   `facts` is what `loadFacts` returned — `null` means the read failed.
 * @returns {Promise<{recorded: Array, refused: Array, archived: Array, notice: string}>}
 */
export async function captureMemoryFacts(store, {
  userId, courseId, classId = null, teacherText, candidates, facts, now: nowIn,
}) {
  // `archived` is its own channel and each entry carries WHY. 「记忆满了，这条最久
  // 没用到」 and 「这句讲的是孩子已经做到的事」 are different events with different
  // answers to 「为什么它忘了这个」; one archived flag would make the console and
  // the receipt give the same wrong explanation for both.
  const out = { recorded: [], refused: [], archived: [], notice: '' };
  if (!Array.isArray(candidates) || !candidates.length) return out;

  const now = nowIn || new Date().toISOString();
  const said = citationKey(teacherText);

  // A read failure is not an empty memory. Filing against an unknown existing
  // set would append where it should merge, so nothing is filed and the
  // refusal says which one it was.
  if (facts == null) {
    for (const c of candidates) out.refused.push({ text: String(c?.text ?? ''), reason: 'memory_unavailable' });
    return out;
  }

  // Guard 1 + guard 4: the taxonomy screens, and `byTeacher` is absent.
  const { facts: screened, rejected } = screenFacts(candidates, { now });
  for (const r of rejected) out.refused.push({ text: String(r.fact?.text ?? ''), reason: r.reason });

  let live = facts.slice();
  let accepted = 0;
  for (const cand of screened) {
    // Guard 2: her words, from THIS turn, enough of them to mean something, and
    // about the thing being filed. Four checks rather than one because they
    // fail for four different reasons and she is told which — 「引不到原话」 and
    // 「引的这半句跟这条记忆对不上」 are different mistakes by the extractor and
    // only one of them is a fabrication.
    const quote = citationKey(cand.quote);
    if (!quote) {
      out.refused.push({ text: cand.text, reason: 'no_quote' });
      continue;
    }
    if (Array.from(quote).length < MIN_QUOTE_CHARS) {
      out.refused.push({ text: cand.text, reason: 'quote_too_short' });
      continue;
    }
    if (!said.includes(quote)) {
      out.refused.push({ text: cand.text, reason: 'quote_not_found' });
      continue;
    }
    if (longestSharedSpan(quote, citationKey(cand.text)) < MIN_QUOTE_OVERLAP) {
      out.refused.push({ text: cand.text, reason: 'quote_unrelated' });
      continue;
    }
    if (accepted >= MEMORY_FACTS_PER_TURN) {
      out.refused.push({ text: cand.text, reason: 'per_turn_cap' });
      continue;
    }
    accepted += 1;

    const known = new Set(live.map((f) => f.id));
    const merged = mergeFact(live, cand, { now });
    live = merged.facts;
    if (merged.action !== 'added') {
      // A restatement bumps the timestamp on the row that already says this
      // rather than appending a second one. Identified as 「a row that existed
      // before this call whose timestamp is now」 — matching on the text would
      // miss, because the merge key ignores punctuation the two phrasings may
      // not share.
      const hit = live.find((f) => known.has(f.id) && f.at === now);
      out.recorded.push({ id: hit?.id ?? null, kind: cand.kind, text: cand.text, action: 'merged' });
      if (hit?.id) await touchFacts(store, userId, [hit.id]);
      continue;
    }

    // The module minted a derived id (`f-course-…`); the STORE supplies the
    // real one and every later pointer uses that. Swapping it in here is what
    // keeps `superseded_by` — a self-referencing uuid FK on the Postgres tier
    // — pointing at a row that exists.
    const filed = live.find((f) => f.id === cand.id) ?? cand;
    let row;
    try {
      row = await store.recordFact(userId, {
        scope: filed.scope,
        course_id: courseId,
        class_id: null,
        kind: filed.kind,
        body: filed.text,
        quote: filed.quote,
        source: 'extracted',
      });
    } catch (e) {
      // A refused write is REPORTED, never swallowed: a teacher who believes
      // something was remembered when it was not is the failure this whole
      // feature exists to prevent.
      console.warn(`[memory] recordFact refused (${e?.status ?? 500}): ${e?.message ?? e}`);
      out.refused.push({ text: cand.text, reason: 'store_refused' });
      live = live.filter((f) => f !== filed);
      accepted -= 1;
      continue;
    }
    const stored = { ...filed, id: row.id };
    live = live.map((f) => (f === filed ? stored : f));

    // Guard 3: a realized child reaction is archived the moment it arrives.
    if (stored.archived) {
      const reason = stored.archive_reason || 'child_claim';
      await archiveOne(store, userId, stored.id, reason);
      out.archived.push({
        id: stored.id, kind: stored.kind, text: stored.text, reason,
        message: reason === 'child_claim'
          ? '这句话讲的是孩子已经做到的事，没有记进记忆——那要凭现场证据'
          : '这一条记下了，但没有进记忆',
      });
      continue;
    }
    out.recorded.push({ id: stored.id, kind: stored.kind, text: stored.text, action: 'added' });
  }

  // The standing ceiling, on top of the per-turn one. It archives
  // oldest-UNUSED (which is why `touchFactsUsed` is not bookkeeping for its own
  // sake) and returns teacher-facing prose — silent truncation is barred.
  const capped = capFacts(live, DEFAULT_FACT_CAP, { now });
  for (const a of capped.archived) {
    await archiveOne(store, userId, a.id, 'cap');
    out.archived.push({ id: a.id, kind: a.kind, text: a.text, reason: 'cap', message: capped.notice });
  }
  out.notice = capped.notice;
  return out;
}

/** Archive one fact, loudly on failure. Archiving is the ONLY way a fact leaves
 * the prompt — there is no delete, by design and by grant (`app_rw` holds no
 * DELETE on `facts`) — so a failure here means a row is still being sent to the
 * model and the journal has to say so. */
export async function archiveOne(store, userId, factId, reason) {
  try {
    return await store.archiveFact(userId, factId, { reason });
  } catch (e) {
    console.error(`[memory] archive FAILED for ${factId} (${reason}) — it is still riding the prompt:`, e?.message ?? e);
    return null;
  }
}

/** Stamp `used_at` on the facts that just rode a prompt. Swallowed on failure:
 * a stamp is bookkeeping and must never fail a teacher's turn. It is not
 * optional, though — `capFacts` evicts oldest-UNUSED, so without it the cap
 * archives the constraints she hits most often, which is the 「我早就跟你说过」
 * failure arriving through the eviction policy. */
export async function touchFacts(store, userId, ids) {
  if (!ids?.length) return;
  try { await store.touchFactsUsed(userId, ids); }
  catch (e) { console.warn('[memory] used_at stamp failed:', e?.message ?? e); }
}
