// plan-view.mjs — the workbench's pure logic layer (Workflow v2, ADR-0010).
//
// WHY THIS MODULE EXISTS. main.js is a 3000-line wiring file and render.js is a
// DOM factory; between them sat every derivation the 工作台 needs — what the
// tree looks like, what a collapsed branch still owes the teacher, which node
// she touched last, what a turn actually wrote, which conversation she is in.
// Derivations that live inside a click handler cannot be tested and cannot be
// reused by the map view, so they live here: pure functions, no DOM, no fetch,
// no clock. Everything a caller needs to stamp with time or randomness is a
// parameter (see `mergeRecent` and `summarizeTurnReceipt`).
//
// THE TREE MODEL IS BORROWED, NEVER REBUILT. normalizePlan / walkPlan /
// numberPlan / ancestorsOf come from plan-tsv.mjs, which is the single owner of
// what a node is and what number it displays. A second tree model here would
// let the panel and the prompt skeleton disagree about the plan the teacher is
// reading — and the skeleton is what the model sees every turn.
//
// TWO AXES, NEVER MERGED (ADR-0010 §5). `status` is provenance （这一项有多确
// 定）and `work_status` is where the teacher is in her own process （这一项做到
// 哪一步）. This module counts them into two separate groups and never adds one
// to the other: merging them would let 「她正在改」 read as 「没有跟孩子核对
// 过」, which is non-negotiable #1 arriving as an arithmetic accident.
//
// RECEIPTS ARE ENGINE-DERIVED. `summarizeTurnReceipt` reads the plan before and
// after plus the revision log the engine appended. It never parses the model's
// prose, and it refuses to report a confirmation for a node that did not exist
// before the turn — a receipt claiming 「已确认 1 处」 for something she never
// saw is a fabricated record with a UI wrapper on it.

import { normalizePlan, walkPlan, numberPlan, ancestorsOf } from '../plan-tsv.mjs';

/** 最近处理 strip length (ADR-0010 §4). Eight is what fits one panel row at
 * the narrowest supported width; beyond that the strip stops being a glance. */
export const RECENT_MAX = 8;

/** The course-level conversation tag. Mirrors json-store's COURSE_SUBJECT
 * deliberately: this module runs in the browser and the store is fs-backed, so
 * importing it here would drag node:fs into the page. The two constants are one
 * contract — a message row with no subject reads as course-level on both
 * sides, which is why there is no migration (ADR-0010 §1). */
export const COURSE_SUBJECT = 'course';

/** A subject is a node id, not prose. Same cap as the store's, for the same
 * reason: anything longer did not come from a node id. */
const SUBJECT_MAX = 120;

/** Receipt part kinds, in the order they read on the line
 * （「记住了 1 条 · 已确认 2 处 · 1.2 已改」）. Order is the contract: what was
 * remembered, then what was vouched for, then what moved. */
export const RECEIPT_KINDS = Object.freeze(['memory', 'confirm', 'edit']);

/** Provenance buckets the tally reports, in panel order. Mirrors plan-tsv's
 * KNOWN_STATUS; kept as a list here because a tally needs an ORDER and a Set
 * does not have one. */
export const TALLY_STATUSES = Object.freeze(['confirmed', 'teacher_preset', 'ai_suggestion', 'hypothesis', 'pending_validation']);

/** Accept the plan the engine holds, or a raw one, exactly as plan-tsv's own
 * helpers do. Callers hand us `course_state.course_plan` straight out of a turn
 * and should not have to know whether it has been through the normalizer. */
const asPlan = (plan) => (plan?.roots ? plan : normalizePlan(plan));

/**
 * The plan's engine-owned counter as a number. `course_plan.version` is a
 * NUMBER when applyPlanDelta wrote it and a string like `v0.3` when it came
 * from a fixture or normalizePlan, so both shapes have to read the same or the
 * panel's version chip flickers between 「v0.7」 and 「v0.0」 across a reload.
 * @param {unknown} v
 * @returns {number}
 */
export function planVersionNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v);
  const m = /(\d+)\s*$/.exec(String(v ?? ''));
  return m ? Number(m[1]) : 0;
}

/** Per-branch counts of what its subtree still owes. Descendants only — a
 * node's own state is on its own row, and counting itself would make every
 * unconfirmed leaf claim one pending item of its own. */
const rollupsOf = (plan) => {
  const out = new Map();
  const visit = (node) => {
    let pending = 0;
    let stale = 0;
    for (const child of node.children ?? []) {
      const sub = visit(child);
      pending += sub.pending + (child.status === 'confirmed' ? 0 : 1);
      stale += sub.stale + (child.stale_since != null ? 1 : 0);
    }
    const own = { pending, stale };
    out.set(node.id, own);
    return own;
  };
  for (const root of plan.roots ?? []) visit(root);
  return out;
};

/**
 * The whole view model the 工作台 renders from: one row per node in document
 * order, plus the two-axis tally and the numbering.
 *
 * DERIVED EVERY TIME, never cached into state. The panel is read-only (ADR-0010
 * §3), so there is nothing here a teacher could have edited — and a stored view
 * model is a copy of the plan that can disagree with the plan.
 *
 * @param {Object|null|undefined} state course_state; `course_plan` may be absent
 * @param {{messageCounts?: Record<string, number>, folded?: Iterable<string>,
 *          openNodeId?: string|null}} [opts]
 * @returns {{version: number, versionLabel: string, hasPlan: boolean,
 *   plan: {version: string, roots: Array}, numbers: Map<string,string>,
 *   nodes: Array<Object>, byId: Map<string, Object>, tally: Object}}
 */
export function planViewModel(state, opts = {}) {
  const raw = state && typeof state === 'object' ? state.course_plan : null;
  const plan = normalizePlan(raw);
  const numbers = numberPlan(plan);
  const rollups = rollupsOf(plan);
  const folded = new Set(opts.folded ?? []);
  const counts = opts.messageCounts && typeof opts.messageCounts === 'object' ? opts.messageCounts : {};
  const openNodeId = opts.openNodeId ?? null;

  const tally = { total: 0, stale: 0, needs_review: 0, pending: 0 };
  for (const s of TALLY_STATUSES) tally[s] = 0;

  const nodes = [];
  for (const { node, parentId, depth } of walkPlan(plan)) {
    const rollup = rollups.get(node.id) ?? { pending: 0, stale: 0 };
    const messageCount = Number(counts[node.id]) > 0 ? Math.floor(Number(counts[node.id])) : 0;
    nodes.push({
      id: node.id,
      number: numbers.get(node.id) ?? '',
      kind: node.kind,
      title: node.title,
      depth,
      parentId,
      // The two axes travel as two fields all the way to the two badges. They
      // are never combined into one display value at any point in between.
      status: node.status,
      work_status: node.work_status,
      dates: node.dates ?? [],
      stale: node.stale_since != null,
      staleReason: node.stale_reason ?? '',
      hasChildren: (node.children ?? []).length > 0,
      folded: folded.has(node.id),
      open: node.id === openNodeId,
      messageCount,
      rollup,
      node,
    });
    tally.total += 1;
    if (TALLY_STATUSES.includes(node.status)) tally[node.status] += 1;
    if (node.status !== 'confirmed') tally.pending += 1;
    if (node.stale_since != null) tally.stale += 1;
    if (node.work_status === 'needs_review') tally.needs_review += 1;
  }

  const version = planVersionNumber(raw && typeof raw === 'object' ? raw.version : undefined);
  return {
    version,
    versionLabel: `v0.${version}`,
    hasPlan: plan.roots.length > 0,
    plan,
    numbers,
    nodes,
    byId: new Map(nodes.map((n) => [n.id, n])),
    tally,
  };
}

/**
 * The rows a list render should emit: everything except what sits under a
 * collapsed branch. The collapsed branch ITSELF stays — it is what carries the
 * roll-up count, so hiding it would hide the count that explains the fold.
 * @param {{nodes: Array<Object>}} model
 * @returns {Array<Object>}
 */
export function visiblePlanNodes(model) {
  const foldedIds = new Set((model?.nodes ?? []).filter((n) => n.folded && n.hasChildren).map((n) => n.id));
  if (!foldedIds.size) return (model?.nodes ?? []).slice();
  const hidden = new Set();
  const out = [];
  for (const n of model.nodes) {
    if (n.parentId && (hidden.has(n.parentId) || foldedIds.has(n.parentId))) {
      hidden.add(n.id);
      continue;
    }
    out.push(n);
  }
  return out;
}

/**
 * Fold or unfold one branch, returning a NEW sorted id list.
 *
 * Sorted because the list is also the render key's fold signature: an unsorted
 * list would produce a different key for the same visible shape and repaint the
 * panel for nothing. Shared by the list and the 导图 views, so switching views
 * keeps the shape she arranged.
 *
 * @param {Iterable<string>} folded current collapsed ids
 * @param {string} nodeId
 * @param {boolean} [next] force a state; omit to toggle
 * @returns {string[]}
 */
export function toggleFold(folded, nodeId, next) {
  const set = new Set(folded ?? []);
  const id = String(nodeId ?? '');
  if (!id) return [...set].sort();
  const want = typeof next === 'boolean' ? next : !set.has(id);
  if (want) set.add(id);
  else set.delete(id);
  return [...set].sort();
}

/** Stable string for a fold set, for render keys. */
export function foldSignature(folded) {
  return [...new Set(folded ?? [])].sort().join(',');
}

/**
 * The panel's memoization key.
 *
 * WHY IT DIGESTS THE ROWS RATHER THAN THE VERSION. The old blueprint panel
 * keyed on `courseId:version:tab`, and every panel change that did not bump the
 * version — a 待复查 badge appearing, a message count going 0 → 1, the open-node
 * highlight moving — simply did not repaint. The key therefore carries every
 * field the tree actually draws. It is O(nodes) on a tree of tens of nodes,
 * which is cheaper than one wrong frame.
 *
 * @param {{version: number, nodes: Array<Object>}} model
 * @param {{view?: string, openNodeId?: string|null, extra?: string}} [opts]
 * @returns {string}
 */
export function planRenderKey(model, opts = {}) {
  const rows = (model?.nodes ?? []).map((n) => [
    n.id, n.number, n.status, n.work_status, n.stale ? 's' : '-',
    n.folded ? 'f' : '-', n.open ? 'o' : '-', n.messageCount, n.rollup?.pending ?? 0,
    (n.dates ?? []).join('~'), n.title,
  ].join('|'));
  return [
    `v${model?.version ?? 0}`,
    opts.view ?? 'list',
    opts.openNodeId ?? '',
    opts.extra ?? '',
    rows.length,
    rows.join(';'),
  ].join('#');
}

/**
 * Per-subject message counts for the badge (ADR-0010 §8).
 *
 * Counts EVERY row including course-level ones, keyed by normalized subject, so
 * the caller can also read `counts[COURSE_SUBJECT]`. A node with no messages is
 * simply absent from the map — the badge is hidden at zero, and an explicit
 * zero would tempt a renderer into drawing it.
 *
 * @param {Array<{subject?: string}>|null|undefined} messages
 * @returns {Record<string, number>}
 */
export function messageCountsBySubject(messages) {
  const out = {};
  for (const m of Array.isArray(messages) ? messages : []) {
    const subject = normalizeSubject(m?.subject);
    out[subject] = (out[subject] ?? 0) + 1;
  }
  return out;
}

/**
 * 最近处理: the nodes the plan's own revision log says were touched last,
 * newest first.
 *
 * NO CLOCK, DELIBERATELY. The revision log records a version, not a time, and
 * this module has no clock — so entries carry `v` and the caller stamps `at`
 * when it merges them. Inventing a timestamp here would put a fabricated time
 * into an exported record, which is the same class of defect as a fabricated
 * observation, just quieter.
 *
 * Nodes that no longer exist are dropped: a chip that opens nothing is worse
 * than a shorter strip.
 *
 * @param {{version?: string|number, roots?: Array, revision_log?: Array}} plan
 * @param {{limit?: number}} [opts]
 * @returns {Array<{id: string, number: string, title: string, v: number}>}
 */
export function recentNodes(plan, opts = {}) {
  const p = asPlan(plan);
  const numbers = numberPlan(p);
  const alive = new Map([...walkPlan(p)].map(({ node }) => [node.id, node]));
  const log = Array.isArray(plan?.revision_log) ? plan.revision_log : [];
  const limit = Number.isFinite(Number(opts.limit)) ? Math.max(0, Math.floor(Number(opts.limit))) : RECENT_MAX;

  const out = [];
  const seen = new Set();
  for (let i = log.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const entry = log[i];
    const id = String(entry?.node_id ?? '');
    if (!id || seen.has(id) || !alive.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      number: numbers.get(id) ?? '',
      title: alive.get(id).title,
      v: planVersionNumber(entry?.v),
    });
  }
  return out;
}

/**
 * Put one entry at the front of the 最近处理 strip: dedupe by id, cap, keep
 * newest first. This is the other half of `recentNodes` — the strip is fed both
 * by plan edits (the log) and by the teacher opening a node (no log entry, and
 * rightly so: reading is not editing).
 *
 * @param {Array<{id: string}>|null|undefined} entries
 * @param {{id: string}} entry the caller stamps `at` before handing it over
 * @param {{limit?: number}} [opts]
 * @returns {Array<Object>} a new array; the input is untouched
 */
export function mergeRecent(entries, entry, opts = {}) {
  const limit = Number.isFinite(Number(opts.limit)) ? Math.max(0, Math.floor(Number(opts.limit))) : RECENT_MAX;
  const list = Array.isArray(entries) ? entries : [];
  const id = String(entry?.id ?? '');
  if (!id) return list.slice(0, limit);
  return [entry, ...list.filter((e) => String(e?.id ?? '') !== id)].slice(0, limit);
}

// ---------- receipts (ADR-0010 §7) ----------
//
// One compact line per turn saying what was WRITTEN, not what was said. Built
// from the engine's own record — the plan before, the plan after, and the
// revision-log entries applyPlanDelta appended — so an op the engine stripped
// leaves no trace here, and a model that narrates a change it never made gets
// no line at all.

const labelFor = (kind, ids, numbers) => {
  if (kind === 'memory') return `记住了 ${ids.length} 条`;
  if (kind === 'confirm') return `已确认 ${ids.length} 处`;
  const only = ids.length === 1 ? numbers.get(ids[0]) : '';
  return only ? `${only} 已改` : `${ids.length} 处已改`;
};

/**
 * The receipt for one turn, or `null` when the turn wrote nothing.
 *
 * NULL IS THE IMPORTANT HALF. A turn that only talked must produce no receipt:
 * a line reading 「已确认 0 处」 trains the teacher to ignore the line, and a
 * line invented for a turn that wrote nothing tells her the agent recorded
 * something it did not.
 *
 * A CONFIRMATION IS ONLY COUNTED FOR A NODE THAT ALREADY EXISTED. The engine
 * refuses to let a node be born `confirmed` (applyPlanDelta rule 2); if one
 * appears anyway, the honest receipt is silence rather than 「已确认 1 处」 for
 * a node she never saw.
 *
 * @param {Object|null|undefined} before course_state before the turn
 * @param {Object|null|undefined} after course_state after the turn
 * @param {{factsBefore?: Array<{id?: string}>, factsAfter?: Array<{id?: string}>,
 *          id?: string, at?: string, turnIndex?: number}} [opts]
 *   memory facts are passed in rather than read off state because memory lives
 *   in its own store (ADR-0011 §2), not in course_state
 * @returns {{id: string, at: string, turn_index: number|null,
 *   parts: Array<{kind: string, count: number, label: string, node_ids: string[]}>,
 *   undoable: boolean, undone: boolean}|null}
 */
export function summarizeTurnReceipt(before, after, opts = {}) {
  const planBefore = normalizePlan(before?.course_plan);
  const planAfter = normalizePlan(after?.course_plan);
  const numbers = numberPlan(planAfter);

  const statusBefore = new Map([...walkPlan(planBefore)].map(({ node }) => [node.id, node.status]));
  const confirmed = [];
  for (const { node } of walkPlan(planAfter)) {
    if (node.status !== 'confirmed') continue;
    if (!statusBefore.has(node.id)) continue;          // born confirmed — never reported
    if (statusBefore.get(node.id) === 'confirmed') continue;
    confirmed.push(node.id);
  }

  // The revision log is the engine's record of what APPLIED. Ops it stripped
  // never reach it, which is exactly why the receipt reads it instead of the
  // delta the model proposed.
  const logBefore = Array.isArray(before?.course_plan?.revision_log) ? before.course_plan.revision_log : [];
  const logAfter = Array.isArray(after?.course_plan?.revision_log) ? after.course_plan.revision_log : [];
  const edited = [];
  const seenEdit = new Set();
  for (const entry of logAfter.slice(logBefore.length)) {
    const id = String(entry?.node_id ?? '');
    if (!id || seenEdit.has(id)) continue;
    seenEdit.add(id);
    edited.push(id);
  }

  const factIdsBefore = new Set((opts.factsBefore ?? []).map((f) => f?.id).filter(Boolean));
  const remembered = (opts.factsAfter ?? [])
    .map((f) => f?.id)
    .filter((id) => id && !factIdsBefore.has(id));

  const parts = [];
  const push = (kind, ids) => {
    if (!ids.length) return;
    parts.push({ kind, count: ids.length, label: labelFor(kind, ids, numbers), node_ids: kind === 'memory' ? [] : ids });
  };
  push('memory', remembered);
  push('confirm', confirmed);
  push('edit', edited);
  if (!parts.length) return null;

  return {
    id: String(opts.id ?? ''),
    at: String(opts.at ?? ''),
    turn_index: Number.isFinite(Number(opts.turnIndex)) ? Math.floor(Number(opts.turnIndex)) : null,
    parts,
    // Structurally undoable: the caller snapshots course_state before the turn,
    // so restoring is always possible. Whether it SHOULD be offered (a receipt
    // replayed from an export, say) is the caller's call.
    undoable: true,
    undone: false,
  };
}

/**
 * The receipt as one line: 「记住了 1 条 · 已确认 2 处 · 1.2 已改」.
 * Composed from `parts` only — never from the model's prose.
 * @param {{parts?: Array<{label?: string}>}|null|undefined} receipt
 * @returns {string}
 */
export function receiptLine(receipt) {
  return (receipt?.parts ?? []).map((p) => p?.label).filter(Boolean).join(' · ');
}

// ---------- subjects (ADR-0010 §1, §2) ----------
//
// THE KNOWN GAP THIS CLOSES. One subject-tagged message log per course; a node
// conversation is a FILTERED VIEW of it, never a second thread. The store has
// carried the `subject` column since ADR-0010 landed, and prompt-builder already
// renders a focus band from it — but no client ever sent one, so every row was
// course-level and the whole node mode read as broken while every unit test
// passed. These four functions are what main.js calls to send it.
//
// THE SUBJECT IS ENGINE-OWNED. It comes from a UI selection — she opened a node,
// she cleared the chip — and never from model output. A `subject` the model put
// in its turn rides along as record and is never read.

/**
 * Coerce anything into a legal subject. Mirrors json-store's `normalizeSubject`
 * exactly (see COURSE_SUBJECT above for why it is mirrored and not imported):
 * whitespace collapsed, trimmed, capped, and anything empty reads as
 * course-level — which is what makes rows written before subjects existed read
 * correctly with no migration.
 * @param {unknown} subject
 * @returns {string}
 */
export function normalizeSubject(subject) {
  if (typeof subject !== 'string') return COURSE_SUBJECT;
  return subject.replace(/\s+/g, ' ').trim().slice(0, SUBJECT_MAX) || COURSE_SUBJECT;
}

/** @param {unknown} subject @returns {boolean} true when it names a node. */
export function isNodeSubject(subject) {
  return normalizeSubject(subject) !== COURSE_SUBJECT;
}

/**
 * The subject to actually send: a node id only when that node is still in the
 * plan, otherwise course-level.
 *
 * A SUBJECT POINTING AT A DELETED NODE FALLS BACK RATHER THAN STICKING. The
 * selection is persisted so a reload returns her to the node she was reading,
 * and the plan can change under it. A stale node id would filter the transcript
 * to nothing and tag her next message onto a node that no longer exists — an
 * empty screen with no explanation, and a message filed where nobody will look.
 *
 * @param {unknown} raw the stored or requested subject
 * @param {{roots?: Array}|null|undefined} plan course_plan, normalized or raw
 * @returns {string} a node id, or COURSE_SUBJECT
 */
export function resolveSubject(raw, plan) {
  const want = normalizeSubject(raw);
  if (want === COURSE_SUBJECT) return COURSE_SUBJECT;
  for (const { node } of walkPlan(asPlan(plan))) {
    if (node.id === want) return want;
  }
  return COURSE_SUBJECT;
}

/**
 * The transcript for one subject.
 *
 * ASYMMETRIC ON PURPOSE. A node subject filters to that node's messages; the
 * course subject returns the WHOLE log, because 返回整门课的对话 replays the
 * unfiltered conversation (dom_contract, `#node-view-close`). The course view is
 * the log, and node views are windows onto it — filtering the course view down
 * to rows literally tagged `course` would hide everything she said inside a node
 * from the one place that is supposed to show the whole course.
 *
 * @param {Array<{subject?: string}>|null|undefined} entries
 * @param {unknown} subject
 * @returns {Array<Object>} a new array; the input is untouched
 */
export function filterBySubject(entries, subject) {
  const list = Array.isArray(entries) ? entries : [];
  const want = normalizeSubject(subject);
  if (want === COURSE_SUBJECT) return list.slice();
  return list.filter((e) => normalizeSubject(e?.subject) === want);
}

/**
 * Everything the left-panel node view needs about one node, derived from the
 * plan alone: its number, its ancestor chain (root first) and the node itself.
 *
 * `null` for an unknown node rather than an empty shell — the caller must be
 * able to tell 「这个节点没了」 from 「这个节点是空的」, and a shell renders as
 * a node with no title, which reads as data loss.
 *
 * @param {{roots?: Array}|null|undefined} plan course_plan, normalized or raw
 * @param {string} nodeId
 * @returns {{node: Object, number: string,
 *   ancestors: Array<{id: string, number: string, title: string}>}|null}
 */
export function nodeContext(plan, nodeId) {
  const p = asPlan(plan);
  const hit = [...walkPlan(p)].find(({ node }) => node.id === nodeId);
  if (!hit) return null;
  const numbers = numberPlan(p);
  return {
    node: hit.node,
    number: numbers.get(nodeId) ?? '',
    ancestors: ancestorsOf(p, nodeId).map((n) => ({
      id: n.id,
      number: numbers.get(n.id) ?? '',
      title: n.title,
    })),
  };
}

// ------------------------------------------------------------- step zero
//
// The intake checklist the 工作台 shows before a plan exists. It is DERIVED
// from course_state on every render and stored nowhere: a cached 「已知」 can
// claim the agent understood something it no longer has evidence for, which is
// non-negotiable #1 wearing a UI costume.
//
// The grounding test matters as much as the freshness. `teacher_resource_intent`
// carries `confidence(teacher_stated|agent_proposed_pending)` for exactly this
// reason (contract.zh.md), so the two rows that come from it count as 已知 only
// when the teacher said it. A proposal the agent floated and she never answered
// is 待聊, not 已知 — and `goals_assessment_axis.core_understanding` is the
// model's derived pedagogical core, never her stated 教育期待, so it is not a
// fallback for anything here.

/** The intake checklist rows. PROVISIONAL: the canonical six-item list is 锋's
 * to supply (WORKFLOW.zh-CN.md §4, open question 2).
 * @type {ReadonlyArray<{key: string, label: string}>} */
export const STEP_ZERO_ITEMS = Object.freeze([
  { key: 'age_group', label: '班级年龄段' },
  { key: 'prior_experience', label: '儿童已有经验' },
  { key: 'why_this_theme', label: '开展这个主题的原因' },
  { key: 'duration', label: '周期' },
  { key: 'resources', label: '身边的资源条件' },
  { key: 'expectation', label: '教育期待' },
]);

/**
 * What the agent actually has, item by item, from course_state alone.
 * @param {Object|null|undefined} state course_state
 * @returns {{items: Array<{key: string, label: string, known: boolean, value: string}>}}
 */
export function stepZeroStatus(state) {
  const s = state ?? {};
  const cp = s.class_profile ?? {};
  const tr = s.theme_resource ?? {};
  const intent = s.teacher_resource_intent ?? {};
  const scenes = Array.isArray(tr.available_scenes) ? tr.available_scenes.filter(Boolean) : [];
  // Anything sourced from teacher_resource_intent needs her own word behind it.
  // A missing `confidence` is treated as NOT hers: the honest default when the
  // model omitted the field is 待聊, not a checklist row claiming she spoke.
  const teacherStated = intent.confidence === 'teacher_stated';
  const values = {
    age_group: cp.age_band,
    prior_experience: cp.experience_base,
    why_this_theme: teacherStated ? intent.why_this_resource : '',
    duration: tr.expected_duration,
    resources: [tr.name, scenes.join('、')].filter(Boolean).join(' · '),
    expectation: teacherStated ? intent.hoped_feeling : '',
  };
  return {
    items: STEP_ZERO_ITEMS.map((item) => {
      const value = String(values[item.key] ?? '').trim();
      return { key: item.key, label: item.label, known: Boolean(value), value };
    }),
  };
}
