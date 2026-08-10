// plan-tsv.mjs — the 课程计划树 (course_plan) and its skeleton serialization.
//
// Two jobs, deliberately in one module (ADR-0006/0007, seam review 2026-07-29):
//   1. the plan tree itself — normalize, number, walk, flatten
//   2. the skeleton wire format sent to the model every turn
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
