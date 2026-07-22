// Deterministic course_state engine: the LLM proposes deltas, this module disposes.
// Transition gates encode spec §2 流转规则 (source-docs/workflow-v1.3.zh-CN.md).
// Runs in both the demo server (validation) and the browser (localStorage store).

import { NODE_PREREQS, WF_NODES } from './wf-nodes.mjs';
import { normalizeBlueprint } from './blueprint-util.mjs';

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
  switch (toStage) {
    case 1:
      if (!state.resource_entry_card) return '进入阶段1需要先生成资源课程化切口卡（WF03b）';
      if (!state.theme_fit_level) return '进入阶段1需要先完成主题适配性筛查（WF02b）';
      return null;
    case 2:
      // stage1-workflow-v1.0: evidence stays mandatory (non-negotiable 1), but
      // a driving question is NO LONGER a stage-1 exit requirement — it gets
      // derived at the stage-2 boundary from the question pool, not forced.
      if (!(state.children_evidence || []).length) return '没有儿童证据（原话/作品/照片/观察）不能进入目标轴心——先补一轮真实体验';
      return null;
    case 3:
      if (!state.goals_assessment_axis || !state.goals_assessment_axis.core_understanding) {
        return '进入阶段3需要先确立目标轴心草稿（至少核心理解目标）';
      }
      return null;
    case 4:
      if (!(state.cycle_history || []).length) return '进入阶段4需要至少一轮协作行动记录';
      return null;
    case 5:
      if (!(state.children_evidence || []).length) return '没有任何过程证据，无法导出课程故事——先列缺口，不虚构';
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
 * @param {{ roundComplete?: boolean, teacherTurn?: boolean }} ctx
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

/**
 * Node-granularity blueprint delta (ADR-0003 Phase 3): small edits without
 * re-emitting whole modules. Ops: update (replace an existing node's fields,
 * children preserved unless provided), remove (delete a non-module node),
 * set (insert under parent_id, or as a new module without one). The same
 * born-confirmed rule as absorbBlueprint applies. Pure.
 * @param {Object} state
 * @param {Array<{op:'set'|'update'|'remove', id:string, parent_id?:string, node?:Object}>} delta
 */
export function applyBlueprintDelta(state, delta, ctx = {}) {
  const ops = Array.isArray(delta) ? delta.filter((d) => d && d.id && d.op) : [];
  if (!ops.length) return { state, violations: [] };
  const next = structuredClone(state);
  const bp = next.course_plan_blueprint || (next.course_plan_blueprint = { version: 0, modules: [], revision_log: [] });
  const violations = [];
  const preConfirmed = new Set();
  const preIds = new Set();
  const walkPre = (n) => { preIds.add(n.id); if (n.status === 'confirmed') preConfirmed.add(n.id); for (const c of n.children || []) walkPre(c); };
  for (const m of bp.modules) walkPre(m);
  const guard = (n) => {
    if (n.status === 'confirmed' && !preConfirmed.has(n.id) && !(ctx.teacherTurn && preIds.has(n.id))) n.status = 'ai_suggestion';
    for (const c of n.children || []) guard(c);
    return n;
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
      bp.revision_log.push({ v: version, module_id: hit.root.id, op: 'remove', node_id: op.id });
      applied += 1;
    } else if (op.op === 'update') {
      const hit = findWithParent(op.id);
      if (!hit || !op.node) { violations.push({ kind: 'blueprint_scope', detail: `update：未知节点或缺 node（${op.id}）`, action: 'strip' }); continue; }
      const incoming = guard(structuredClone({ ...hit.node, ...op.node, id: op.id }));
      Object.assign(hit.node, incoming);
      bp.revision_log.push({ v: version, module_id: hit.root.id, op: 'update', node_id: op.id });
      applied += 1;
    } else if (op.op === 'set') {
      if (!op.node) { violations.push({ kind: 'blueprint_scope', detail: `set：缺 node（${op.id}）`, action: 'strip' }); continue; }
      const fresh = guard(structuredClone({ children: [], status: 'ai_suggestion', title: '', ...op.node, id: op.id }));
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
