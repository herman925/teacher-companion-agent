// Deterministic course_state engine: the LLM proposes deltas, this module disposes.
// Transition gates encode spec §2 流转规则 (source-docs/workflow-v1.3.zh-CN.md).
// Runs in both the demo server (validation) and the browser (localStorage store).

import { NODE_PREREQS, WF_NODES } from './wf-nodes.mjs';
import { normalizeBlueprint } from './blueprint-util.mjs';
import { markStale, normalizePlan, walkPlan } from './plan-tsv.mjs';

const SCHEMA_VERSION = '0.1.0';

/** Stage names for logs/debug drawer. */
export const STAGE_NAMES = {
  0: '阶段0 启动与建档',
  1: '阶段1 聚焦问题，补齐经验',
  2: '阶段2 目标与评估轴心',
  3: '阶段3 开启脑洞，协作行动',
  4: '阶段4 成果展示，迭代进化',
  5: '阶段5 课程故事导出',
};

/** @returns {Object} a fresh course_state */
export function createInitialState(courseId) {
  return {
    course_id: courseId,
    schema_version: SCHEMA_VERSION,
    stage: 0,
    completed_nodes: [],
    engine_lit_nodes: [], // deterministic lights (blueprint absorption) — never model-writable
    awaiting_feedback: false,
    pending_confirmations: [],
    teacher_mode: 'from_zero',
    children_evidence: [],
    child_question_pool: [],
    cycle_history: [],
    project_signals: [],
    child_participation_difference: [],
    teacher_focus_feedback: [],
  };
}

/** Punctuation and spacing carry no meaning for 「did she actually say this」,
 * and teachers type both widths while models normalize quotes silently. Both
 * are stripped before any citation comparison — here, in `citedNodeOf` and in
 * `evidenceIsGrounded` — so the three checks can never disagree about what
 * counts as the same words. Nothing else is normalized: this is a quotation
 * check, not paraphrase detection. */
const citationKey = (s) => String(s ?? '').replace(/[\s\p{P}\p{S}]/gu, '');

/** Whitespace is not evidence: she typed 「就这样，确认」 and the model may echo
 * it with different spacing. UNKNOWN, deliberately not guessed: no minimum
 * quote length is settled, so a one-character quote still passes the check. */
const squashQuote = (s) => String(s ?? '').replace(/\s+/g, '');

/**
 * The ONE node id an op is entitled to escalate to `confirmed`, or null.
 *
 * Shared by both delta appliers, because a rule that lived in only one of them
 * would make the other channel the way around it (ADR-0010 §6). One quote
 * confirms the one node its op addresses — it never travels to nested nodes
 * riding along in the same op.
 *
 * With no `teacherText` supplied the caller has given us nothing to check
 * against and a present quote is trusted. Every production caller now threads
 * her message (serve.mjs, ui/local-turn.mjs), so this branch is for direct
 * callers and fixtures; an EMPTY string is still a real message and is checked,
 * which is why callers coerce rather than omit.
 * @param {{id?: string, confirmed_by_quote?: unknown}} op
 * @param {{teacherText?: string}} ctx
 * @returns {string|null}
 */
function citedNodeOf(op, ctx = {}) {
  const quote = typeof op?.confirmed_by_quote === 'string' ? squashQuote(op.confirmed_by_quote) : '';
  if (!quote) return null;
  if (typeof ctx.teacherText !== 'string') return op.id;
  if (squashQuote(ctx.teacherText).includes(quote)) return op.id;
  // Punctuation is the model's to normalize, not hers: 「就这样定了」 quoted back
  // as 「就这样定了。」 is the same confirmation.
  return citationKey(ctx.teacherText).includes(citationKey(op.confirmed_by_quote)) ? op.id : null;
}

/**
 * Did this evidence entry come out of the teacher's own message?
 *
 * Non-negotiable #1 says the agent never asserts what children did without a
 * record. `children_evidence` IS that record, and it is model-writable — so
 * without this check the model writes its own permission slip: one turn minting
 * an entry, citing it, and opening the stage gates it just satisfied.
 *
 * Grounded means one of:
 *   - the entry's `quote` (preferred) or `content` occurs in her message, after
 *     the same punctuation/whitespace stripping every citation check here uses;
 *   - `source: 'demo_sample'` AND `ctx.mock === true` — the scripted 演示模式
 *     walkthrough's own channel, which is marked as never-observed in every
 *     export it reaches (mock.mjs);
 *   - `upload_ref` that `ctx.resolveUploadRef` confirms points at a material
 *     row belonging to THIS teacher and THIS course.
 *
 * TWO EXEMPTIONS THAT USED TO BE FREE, AND WHY THEY ARE NOT ANY MORE:
 *
 *   `demo_sample` is a published enum value in
 *   harness/schema/course-state.schema.json, so a real vendor turn can emit it.
 *   Trusting the string meant one turn writing its own permission slip: the row
 *   passed L3, entered the ledger unmarked, counted toward `countedEvidence`
 *   and opened the stage-2 and stage-5 gates. The exemption now depends on
 *   something the model cannot write — `ctx.mock`, set ONLY where mockTurn()
 *   produced the payload (serve.mjs, ui/local-turn.mjs).
 *
 *   `upload_ref` grounded on any truthy value, validating nothing. That was
 *   honest when there was no upload pipeline; `materials` now exists with owner
 *   scoping in both store tiers and RLS policies (003_rls.sql), so
 *   `{content: '孩子们发现龙舟要一起用力', upload_ref: 'x'}` counting as a record
 *   is a fabrication channel with a one-character key. The field only grounds
 *   when a caller passes a resolver that has already looked the reference up;
 *   with no resolver it grounds nothing and the row is stamped
 *   `pending_validation`.
 *
 * Both defaults are the closed direction: a caller that supplies neither piece
 * of context gets the strict answer, not the permissive one.
 *
 * @param {Object} entry one `children_evidence` row
 * @param {string} teacherText this turn's teacher message
 * @param {{mock?: boolean, resolveUploadRef?: (ref: string) => boolean}} [ctx]
 *   `mock` — this payload came out of mockTurn(), not a vendor.
 *   `resolveUploadRef` — SYNCHRONOUS predicate: does this ref name a material
 *   row owned by this teacher on this course? Async lookups belong at the
 *   caller, which is why this takes an answer rather than a promise (applyDelta
 *   and validateTurn are pure and synchronous, and must stay that way).
 * @returns {boolean}
 */
export function evidenceIsGrounded(entry, teacherText, ctx = {}) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.source === 'demo_sample') return ctx.mock === true;
  if (entry.upload_ref) {
    return typeof ctx.resolveUploadRef === 'function'
      && ctx.resolveUploadRef(String(entry.upload_ref)) === true;
  }
  const said = citationKey(teacherText);
  if (!said) return false;
  const cited = citationKey(entry.quote) || citationKey(entry.content);
  return Boolean(cited) && said.includes(cited);
}

/** Evidence rows that count toward a stage gate: everything except rows the
 * engine could not trace back to the teacher and therefore marked 待核实. */
const countedEvidence = (state) => (state?.children_evidence || []).filter((e) => e && e.pending_validation !== true);

/**
 * Stage-gate table (ARCHITECTURE.md §4). Returns null when legal, else a
 * human-readable refusal reason (zh-CN, surfaced in the debug drawer).
 */
export function stageGateError(state, toStage) {
  const from = state.stage;
  if (toStage === from) return null;
  if (toStage < from) return null; // going back is always allowed
  if (toStage - from > 1 && toStage !== 5) {
    return `不允许从${STAGE_NAMES[from]}直接跳到${STAGE_NAMES[toStage]}`;
  }
  // ADR-0012 §2 (corrected): this gate bundled three jobs. The ordinal check
  // above and the EVIDENCE branches below are retained — the evidence ones are
  // non-negotiable #1 expressed as a gate, and ADR-0008 §3 kept the model-side
  // gate while unforcing 回传 for the teacher. What lapsed with the workflow
  // chain are the V1.3 ARTIFACT prerequisites: stage 1 demanded a
  // 资源课程化切口卡 + 主题适配性筛查, stage 3 a goals axis, stage 4 a cycle
  // record. Workflow v2 produces a plan tree instead, so those gates would
  // block stage 1 permanently.
  switch (toStage) {
    case 1:
      return null; // artifact prerequisites retired with the chain
    case 2:
      // stage1-workflow-v1.0: evidence stays mandatory (non-negotiable 1), but
      // a driving question is NO LONGER a stage-1 exit requirement — it gets
      // derived at the stage-2 boundary from the question pool, not forced.
      // Only evidence traced back to her counts (`evidenceIsGrounded`): a row
      // the model minted this turn is not a reason to open the next stage.
      if (!countedEvidence(state).length) return '没有儿童证据（原话/作品/照片/观察）不能进入目标轴心——先补一轮真实体验';
      return null;
    case 3:
      return null; // goals-axis prerequisite retired with the chain
    case 4:
      return null; // cycle-record prerequisite retired with the chain
    case 5:
      if (!countedEvidence(state).length) return '没有任何过程证据，无法导出课程故事——先列缺口，不虚构';
      return null;
    default:
      return `未知阶段 ${toStage}`;
  }
}

// Fields the model may write via state_delta. Platform-controlled fields are absent.
const WRITABLE = new Set([
  'teacher_mode', 'class_profile', 'theme_resource', 'teacher_resource_intent',
  'resource_entry_card', 'theme_fit_level', 'children_evidence', 'child_question_pool',
  'driving_question', 'goals_assessment_axis', 'cycle_history', 'child_learning_stage',
  'project_signal_level', 'project_signals', 'story_materials',
  'child_participation_difference', 'teacher_focus_feedback', 'pending_confirmations',
  'completed_nodes', 'stage', // stage is a *proposal*; gated below
]);

let NODE_NAME_CACHE = null;
/** Lazy id→name lookup (lazy keeps the wf-nodes ↔ engine module cycle safe). */
function nodeName(id) {
  if (!NODE_NAME_CACHE) NODE_NAME_CACHE = Object.fromEntries(WF_NODES.map((n) => [n.id, n.name]));
  return NODE_NAME_CACHE[id] ?? id;
}

// Array fields that append (with dedupe key) instead of replacing.
const APPEND_KEYS = {
  children_evidence: (e) => e.id,
  cycle_history: (e) => `${e.round}:${e.phase}`,
  project_signals: (e) => e.signal,
  child_participation_difference: (e) => `${e.round}:${e.profile}`,
  teacher_focus_feedback: (e) => e.round,
  pending_confirmations: (e) => e.path,
  completed_nodes: (e) => e,
};

/**
 * Apply a model-proposed delta. Pure: returns { state, violations, applied }.
 * Illegal stage jumps are stripped (logged), not fatal; unknown fields are dropped.
 * @param {Object} state  current course_state
 * @param {Object} delta  model's state_delta
 * @param {{ roundComplete?: boolean, teacherTurn?: boolean, teacherText?: string,
 *          mock?: boolean, resolveUploadRef?: (ref: string) => boolean }} ctx
 *   `teacherText` is this turn's teacher message. Supplied, every incoming
 *   `children_evidence` row must trace back to it (`evidenceIsGrounded`) or it
 *   is kept but stamped `pending_validation` and stops counting toward the
 *   stage gates. Omitted, the check is dormant — fixtures and direct callers
 *   keep their old behaviour byte for byte.
 *   `mock` and `resolveUploadRef` ride through to `evidenceIsGrounded`; see
 *   there for why neither may be read off the model's own row.
 */
export function applyDelta(state, delta, ctx = {}) {
  const violations = [];
  const next = structuredClone(state);
  const applied = [];
  let stageProposal = null; // deferred — gated against the fully merged candidate below

  for (const [key, value] of Object.entries(delta || {})) {
    if (!WRITABLE.has(key)) {
      violations.push({ kind: 'bad_delta', detail: `字段 ${key} 不在模型可写白名单内，已丢弃`, action: 'strip' });
      continue;
    }
    if (key === 'stage') {
      stageProposal = value;
      continue;
    }
    if (key in APPEND_KEYS && Array.isArray(value)) {
      const keyFn = APPEND_KEYS[key];
      // Node dependency check (NODE_PREREQS partial order), delta-aware: a
      // prerequisite counts if already in state OR anywhere in this same
      // delta's array (set semantics). Unmet → strip that id, non-fatal.
      let incoming = value;
      // The ledger is the product's spine, so a row that entered it without
      // passing through her keyboard is the failure non-negotiable #1 names.
      // The row is KEPT — dropping it would lose teacher content on a false
      // negative — but marked, and a marked row buys no stage advance.
      if (key === 'children_evidence' && typeof ctx.teacherText === 'string') {
        incoming = value.map((e) => {
          if (evidenceIsGrounded(e, ctx.teacherText, ctx)) return e;
          violations.push({
            kind: 'fabrication',
            detail: `证据 ${e?.id ?? '(无 id)'} 在教师本轮的话里找不到出处，已标为 pending_validation：它不算数，也不能凭它推进阶段`,
            action: 'strip',
          });
          return { ...e, pending_validation: true };
        });
      }
      if (key === 'completed_nodes') {
        const provided = new Set([...(Array.isArray(next.completed_nodes) ? next.completed_nodes : []), ...value]);
        incoming = value.filter((id) => {
          const missing = (NODE_PREREQS[id] || []).filter((pre) => !provided.has(pre));
          if (!missing.length) return true;
          violations.push({
            kind: 'node_prerequisite',
            detail: `${id} 需要先完成 ${missing[0]}（${nodeName(missing[0])}）`,
            action: 'strip',
          });
          return false;
        });
      }
      const existing = Array.isArray(next[key]) ? next[key] : [];
      const seen = new Set(existing.map(keyFn));
      for (const item of incoming) {
        const k = keyFn(item);
        if (seen.has(k)) {
          // Same key = update in place (teacher corrections legitimately revise entries).
          const idx = existing.findIndex((e) => keyFn(e) === k);
          existing[idx] = item;
        } else {
          existing.push(item);
          seen.add(k);
        }
      }
      next[key] = existing;
      applied.push(key);
      continue;
    }
    next[key] = value; // object/scalar fields replace
    applied.push(key);
  }

  // Stage is a gated PROPOSAL, checked delta-aware against the merged
  // candidate state: a delta that supplies the prerequisites AND the stage
  // move in the same turn is legal regardless of key order (mirrors the
  // harness rule that evidence_refs may resolve against evidence newly
  // provided in this delta).
  if (stageProposal !== null) {
    const err = stageGateError(next, stageProposal);
    if (err) {
      violations.push({ kind: 'illegal_stage_jump', detail: err, action: 'strip' });
    } else {
      next.stage = stageProposal;
      applied.push('stage');
    }
  }

  // Platform-controlled pacing: a completed round waits for the classroom —
  // but only once real child evidence exists (实施/陪跑期). During 备课 the
  // closure loop points at the plan itself, so there is no 回传 to await
  // (stage1 rules; HANDOFF [19]). A new teacher message re-opens the
  // conversation either way. Evidence delivered in this same delta counts:
  // a 回传-ingest turn that also closes the round starts the wait.
  if (ctx.teacherTurn) next.awaiting_feedback = false;
  if (ctx.roundComplete && (next.children_evidence || []).length) next.awaiting_feedback = true;

  return { state: next, violations, applied };
}

/**
 * Teacher confirmation of one blueprint node — the CLEAN escalation channel
 * (✓确认 click in the workspace panel). UI/engine event, never model output:
 * this is the only way a node becomes confirmed outside a teacher-reply turn.
 * Pure; bumps the version and logs a 'confirm' revision. No-op on unknown ids
 * and on already-confirmed nodes.
 */
export function confirmBlueprintNode(state, nodeId) {
  const bp = state?.course_plan_blueprint;
  if (!bp) return { state, confirmed: false };
  const next = structuredClone(state);
  const nbp = next.course_plan_blueprint;
  let hit = null;
  let rootId = null;
  const walk = (n, root) => {
    if (hit) return;
    if (n.id === nodeId) { hit = n; rootId = root; return; }
    for (const c of n.children || []) walk(c, root);
  };
  for (const m of nbp.modules || []) walk(m, m.id);
  if (!hit || hit.status === 'confirmed') return { state, confirmed: false };
  hit.status = 'confirmed';
  nbp.version = (nbp.version || 0) + 1;
  nbp.revision_log = nbp.revision_log || [];
  nbp.revision_log.push({ v: nbp.version, module_id: rootId, op: 'confirm', node_id: nodeId });
  return { state: next, confirmed: true };
}

/** Every id in one blueprint subtree, the node itself first. The plan tree's
 * equivalent rents `walkPlan`; the blueprint has no normalizer to rent, so the
 * three-line walk lives here rather than pulling the plan's tree model in. */
function blueprintSubtreeIds(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  out.push(node.id);
  for (const c of Array.isArray(node.children) ? node.children : []) blueprintSubtreeIds(c, out);
  return out;
}

/**
 * Node-granularity blueprint delta (ADR-0003 Phase 3): small edits without
 * re-emitting whole modules. Ops: update (replace an existing node's fields,
 * children preserved unless provided), remove (delete a non-module node),
 * set (insert under parent_id, or as a new module without one). Pure.
 *
 * THE SAME FOUR RULES AS applyPlanDelta, and for the same reason: this channel
 * predates `plan_delta` and carries node status exactly the same way, so a
 * guarantee that lived only in the newer applier would make this one the way
 * around it (ADR-0010 §6).
 *
 * 1. No node is ever BORN `confirmed` — a first appearance degrades to
 *    `ai_suggestion`, quote or no quote: a quote proves she said something, not
 *    that she saw this.
 * 2. Escalating an EXISTING node needs her own words on the op
 *    (`confirmed_by_quote`, checked against `ctx.teacherText`). A teacher-
 *    INITIATED turn is not a teacher confirmation, which is why the old
 *    `ctx.teacherTurn` escape hatch is gone: it was true on every single turn.
 * 3. A `set` whose id already exists anywhere in the blueprint is refused
 *    rather than appended — a second node under the same id is how a
 *    fabricated `confirmed` node walked in past a pre-delta snapshot.
 * 4. Rewriting the BODY of a confirmed node demotes it to `pending_validation`:
 *    her confirmation covered the text she read, not its replacement.
 *
 * @param {Object} state
 * @param {Array<{op:'set'|'update'|'remove', id:string, parent_id?:string, node?:Object, confirmed_by_quote?:string}>} delta
 * @param {{teacherText?: string}} [ctx] when `teacherText` is supplied, a quote
 *   must actually occur in it — a citation nobody can check is decoration
 * @returns {{state: Object, violations: Array<{kind: string, detail: string, action: string}>}}
 */
export function applyBlueprintDelta(state, delta, ctx = {}) {
  const ops = Array.isArray(delta) ? delta.filter((d) => d && d.id && d.op) : [];
  if (!ops.length) return { state, violations: [] };
  const next = structuredClone(state);
  const bp = next.course_plan_blueprint || (next.course_plan_blueprint = { version: 0, modules: [], revision_log: [] });
  const violations = [];
  // Answered against the state BEFORE this delta, so ops cannot launder a
  // confirmation through each other — MINUS whatever this delta removes, so a
  // remove-then-set of the same id cannot resurrect it as already confirmed.
  const preConfirmed = new Set();
  const preIds = new Set();
  const preStatus = new Map();
  const preBody = new Map();
  const walkPre = (n) => {
    preIds.add(n.id);
    preStatus.set(n.id, n.status);
    preBody.set(n.id, String(n.body ?? ''));
    if (n.status === 'confirmed') preConfirmed.add(n.id);
    for (const c of n.children || []) walkPre(c);
  };
  for (const m of bp.modules) walkPre(m);
  const forget = (n) => { preIds.delete(n.id); preConfirmed.delete(n.id); preStatus.delete(n.id); preBody.delete(n.id); for (const c of n.children || []) forget(c); };
  /** Degrade every illegitimate `confirmed` in one incoming subtree, and report
   * each one. Mutates and returns the subtree it is given (always a fresh
   * clone, never the live tree). */
  const guard = (root, citedId) => {
    const walk = (n) => {
      if (n.status === 'confirmed' && !preConfirmed.has(n.id)) {
        if (!preIds.has(n.id)) {
          n.status = 'ai_suggestion';
          violations.push({ kind: 'born_confirmed', detail: `新节点 ${n.id} 不能一出生就是 confirmed——已降为 ai_suggestion`, action: 'strip' });
        } else if (n.id !== citedId) {
          n.status = preStatus.get(n.id) ?? 'ai_suggestion';
          violations.push({ kind: 'uncited_confirmation', detail: `${n.id} 升为 confirmed 缺教师原话（confirmed_by_quote）——已退回原出处`, action: 'strip' });
        }
      } else if (n.status === 'confirmed' && preConfirmed.has(n.id)) {
        // She confirmed the text she read. A rewritten body is new text under
        // an old confirmation — the model proposes, she re-confirms.
        const body = String(n.body ?? '');
        if (body && body !== (preBody.get(n.id) ?? '') && n.id !== citedId) {
          n.status = 'pending_validation';
          violations.push({
            kind: 'uncited_confirmation',
            detail: `${n.id} 已确认，但这次改写了正文且没有教师的重新确认——出处降为 pending_validation，等她再看一眼`,
            action: 'strip',
          });
        }
      }
      for (const c of n.children || []) walk(c);
    };
    walk(root);
    return root;
  };
  const findWithParent = (id) => {
    let found = null;
    const walk = (n, parent, root) => {
      if (found) return;
      if (n.id === id) { found = { node: n, parent, root }; return; }
      for (const c of n.children || []) walk(c, n, root);
    };
    for (const m of bp.modules) walk(m, null, m);
    return found;
  };
  const version = (bp.version || 0) + 1;
  let applied = 0;
  for (const op of ops) {
    if (op.op === 'remove') {
      const hit = findWithParent(op.id);
      if (!hit) { violations.push({ kind: 'blueprint_scope', detail: `remove：未知节点 ${op.id}`, action: 'strip' }); continue; }
      if (!hit.parent) { violations.push({ kind: 'blueprint_scope', detail: `remove：${op.id} 是模块，模块不可整体删除`, action: 'strip' }); continue; }
      hit.parent.children = hit.parent.children.filter((c) => c.id !== op.id);
      forget(hit.node); // the id is free again — and free means NEW, not pre-confirmed
      bp.revision_log.push({ v: version, module_id: hit.root.id, op: 'remove', node_id: op.id });
      applied += 1;
    } else if (op.op === 'update') {
      const hit = findWithParent(op.id);
      if (!hit || !op.node) { violations.push({ kind: 'blueprint_scope', detail: `update：未知节点或缺 node（${op.id}）`, action: 'strip' }); continue; }
      const incoming = structuredClone({ ...hit.node, ...op.node, id: op.id });
      guard(incoming, citedNodeOf(op, ctx));
      Object.assign(hit.node, incoming);
      bp.revision_log.push({ v: version, module_id: hit.root.id, op: 'update', node_id: op.id });
      applied += 1;
    } else if (op.op === 'set') {
      if (!op.node) { violations.push({ kind: 'blueprint_scope', detail: `set：缺 node（${op.id}）`, action: 'strip' }); continue; }
      const fresh = structuredClone({ children: [], status: 'ai_suggestion', title: '', ...op.node, id: op.id });
      // A `set` reusing a live id is refused outright. Appending a second node
      // under an existing id leaves two nodes the revision log and the map can
      // no longer tell apart — and it is how a fabricated `confirmed` node
      // walked past a guard that only ever looked at the PRE-delta snapshot.
      const clash = blueprintSubtreeIds(fresh).find((id) => findWithParent(id));
      if (clash) { violations.push({ kind: 'blueprint_scope', detail: `set：${clash} 已在蓝图别处存在——改动请用 update`, action: 'strip' }); continue; }
      guard(fresh, citedNodeOf(op, ctx));
      if (op.parent_id) {
        const parent = findWithParent(op.parent_id);
        if (!parent) { violations.push({ kind: 'blueprint_scope', detail: `set：未知父节点 ${op.parent_id}`, action: 'strip' }); continue; }
        parent.node.children = parent.node.children || [];
        parent.node.children.push(fresh);
        bp.revision_log.push({ v: version, module_id: parent.root.id, op: 'set', node_id: op.id });
      } else {
        bp.modules.push(fresh);
        bp.revision_log.push({ v: version, module_id: op.id, op: 'set' });
      }
      applied += 1;
    } else {
      violations.push({ kind: 'blueprint_scope', detail: `未知操作 ${op.op}`, action: 'strip' });
    }
  }
  if (applied) bp.version = version;
  return { state: next, violations };
}

// ---------- course_plan deltas (ADR-0007 §2/§5, ADR-0010 §5/§6) ----------

/** Node fields the ENGINE owns, never the model. `id` is the address the op
 * already carries; the staleness stamp is a propagation record, and a model
 * that could clear it could hide an invalidation from the teacher — the badge
 * exists precisely because tiered context will not notice on its own. */
const ENGINE_OWNED_NODE_KEYS = new Set(['id', 'stale_since', 'stale_reason']);

/** Monotonic plan version. A string version ('v7') is the model's advisory
 * display text (same status as the blueprint's), so we read its trailing
 * number rather than trusting it: a bump must never land on a number the
 * staleness stamps have already used. Nothing readable means we start at 0. */
function planVersion(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v);
  const m = /(\d+)\s*$/.exec(String(v ?? ''));
  return m ? Number(m[1]) : 0;
}

/** Every id in one subtree, the node itself first. */
const subtreeIds = (node) => [...walkPlan({ roots: [node] })].map(({ node: n }) => n.id);

/**
 * Node-granularity course_plan delta — the model's only write path into the
 * plan tree. Ops: `set` (insert under `parent_id`, or a new root 月计划 without
 * one), `update` (patch an existing node), `remove` (delete a non-root node).
 * Mirrors applyBlueprintDelta in shape and in discipline. Pure.
 *
 * Four rules the engine keeps to itself, because the model proposes and the
 * engine disposes:
 *
 * 1. **An op naming an unknown node is stripped, never applied.** A typo'd id
 *    must not quietly grow a second tree next to the one she is reading.
 * 2. **No node is ever BORN `confirmed`.** She cannot have confirmed a node she
 *    has not seen, so a first appearance degrades to `ai_suggestion` — quote or
 *    no quote, since a quote proves she said something, not that she saw this.
 * 3. **Escalating an EXISTING node to `confirmed` needs her own words on the
 *    op** (`confirmed_by_quote`). ADR-0010 §6 removed the ✓确认 tick and rebuilt
 *    the guarantee here: no quote, no escalation — the status reverts to what
 *    the node already said and an `uncited_confirmation` violation is recorded.
 *    A model that reads 「好的，我先看看」 as approval fails the citation test
 *    instead of silently writing a false record. One quote confirms one node:
 *    it does not travel to nested nodes riding along in the same op.
 * 4. **An applied op stamps the blast radius stale** (plan-tsv `markStale`).
 *    Mark, do not recompute (ADR-0007 §5) — regenerating descendants would
 *    overwrite work she confirmed against real children.
 * 5. **Rewriting a confirmed node's BODY demotes it to `pending_validation`.**
 *    The edited node is excluded from its own blast radius, so without this a
 *    content substitution keeps her badge, carries no staleness stamp, and
 *    reads as a fact she vouched for. Titles and the other display fields are
 *    left alone: a rename is the everyday edit.
 *
 * @param {Object} state course_state; `course_plan` is created if absent
 * @param {Array<{op:'set'|'update'|'remove', id:string, parent_id?:string, node?:Object, confirmed_by_quote?:string, reason?:string}>} ops
 * @param {{teacherText?: string}} [ctx] when `teacherText` is supplied, a quote
 *   must actually occur in it — a citation nobody can check is decoration
 * @returns {{state: Object, violations: Array<{kind: string, detail: string, action: string}>}}
 */
export function applyPlanDelta(state, ops, ctx = {}) {
  const list = Array.isArray(ops) ? ops.filter((o) => o && o.id && o.op) : [];
  if (!list.length) return { state, violations: [] };

  const next = structuredClone(state);
  // `let`: every markStale returns a NEW tree, so the working plan is rebound
  // rather than mutated in place, and helpers below read it at call time.
  let plan = (next.course_plan && Array.isArray(next.course_plan.roots))
    ? next.course_plan
    : { version: 0, roots: [] };
  const revisionLog = Array.isArray(plan.revision_log) ? plan.revision_log : [];
  const violations = [];

  // Every confirmation question is answered against the state BEFORE this
  // delta, so ops in one delta cannot launder a confirmation through each
  // other (the discipline absorbBlueprint already keeps across artifacts).
  const preIds = new Set();
  const preConfirmed = new Set();
  const preStatus = new Map();
  const preBody = new Map();
  for (const { node } of walkPlan(plan)) {
    preIds.add(node.id);
    preStatus.set(node.id, node.status);
    preBody.set(node.id, String(node.body ?? ''));
    if (node.status === 'confirmed') preConfirmed.add(node.id);
  }
  /** Forget a removed subtree. The snapshot is what makes an id count as
   * pre-existing, so a `remove` followed by a `set` of the same id inside ONE
   * delta would otherwise resurrect it as born-confirmed — the born-confirmed
   * guard reading a node the teacher can no longer see. */
  const forget = (node) => {
    for (const id of subtreeIds(node)) {
      preIds.delete(id);
      preConfirmed.delete(id);
      preStatus.delete(id);
      preBody.delete(id);
    }
  };

  const version = planVersion(plan.version) + 1;

  const locate = (id) => {
    let found = null;
    const walk = (nodes, parent, root, depth) => {
      for (const n of nodes) {
        if (found) return;
        if (n.id === id) { found = { node: n, parent, root: root ?? n, depth }; return; }
        walk(n.children || [], n, root ?? n, depth + 1);
      }
    };
    walk(plan.roots || [], null, null, 0);
    return found;
  };

  /** Degrade every illegitimate `confirmed` in an incoming subtree. Mutates and
   * returns the subtree it is given (always a fresh one, never the tree).
   * `demoted` collects the ids it moved, because an `update` patch only writes
   * the keys the model actually named: a body rewrite that never mentioned
   * `status` would otherwise leave the demotion in a discarded clone. */
  const guard = (root, citedId, demoted = new Set()) => {
    const walk = (n) => {
      if (n.status === 'confirmed' && !preConfirmed.has(n.id)) {
        if (!preIds.has(n.id)) {
          n.status = 'ai_suggestion';
          violations.push({ kind: 'born_confirmed', detail: `新节点 ${n.id} 不能一出生就是 confirmed——已降为 ai_suggestion`, action: 'strip' });
        } else if (n.id !== citedId) {
          n.status = preStatus.get(n.id) ?? 'ai_suggestion';
          violations.push({ kind: 'uncited_confirmation', detail: `${n.id} 升为 confirmed 缺教师原话（confirmed_by_quote）——已退回原出处`, action: 'strip' });
        }
        demoted.add(n.id);
      } else if (n.status === 'confirmed' && preConfirmed.has(n.id)) {
        // Her confirmation vouched for the text she read. Swapping the body
        // under it keeps the badge and changes the claim — 「孩子们已经掌握了
        // 龙舟结构」 arriving as confirmed is non-negotiable #1 with her name on
        // it. A TITLE touch-up is left alone deliberately: renaming 「看一条真
        // 龙舟（改到周二）」 is the everyday edit, and the fixture that pins it
        // predates this rule.
        const body = String(n.body ?? '');
        if (body && body !== (preBody.get(n.id) ?? '') && n.id !== citedId) {
          n.status = 'pending_validation';
          demoted.add(n.id);
          violations.push({
            kind: 'uncited_confirmation',
            detail: `${n.id} 已确认，但这次改写了正文且没有教师的重新确认——出处降为 pending_validation，等她再看一眼`,
            action: 'strip',
          });
        }
      }
      for (const c of n.children || []) walk(c);
    };
    walk(root);
    return demoted;
  };

  /** Borrow plan-tsv's normalizer for one incoming subtree — it is the single
   * tree model, and it infers `kind` from DEPTH, so a node landing under a
   * 周计划 must be normalized at its real depth or an activity would come back
   * a phase. Throwaway ancestors are how we rent that inference instead of
   * writing a second one here. Existing nodes are never put through it: it
   * drops fields it does not know about, and a node's revision history is
   * exactly such a field (plan-tsv, change-propagation preamble). */
  const sanitizeAt = (node, id, depth) => {
    let wrapped = { ...node, id };
    for (let d = depth; d > 0; d -= 1) wrapped = { id: `__depth${d}`, children: [wrapped] };
    let out = normalizePlan({ roots: [wrapped] }).roots[0];
    for (let d = depth; d > 0; d -= 1) out = out.children[0];
    for (const k of ENGINE_OWNED_NODE_KEYS) if (k !== 'id') delete out[k];
    return out;
  };

  let applied = 0;
  for (const op of list) {
    // The reason travels with the node (ADR-0007 §5): a node reopened two weeks
    // later still says why it is flagged, instead of pointing at a chat turn
    // that fell out of the window. A badge reading only 待复查 is a puzzle she
    // has to solve before she can judge it, so there is always a fallback.
    const label = (title) => `「${title || op.id}」`;

    if (op.op === 'remove') {
      const hit = locate(op.id);
      if (!hit) { violations.push({ kind: 'plan_scope', detail: `remove：未知节点 ${op.id}`, action: 'strip' }); continue; }
      if (!hit.parent) { violations.push({ kind: 'plan_scope', detail: `remove：${op.id} 是根节点，整棵计划不可一次删除`, action: 'strip' }); continue; }
      // Marked BEFORE the cut: once the subtree is gone, the nodes that rest on
      // it by blueprint_refs can no longer be found from it.
      const rootId = hit.root.id;
      plan = markStale(plan, op.id, { version: String(version), reason: op.reason || `上游节点${label(hit.node.title)}已删除` });
      const after = locate(op.id);
      after.parent.children = after.parent.children.filter((c) => c.id !== op.id);
      forget(after.node); // the id is free again — and free means NEW, not pre-confirmed
      revisionLog.push({ v: version, root_id: rootId, op: 'remove', node_id: op.id });
      applied += 1;
    } else if (op.op === 'update') {
      const hit = locate(op.id);
      if (!hit || !op.node) { violations.push({ kind: 'plan_scope', detail: `update：未知节点或缺 node（${op.id}）`, action: 'strip' }); continue; }
      const incoming = sanitizeAt(op.node, op.id, hit.depth);
      // The guard reasons about what the node WILL say, not about what this op
      // typed out: an op that omits `status` leaves the node's own status
      // standing, and normalizePlan's default would otherwise make a confirmed
      // node look like a fresh `ai_suggestion` to it.
      if (!('status' in op.node)) incoming.status = hit.node.status;
      // An id may be restated only where it already lives. Letting an incoming
      // child borrow the id of a confirmed node elsewhere in the tree would
      // make it read as pre-confirmed to the guard below — a new node born
      // `confirmed` through the side door — besides leaving two nodes that
      // markStale and the skeleton can no longer tell apart.
      const inTarget = new Set([...walkPlan({ roots: [hit.node] })].map(({ node }) => node.id));
      const clash = subtreeIds(incoming).find((id) => !inTarget.has(id) && locate(id));
      if (clash) { violations.push({ kind: 'plan_scope', detail: `update：${clash} 已在计划别处存在——同一个 id 不能出现两次`, action: 'strip' }); continue; }
      const demoted = guard(incoming, citedNodeOf(op, ctx));
      // Only what the model actually named is patched. Keys it invented are not
      // in `incoming` and vanish; keys it left out keep the node's own value,
      // including fields this module knows nothing about.
      const patch = {};
      for (const k of Object.keys(op.node)) {
        if (ENGINE_OWNED_NODE_KEYS.has(k) || !(k in incoming)) continue;
        patch[k] = incoming[k];
      }
      // A demotion the model never asked for still has to land: an op that
      // rewrote a confirmed body without touching `status` would otherwise be
      // patched with the body alone and keep the badge.
      if (demoted.has(op.id)) patch.status = incoming.status;
      // An update carrying an EMPTY children array keeps the existing subtree.
      // absorbBlueprint learned this the hard way: round-2 confirmations shipped
      // `children: []` and emptied the living 网络图. Emptying a 周计划 of its
      // activities is a remove op per activity, not a side effect of a touch-up.
      if (Array.isArray(patch.children) && !patch.children.length && hit.node.children?.length) {
        delete patch.children;
        violations.push({ kind: 'plan_scope', detail: `update：${op.id} 带空 children——子节点保留，删除请用 remove`, action: 'strip' });
      }
      const rootId = hit.root.id;
      // Radius computed on the PRE-update tree, so her existing downstream work
      // is stamped while anything arriving with this op is born clean.
      plan = markStale(plan, op.id, { version: String(version), reason: op.reason || `上游节点${label(hit.node.title)}有修改` });
      Object.assign(locate(op.id).node, patch);
      revisionLog.push({ v: version, root_id: rootId, op: 'update', node_id: op.id });
      applied += 1;
    } else if (op.op === 'set') {
      if (!op.node) { violations.push({ kind: 'plan_scope', detail: `set：缺 node（${op.id}）`, action: 'strip' }); continue; }
      if (locate(op.id)) { violations.push({ kind: 'plan_scope', detail: `set：${op.id} 已存在——改动请用 update`, action: 'strip' }); continue; }
      const parent = op.parent_id ? locate(op.parent_id) : null;
      if (op.parent_id && !parent) { violations.push({ kind: 'plan_scope', detail: `set：未知父节点 ${op.parent_id}`, action: 'strip' }); continue; }
      const fresh = sanitizeAt(op.node, op.id, parent ? parent.depth + 1 : 0);
      const born = new Set(subtreeIds(fresh));
      const clash = [...born].find((id) => locate(id));
      if (clash) { violations.push({ kind: 'plan_scope', detail: `set：${clash} 已在计划别处存在——同一个 id 不能出现两次`, action: 'strip' }); continue; }
      guard(fresh, citedNodeOf(op, ctx));
      if (parent) {
        parent.node.children = parent.node.children || [];
        parent.node.children.push(fresh);
      } else {
        plan.roots.push(fresh);
      }
      plan = markStale(plan, op.id, { version: String(version), reason: op.reason || `上游新增了节点${label(fresh.title)}` });
      // The radius of a brand-new node is its own subtree plus whatever already
      // referenced it. The subtree was written this second, so it cannot be
      // stale against its own birth; the referrers genuinely are.
      for (const { node } of walkPlan(plan)) {
        if (!born.has(node.id)) continue;
        delete node.stale_since;
        delete node.stale_reason;
      }
      revisionLog.push({ v: version, root_id: parent ? parent.root.id : op.id, op: 'set', node_id: op.id, parent_id: op.parent_id ?? null });
      applied += 1;
    } else {
      violations.push({ kind: 'plan_scope', detail: `未知操作 ${op.op}`, action: 'strip' });
    }
  }

  if (applied) plan.version = version;
  plan.revision_log = revisionLog;
  next.course_plan = plan;
  return { state: next, violations };
}

/** Evidence ids present in state (for the harness fabrication check). */
export function evidenceIds(state) {
  return new Set((state.children_evidence || []).map((e) => e.id));
}

/**
 * Absorb blueprint artifacts into course_state.course_plan_blueprint — the
 * LIVING mother plan the workspace panel renders (ADR-0003; DATABASE.md §2b).
 * Module-granularity delta: modules merge by id (same id = replace, new id =
 * append, order of first appearance kept); the ENGINE owns the version bump
 * and the revision log — the model's version string is advisory display text.
 * One escalation rule enforced here, deterministically: a module can never be
 * BORN confirmed — first appearance degrades to ai_suggestion. Escalating an
 * EXISTING module to confirmed is legal only while a teacher reply is being
 * applied (the reply is the confirmation; later the ✓确认 UI event becomes the
 * cleaner channel). Pure: returns { state, changed }.
 */
export function absorbBlueprint(state, turn, ctx = {}) {
  const artifacts = (turn?.artifacts || [])
    .filter((a) => a && a.type === 'blueprint')
    .map((a) => ({ artifact: a, normalized: normalizeBlueprint(a.data) }))
    .filter((a) => a.normalized.modules.length); // empty artifacts never bump the version
  if (!artifacts.length) return { state, changed: [] };
  const next = structuredClone(state);
  const prev = next.course_plan_blueprint || { version: 0, modules: [], revision_log: [] };
  const revisionLog = prev.revision_log || [];
  // Escalation sets come from the PRE-TURN state only (deep walk) — multiple
  // artifacts in one turn cannot launder a confirmation through each other,
  // and nested nodes obey the same rule as modules.
  const preConfirmed = new Set();
  const preIds = new Set();
  const walkPre = (n) => {
    if (!n) return;
    preIds.add(n.id);
    if (n.status === 'confirmed') preConfirmed.add(n.id);
    for (const c of n.children || []) walkPre(c);
  };
  for (const m of prev.modules || []) walkPre(m);
  const sanitizeTree = (node) => {
    const out = structuredClone(node);
    const walk = (n) => {
      if (n.status === 'confirmed' && !preConfirmed.has(n.id) && !(ctx.teacherTurn && preIds.has(n.id))) {
        n.status = 'ai_suggestion'; // never BORN confirmed; escalation needs a teacher reply on an existing node
      }
      for (const c of n.children || []) walk(c);
    };
    walk(out);
    return out;
  };
  const version = (prev.version || 0) + 1;
  const modules = [...(prev.modules || [])];
  const changed = [];
  for (const { normalized } of artifacts) {
    for (const mod of normalized.modules) {
      const sanitized = sanitizeTree(mod);
      const idx = modules.findIndex((m) => m.id === sanitized.id);
      const op = idx >= 0 ? 'update' : 'set';
      if (idx >= 0) {
        // An update that carries NO children keeps the existing subtree — a
        // status/body touch-up must never wipe the teacher's map branches
        // (pedagogy-panel finding: round-2 confirmations shipped children:[]
        // and emptied the living 网络图).
        if (!sanitized.children.length && modules[idx].children?.length) {
          sanitized.children = modules[idx].children;
        }
        modules[idx] = sanitized;
      } else {
        modules.push(sanitized);
      }
      changed.push(sanitized.id);
      revisionLog.push({ v: version, module_id: sanitized.id, op });
    }
  }
  next.course_plan_blueprint = {
    version,
    display_version: String(artifacts[artifacts.length - 1].artifact.data?.version ?? `v${version}`),
    modules,
    revision_log: revisionLog,
  };
  // Preset-artifact workflow nodes light DETERMINISTICALLY from what the
  // blueprint now contains (stage1-workflow-v1.0; ADR-0004) — the 工作流地图
  // must not depend on the model remembering to claim them. Only agent-side
  // preset work lights here; nodes that assert real child activity (WF05–07b,
  // WF09) stay model-claimed against 回传 evidence. engine_lit_nodes is not a
  // writable delta field — the model cannot fake these.
  const litFrom = (m) => {
    const key = `${m.id} ${m.title ?? ''}`;
    if (/depth|深度/.test(key)) return 'WF04b';
    if (/network|网络/.test(key)) return 'WF04';
    if (/plan|周计划|月计划|environment|环境|材料/.test(key)) return 'WF08';
    return null;
  };
  const lit = new Set(next.engine_lit_nodes || []);
  lit.add('WF04a'); // a blueprint version landed — the 一次性输出 demonstrably happened
  for (const m of modules) { const n = litFrom(m); if (n) lit.add(n); }
  next.engine_lit_nodes = [...lit];
  const done = new Set(next.completed_nodes || []);
  next.completed_nodes = [...(next.completed_nodes || []), ...[...lit].filter((n) => !done.has(n))];
  return { state: next, changed };
}
