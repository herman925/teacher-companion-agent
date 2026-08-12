// plan-tsv.mjs — the 课程计划树 (course_plan) and its skeleton serialization.
//
// Three jobs, deliberately in one module (ADR-0006/0007, seam review 2026-07-29):
//   1. the plan tree itself — normalize, number, walk, flatten
//   2. the skeleton wire format sent to the model every turn
//   3. change propagation — blast radius, staleness marking and clearing
// Keeping them together means the rows and the tree can never disagree about
// what a node is, and keeps engine.mjs from growing a second tree model.
//
// WHY A SKELETON AT ALL. Today every turn ships the whole course_state
// pretty-printed. The skeleton is one short row per node — titles only, no
// bodies — so the model can see the shape of the month and address any part of
// it, while the node actually under discussion arrives in full through the
// focus band. Bodies never enter this table.
//
// WHY TSV IN AND JSON OUT (ADR-0011 §6). Rows repeat, so a header-once table
// drops the per-node keys, braces and quotes that dominate pretty JSON. The
// model NEVER writes this format back: a misaligned TSV column parses
// SUCCESSFULLY with wrong values, and one of these columns is provenance — a
// shifted column reading `hypothesis` as `confirmed` is exactly the failure
// non-negotiable #1 exists to stop, arriving with no error to catch.

/** Bump when the column set changes — the header carries it, so a stale
 * consumer fails loudly instead of reading column 5 as column 4. */
export const SKELETON_VERSION = 'v1';

/** The column set. ~8 max (ADR-0011 §6); order is the contract. */
export const SKELETON_COLUMNS = ['id', 'parent', 'kind', 'title', 'date', 'status', 'work', 'stale'];

/** Written into any cell that would otherwise be empty. Two consecutive tabs
 * are how a model silently mis-reads the next column. */
export const EMPTY = '-';

/** Node kinds, root to leaf. 月计划 is a PHASE of 2–5 weeks, not a calendar
 * month (ADR-0010 §9); a day is a DATE on an activity, never a level. */
export const PLAN_KINDS = ['phase', 'week', 'activity'];

/** Provenance — how sure we are this is true (mirrors BLUEPRINT_STATUS). */
const KNOWN_STATUS = new Set(['confirmed', 'teacher_preset', 'ai_suggestion', 'hypothesis', 'pending_validation']);

/** Work status — where this is in the teacher's process. Deliberately a
 * SEPARATE axis: merging it with provenance would let "she is mid-edit" read
 * as "not verified against children". */
const KNOWN_WORK = new Set(['draft', 'adjusting', 'needs_review', 'settled']);

/** Tabs and newlines would break the table; titles are display strings, so
 * stripping is safe here in a way it would never be for a body. */
const flatten = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();

/**
 * Normalize a raw plan tree into a safe one: guaranteed ids, known kinds,
 * known statuses, array children. Pure — input untouched.
 *
 * Kind is inferred from depth when absent, which is what makes a
 * hand-written or model-emitted tree usable without a schema round-trip.
 *
 * @param {{version?: string, roots?: Array}|null|undefined} data
 * @returns {{version: string, roots: Array}}
 */
export function normalizePlan(data) {
  const src = data && typeof data === 'object' ? data : {};
  const roots = Array.isArray(src.roots) ? src.roots : [];
  const seen = new Set();

  const norm = (node, path, depth) => {
    const n = node && typeof node === 'object' ? node : {};
    let id = flatten(n.id) || path;
    while (seen.has(id)) id = `${id}-dup`;
    seen.add(id);
    const kind = PLAN_KINDS.includes(n.kind) ? n.kind : (PLAN_KINDS[depth] ?? 'activity');
    const out = {
      id,
      kind,
      title: flatten(n.title),
      body: String(n.body ?? ''),          // kept on the node, never in the skeleton
      status: KNOWN_STATUS.has(n.status) ? n.status : 'ai_suggestion',
      work_status: KNOWN_WORK.has(n.work_status) ? n.work_status : 'draft',
      children: (Array.isArray(n.children) ? n.children : []).map((c, i) => norm(c, `${id}.${i + 1}`, depth + 1)),
    };
    // Dates live on activities. A range is legal — an activity can run over two
    // days without becoming two nodes.
    const dates = Array.isArray(n.dates) ? n.dates.map(flatten).filter(Boolean) : [];
    if (dates.length) out.dates = dates;
    // One line an ancestor contributes to a descendant's focus band. Dropped
    // here, every ancestor arrived as 「（尚无摘要）」 no matter what was written.
    if (n.summary) out.summary = flatten(n.summary);
    if (n.org_type) out.org_type = flatten(n.org_type);
    if (Array.isArray(n.blueprint_refs) && n.blueprint_refs.length) out.blueprint_refs = n.blueprint_refs.map(flatten);
    // Staleness marks that an upstream edit MAY have invalidated this node. It
    // never changes provenance (ADR-0007 §5) — only the teacher does that.
    if (n.stale_since != null && n.stale_since !== '') out.stale_since = flatten(n.stale_since);
    if (n.stale_reason) out.stale_reason = flatten(n.stale_reason);
    return out;
  };

  return {
    version: flatten(src.version) || 'v0.1',
    roots: roots.map((r, i) => norm(r, `p${i + 1}`, 0)),
  };
}

/**
 * Depth-first walk yielding `{node, parentId, depth}`. The one traversal every
 * other helper is built on, so ordering is defined in exactly one place.
 * @param {{roots?: Array}} plan a normalized plan
 */
export function* walkPlan(plan) {
  const stack = (plan?.roots ?? []).map((n) => ({ node: n, parentId: '', depth: 0 })).reverse();
  while (stack.length) {
    const cur = stack.pop();
    yield cur;
    const kids = cur.node.children ?? [];
    for (let i = kids.length - 1; i >= 0; i -= 1) {
      stack.push({ node: kids[i], parentId: cur.node.id, depth: cur.depth + 1 });
    }
  }
}

/**
 * Display numbers (1 / 1.2 / 1.2.3), computed CLIENT-SIDE. The model never
 * writes these — same discipline as the blueprint (ADR-0003 §5), so renumbering
 * can never be a model-visible change.
 * @returns {Map<string,string>} node id → display number
 */
export function numberPlan(plan) {
  const out = new Map();
  const assign = (nodes, prefix) => {
    nodes.forEach((n, i) => {
      const num = prefix ? `${prefix}.${i + 1}` : String(i + 1);
      out.set(n.id, num);
      assign(n.children ?? [], num);
    });
  };
  assign(plan?.roots ?? [], '');
  return out;
}

/** Ancestor chain for a node, root-first. This is the minimum context set a
 * node turn is seeded with (ADR-0007 §1, ADR-0010 §1a). */
export function ancestorsOf(plan, nodeId) {
  const path = [];
  const find = (nodes, trail) => {
    for (const n of nodes) {
      if (n.id === nodeId) { path.push(...trail); return true; }
      if (find(n.children ?? [], [...trail, n])) return true;
    }
    return false;
  };
  find(plan?.roots ?? [], []);
  return path;
}

/**
 * Render the skeleton the model reads. Titles only — bodies reach it through
 * the focus band, never here.
 * @param {{version?: string, roots?: Array}} plan normalized or raw
 * @returns {string} header comment + column header + one row per node
 */
export function toSkeletonTSV(plan) {
  const p = plan?.roots ? plan : normalizePlan(plan);
  const lines = [
    `# plan-skeleton ${SKELETON_VERSION} · ${p.roots.length} 根 · 标题与状态，正文不在此表`,
    SKELETON_COLUMNS.join('\t'),
  ];
  for (const { node, parentId } of walkPlan(p)) {
    lines.push([
      node.id,
      parentId || EMPTY,
      node.kind,
      node.title || EMPTY,
      (node.dates && node.dates.length) ? node.dates.join('~') : EMPTY,
      node.status,
      node.work_status,
      node.stale_since ? `stale@${node.stale_since}` : EMPTY,
    ].map((c) => flatten(c) || EMPTY).join('\t'));
  }
  return lines.join('\n');
}

/**
 * Rebuild the tree from the flat table. Exists so round-trip equality is a
 * TEST rather than an assumption — if a column ever shifts, the round trip
 * fails here instead of a provenance value quietly changing meaning in a
 * prompt.
 *
 * Unknown parents are attached at root rather than dropped: losing a node
 * silently is worse than showing it in the wrong place.
 *
 * @param {string} text output of toSkeletonTSV
 * @returns {{version: string, roots: Array}}
 */
export function parseSkeletonTSV(text) {
  const lines = String(text ?? '').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  if (!lines.length) return { version: 'v0.1', roots: [] };
  const header = lines[0].split('\t').map((h) => h.trim());
  const idx = Object.fromEntries(SKELETON_COLUMNS.map((c) => [c, header.indexOf(c)]));
  if (idx.id < 0) throw new Error('plan skeleton: header has no id column');

  const byId = new Map();
  const order = [];
  for (const line of lines.slice(1)) {
    const cells = line.split('\t');
    const cell = (name) => {
      const i = idx[name];
      const v = i >= 0 ? (cells[i] ?? '').trim() : '';
      return v === EMPTY ? '' : v;
    };
    const id = cell('id');
    if (!id) continue;
    const dates = cell('date') ? cell('date').split('~').filter(Boolean) : [];
    const stale = cell('stale');
    const node = {
      id,
      kind: PLAN_KINDS.includes(cell('kind')) ? cell('kind') : 'activity',
      title: cell('title'),
      body: '',
      status: KNOWN_STATUS.has(cell('status')) ? cell('status') : 'ai_suggestion',
      work_status: KNOWN_WORK.has(cell('work')) ? cell('work') : 'draft',
      children: [],
    };
    if (dates.length) node.dates = dates;
    if (stale.startsWith('stale@')) node.stale_since = stale.slice('stale@'.length);
    byId.set(id, { node, parentId: cell('parent') });
    order.push(id);
  }

  const roots = [];
  for (const id of order) {
    const { node, parentId } = byId.get(id);
    const parent = parentId ? byId.get(parentId) : null;
    if (parent) parent.node.children.push(node);
    else roots.push(node);
  }
  return { version: 'v0.1', roots };
}

// ---------- change propagation (ADR-0007 §5, ADR-0011 §8) ----------
//
// MARK, DO NOT RECOMPUTE. A teacher who edits 周2 has just invalidated 周3, and
// tiered context is precisely the architecture that will not notice. So the
// engine stamps a flag and the teacher decides. Regenerating descendants would
// silently overwrite work she confirmed against real children — the rejected
// alternative in ADR-0007 §5, and a direct hit on non-negotiable #1.
//
// NOTHING HERE TOUCHES PROVENANCE. Staleness says "this MAY need revisiting";
// it never says "this is less true". Only teacher confirmation or recorded
// evidence moves `status`, unchanged since ADR-0003. `needs_review` is a
// work_status for the same reason: merging the axes would let "she is mid-edit"
// read as "not verified against children".

/** The three deliberate acts that clear a 待复查 badge: 跟着改 (accept the
 * 连动调整), 我自己改, 这样就行. Opening the node is not one of them —
 * reading is not deciding (ADR-0011 §8). */
export const CLEARING_ACTS = Object.freeze(['followed', 'edited', 'accepted']);

/** Dates are compared as strings, so only this shape is comparable. A date we
 * cannot read is not a date we can call past. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Accept a raw tree the same way toSkeletonTSV does. These helpers take the
 * plan the engine already holds and change ONLY what they touch, so fields this
 * module knows nothing about — a node's revision history (ADR-0007 §5) — survive
 * a marking pass instead of being normalized away. The cost is the same as
 * toSkeletonTSV's: a rooted tree whose nodes have no ids has nothing to
 * propagate along, exactly as it has nothing to render. */
const asPlan = (plan) => (plan?.roots ? plan : normalizePlan(plan));

/**
 * Rebuild a plan with `fn` applied to every node, returning fresh objects the
 * whole way down. Every propagation helper goes through here, which is what
 * makes "input untouched" a property of the module rather than a promise each
 * function has to keep on its own. `fn` may return the node unchanged; the copy
 * happens regardless.
 */
const remap = (plan, fn) => {
  const rebuild = (node) => ({ ...(fn(node) ?? node), children: (node.children ?? []).map(rebuild) });
  const p = asPlan(plan);
  return { ...p, roots: (p.roots ?? []).map(rebuild) };
};

/** Drop the staleness stamp, leaving both status axes alone. */
const withoutStale = (node) => {
  const next = { ...node };
  delete next.stale_since;
  delete next.stale_reason;
  return next;
};

/** Latest date anywhere in a node's subtree, or '' when that is unknowable.
 * A 周计划 carries no date of its own — its activities do — so the subtree is
 * the only honest answer to "has this been taught yet". One unreadable date
 * makes the whole answer unknown rather than optimistic. */
const subtreeEnd = (node) => {
  const dates = [];
  const collect = (n) => {
    for (const d of n.dates ?? []) dates.push(d);
    for (const c of n.children ?? []) collect(c);
  };
  collect(node);
  if (!dates.length || dates.some((d) => !ISO_DATE.test(d))) return '';
  return dates.reduce((a, b) => (b > a ? b : a));
};

/**
 * Every node an edit to `nodeId` may have invalidated: its descendants, plus
 * any node whose `blueprint_refs` point into that subtree.
 *
 * The edited node itself is never in the radius — she just edited it, she knows.
 *
 * Reference hits close transitively: a node that rests on changed ground is
 * itself changed ground, so its own descendants follow. Stopping at the first
 * reference boundary would leave a referrer's activities quietly claiming to
 * still derive from something that moved.
 *
 * UNKNOWN, deliberately not guessed: `blueprint_refs` are matched by id against
 * the changed subtree's node ids. Whether a ref names a blueprint node or a plan
 * node is the caller's namespace decision and is not settled at this layer.
 *
 * @param {{version?: string, roots?: Array}} plan normalized or raw
 * @param {string} nodeId the node that was edited
 * @returns {string[]} affected node ids, in skeleton (document) order
 */
export function blastRadius(plan, nodeId) {
  const p = asPlan(plan);
  const nodes = [...walkPlan(p)].map(({ node }) => node);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (!byId.has(nodeId)) return [];

  const ground = new Set([nodeId]);   // what counts as changed
  const radius = new Set();           // what that change reaches
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of [...ground]) {
      for (const { node } of walkPlan({ roots: byId.get(id)?.children ?? [] })) {
        if (ground.has(node.id)) continue;
        ground.add(node.id);
        radius.add(node.id);
        grew = true;
      }
    }
    for (const n of nodes) {
      if (ground.has(n.id)) continue;
      if (!(n.blueprint_refs ?? []).some((ref) => ground.has(ref))) continue;
      ground.add(n.id);
      radius.add(n.id);
      grew = true;
    }
  }
  return nodes.filter((n) => radius.has(n.id)).map((n) => n.id);
}

/**
 * Stamp `stale_since` and `stale_reason` across the blast radius of an edit to
 * `nodeId`. Provenance and work status are untouched — a `confirmed` node stays
 * `confirmed` while it waits to be looked at again.
 *
 * The reason travels with the node on purpose (ADR-0007 §5): a node reopened two
 * weeks later still carries why it is flagged, instead of pointing at a chat turn
 * that fell out of the context window. A badge saying only 待复查 is a puzzle she
 * has to solve before she can judge it.
 *
 * Re-marking an already-stale node overwrites the older stamp: one badge, one
 * reason, and the newest upstream change is the one she has not seen yet.
 *
 * @param {{version?: string, roots?: Array}} plan normalized or raw
 * @param {string} nodeId the node that was edited
 * @param {{version?: string, reason?: string}} [opts] version defaults to the plan's own
 * @returns {{version: string, roots: Array}} a new plan; the input is untouched
 */
export function markStale(plan, nodeId, opts = {}) {
  const p = asPlan(plan);
  const affected = new Set(blastRadius(p, nodeId));
  const since = flatten(opts.version) || flatten(p.version) || 'v0.1';
  const reason = flatten(opts.reason);
  return remap(p, (node) => {
    if (!affected.has(node.id)) return node;
    const next = { ...node, stale_since: since };
    if (reason) next.stale_reason = reason;
    else delete next.stale_reason;   // a new cause with no recorded reason must not inherit the old one
    return next;
  });
}

/**
 * Walk upward from `nodeId` and set `work_status: 'needs_review'` on its
 * ancestors, so a 月计划 cannot keep claiming an outcome its weeks no longer
 * produce. Never a provenance change.
 *
 * The caller decides that the edit contradicts a stated goal — that judgement is
 * not available here. Given that judgement, every ancestor is marked rather than
 * a guessed one: the chain is at most two nodes deep in this tree model, so
 * over-marking upward is cheap, while an unmarked ancestor goes on asserting
 * something the plan below it stopped supporting.
 *
 * @param {{version?: string, roots?: Array}} plan normalized or raw
 * @param {string} nodeId the node that was edited
 * @returns {{version: string, roots: Array}} a new plan; the input is untouched
 */
export function markNeedsReview(plan, nodeId) {
  const p = asPlan(plan);
  const chain = new Set(ancestorsOf(p, nodeId).map((n) => n.id));
  return remap(p, (node) => (chain.has(node.id) ? { ...node, work_status: 'needs_review' } : node));
}

/**
 * Clear the 待复查 badge on one node after a deliberate act: 'followed'
 * (跟着改), 'edited' (我自己改) or 'accepted' (这样就行).
 *
 * Anything else — opening the node, reading it, an act name we do not know — is
 * a no-op rather than a throw. Refusing to clear is the recoverable direction: a
 * badge that stays can still be cleared, while a badge cleared by a distracted
 * glance leaves the system believing she decided something she did not.
 *
 * Only the named node clears. Each stale node is judged on its own, because
 * clearing a subtree from one node's decision is the same silent overwrite
 * ADR-0007 §5 refused.
 *
 * @param {{version?: string, roots?: Array}} plan normalized or raw
 * @param {string} nodeId the node she just decided about
 * @param {string} how one of CLEARING_ACTS
 * @returns {{version: string, roots: Array}} a new plan; the input is untouched
 */
export function clearStale(plan, nodeId, how) {
  const p = asPlan(plan);
  if (!CLEARING_ACTS.includes(how)) return remap(p, (node) => node);
  return remap(p, (node) => ((node.id === nodeId && node.stale_since != null) ? withoutStale(node) : node));
}

/**
 * Retire staleness on nodes whose dates have all passed. A warning about
 * teaching that already happened is noise, and badges nobody reads are worse
 * than no badges because we will believe we warned her (ADR-0011 §8).
 *
 * A node dated today is still teachable today, so it keeps its badge. A node
 * with no readable date in its subtree never retires — we do not know it has
 * passed, and inventing that is how a live warning disappears.
 *
 * `today` is a parameter because this module has no clock: a pure function that
 * read the system date would make its own tests depend on when they ran.
 *
 * @param {{version?: string, roots?: Array}} plan normalized or raw
 * @param {string} today YYYY-MM-DD; anything else retires nothing
 * @returns {{version: string, roots: Array}} a new plan; the input is untouched
 */
export function retireStale(plan, today) {
  const p = asPlan(plan);
  if (!ISO_DATE.test(String(today ?? ''))) return remap(p, (node) => node);
  return remap(p, (node) => {
    if (node.stale_since == null) return node;
    const end = subtreeEnd(node);
    return (end && end < today) ? withoutStale(node) : node;
  });
}
