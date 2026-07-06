// Deterministic course_state engine: the LLM proposes deltas, this module disposes.
// Transition gates encode spec §2 流转规则 (source-docs/workflow-v1.3.zh-CN.md).
// Runs in both the demo server (validation) and the browser (localStorage store).

import { NODE_PREREQS, WF_NODES } from './wf-nodes.mjs';

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
      if (!(state.children_evidence || []).length) return '没有儿童证据（原话/作品/照片/观察）不能进入目标轴心——先补一轮真实体验';
      if (!state.driving_question || !((state.driving_question.candidates || []).length || state.driving_question.text)) {
        return '进入阶段2需要先有核心驱动问题候选（WF08）';
      }
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

  // Platform-controlled pacing: a completed round waits for the classroom;
  // a new teacher message re-opens the conversation.
  if (ctx.teacherTurn) next.awaiting_feedback = false;
  if (ctx.roundComplete) next.awaiting_feedback = true;

  return { state: next, violations, applied };
}

/** Evidence ids present in state (for the harness fabrication check). */
export function evidenceIds(state) {
  return new Set((state.children_evidence || []).map((e) => e.id));
}
