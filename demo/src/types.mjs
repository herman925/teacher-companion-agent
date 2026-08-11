// Shared JSDoc typedefs for the demo (ADR-0001: JSDoc-typed ESM, no build step).
// The wire/turn contract here mirrors demo/src/prompts/contract.zh.md and
// harness/schema/course-state.schema.json — those two are normative.

/**
 * @typedef {Object} TurnQuestion
 * @property {string} text     The single focused question for this turn.
 * @property {string} why      One clause: why this is being asked now.
 * @property {string[]} examples  2–3 tappable example answers.
 */

/**
 * @typedef {Object} TurnArtifact
 * @property {"entry_card"|"fit_screening"|"experience_plan"|"interview_card"|"question_pool"|"driving_questions"|"cycle_task"|"story_fragment"} type
 * @property {string} title
 * @property {Object} data
 */

/**
 * @typedef {Object} ClosureLoop
 * @property {string} do_now      本轮可以去做什么
 * @property {string} materials   建议生成/使用哪些素材
 * @property {string} bring_back  回来请告诉我什么
 * @property {string} i_will      我收到后会继续帮你做什么
 */

/**
 * The model's per-turn output (L2 structured output).
 * @typedef {Object} Turn
 * @property {string} reply_markdown
 * @property {TurnQuestion|null} question
 * @property {TurnQuestion[]} [questions]  Canonical array; `question` is its first entry.
 * @property {TurnArtifact[]} artifacts
 * @property {ClosureLoop|null} closure_loop
 * @property {Object} state_delta        Partial course_state patch (engine validates/applies).
 * @property {string[]} evidence_refs    Ids into course_state.children_evidence.
 * @property {boolean} round_complete
 * @property {PlanOp[]} [plan_delta]       Node-granularity plan-tree edits (engine.applyPlanDelta).
 * @property {PlanOp[]} [blueprint_delta]  Node-granularity blueprint edits (engine.applyBlueprintDelta).
 * @property {Object|null} [wf_trace]  Dev-facing workflow trace (passed through unvalidated; 开发者模式 UI).
 */

/**
 * One node-granularity edit. `confirmed_by_quote` is the teacher's own words
 * from the SAME turn, and the only thing that may escalate a node to
 * `confirmed` now that the ✓确认 tick is gone (ADR-0010 §6).
 * @typedef {Object} PlanOp
 * @property {"set"|"update"|"remove"} op
 * @property {string} id
 * @property {string} [parent_id]
 * @property {Object} [node]
 * @property {string} [confirmed_by_quote]
 * @property {string} [reason]
 */

/**
 * A runtime-harness finding. The kind list tracks ADR-0012 §2, which narrowed
 * the harness to three jobs — scope shell, evidence and provenance, structural
 * integrity — and rewrote this list rather than shortening it:
 *
 * - NEW: `uncited_confirmation` (ADR-0010 §6), `memory_contradiction`
 *   (ADR-0011 §5).
 * - WEAKENED to advisory: `closure_missing`, `closure_incomplete` — ADR-0008 §3
 *   made 回传 an invitation, so their absence is no longer a defect.
 * - RETIRED: `node_prerequisite`, which enforced the `NODE_PREREQS` graph, i.e.
 *   the workflow chain itself. `illegal_stage_jump` was NOT retired with it: it
 *   bundles an ordinal check and the stage-2/5 evidence gates, and those are
 *   non-negotiable #1 wearing a gate's clothes.
 *
 * @typedef {Object} Violation
 * @property {"contract_parse"|"bad_delta"|"illegal_stage_jump"|"blueprint_scope"|"plan_scope"|"fabrication"|"unmarked_hypothesis"|"uncited_confirmation"|"born_confirmed"|"memory_contradiction"|"adult_slogan"|"multi_question"|"question_no_examples"|"closure_missing"|"closure_incomplete"|"many_questions"|"no_forward_handle"|"style_mismatch"|"planning_question_density"|"blueprint_resend"} kind
 * @property {string} detail
 * @property {"block"|"strip"|"warn"} action  block → regenerate (L4);
 *   strip → engine drops the offending field and logs; warn → recorded and shown
 *   in the dev drawer only, never retried.
 */

/**
 * @typedef {Object} GateReport
 * @property {boolean} ok
 * @property {Violation[]} violations
 * @property {number} attempt        1 = first pass, 2 = after regeneration.
 * @property {boolean} degraded      True when L4 fell back to the safe template.
 */

/**
 * @typedef {Object} ProviderConfig
 * @property {string} id
 * @property {string} label
 * @property {string} baseURL
 * @property {string} model
 * @property {"json_schema"|"tool_call"|"json_object_prompt"} jsonStrategy
 * @property {"opencode"} [kind]  Non-OpenAI adapter path (OpenCode session API); absent = OpenAI-compatible.
 * @property {boolean} [stripThinking]  MiniMax M-series interleaved thinking.
 * @property {boolean} [enabled]
 */

export {};
