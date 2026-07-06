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
 * @property {TurnArtifact[]} artifacts
 * @property {ClosureLoop|null} closure_loop
 * @property {Object} state_delta        Partial course_state patch (engine validates/applies).
 * @property {string[]} evidence_refs    Ids into course_state.children_evidence.
 * @property {boolean} round_complete
 * @property {Object|null} [wf_trace]  Dev-facing workflow trace (passed through unvalidated; 开发者模式 UI).
 */

/**
 * @typedef {Object} Violation
 * @property {"closure_missing"|"closure_incomplete"|"multi_question"|"question_no_examples"|"fabrication"|"adult_slogan"|"illegal_stage_jump"|"node_prerequisite"|"bad_delta"|"contract_parse"} kind
 * @property {string} detail
 * @property {"block"|"strip"} action  block → regenerate (L4); strip → auto-repair + log.
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
 * @property {boolean} [stripThinking]  MiniMax M-series interleaved thinking.
 * @property {boolean} [enabled]
 */

export {};
