# ADR-0003: Blueprint-first planning lens (预设/生成 rebalance)

**Status:** Proposed · 2026-07-17 — accept once 锋's reworked Stage-1 workflow doc arrives and Herman signs off

## Context

Pilot teachers reported the agent 「锁得有点死」: generation crushed preset. The hard chain (no child questions → no driving question → no goals/actions) forced office-hours prep users through a one-question-one-answer unlock loop; several lost interest before Stage 1 ended. The upstream discussion doc ([source-docs/workflow-v1.3-contradictions.zh-CN.md](../../source-docs/workflow-v1.3-contradictions.zh-CN.md)) diagnosed the root cause: 「不能虚构儿童的真实过程」 was over-executed into 「不能提前帮助教师形成完整预设」 — course-implementation order was mistaken for conversation order.

On the 2026-07-17 锋×枫 call, 枫 (spec author) settled the open questions: the product is a **主题探究 agent** (项目式 is a branch surfaced by signal around Stage 3, never the spine); the workflow needs no rewrite — the agent simply never implemented her Stage 1, which is five concrete steps from 小小探索家; and delivery must be 「不要一点一点吐给我，直接给我一个比较明确的蓝图」. Her five steps: ① 教师预先计划 (preset theme network map, warned against 极左/极右 误区), ② 建立共同经验 (activities in exactly five organization types: 集体教学/小组教学/个别指导/自主游戏·环创/亲子活动), ③ 发掘孩子已有知识 (清单/网络图/KWL), ④ 发展幼儿想探究的问题 (KWL/KWHL, 问题墙, core driving question), ⑤ 创设探究环境 (环创方案, 材料清单, 给家长的一封信, activities folded into 周/月计划). Steps are not strictly sequential and span 2–3 weeks.

This matches Herman's earlier information-starvation diagnosis (deliver-then-ask, multi-question turns, dependency-graph 「亮灯」 traversal) and the Claude synthesis recorded in HANDOFF: evidence must gate *assertions about children*, never *planning artifacts*. The 蓝图共创 response style shipped 2026-07-16 already prototyped this at prompt level.

## Decision

Adopt the contradictions doc's direction — 「先充分预设、再真实生成、持续修订」 — with 枫's five-step Stage 1 as the blueprint's content spine, amended as follows:

1. **Two rule families, split.** Evidence-first narrows to realized-child-fact assertions (unchanged, non-negotiable #1 intact). Planning content is always generatable; not-yet-happened child reactions must carry status marking (`hypothesis`/`pending_validation` or 「预设·待现场验证」 wording), never fact phrasing. Refusing to preset for lack of field evidence becomes a defect, not a safeguard.
2. **Blueprint as the mother object.** One persistent, versioned 课程预设蓝图 (`course_plan_blueprint`) absorbs today's scattered cards (network maps, 体验方案, question pools, goal axis). Per-module provenance: `confirmed / teacher_preset / ai_suggestion / hypothesis / pending_validation`. Only teacher confirmation or recorded evidence escalates to `confirmed`. Revisions update modules and bump a version — never a second parallel plan.
3. **Mode is a derived lens, not stored state.** No new `interaction_mode` field. The lens (planning / implementation / story / material) is computed per turn from the existing `teacher_mode` plus the input's class. Mixed turns work; nothing sticky locks the teacher into a mode. (Deviation from the doc's §7.1, which stores `interaction_mode` — two mode fields would drift.)
4. **Resource-intent gate softens to auto-extract.** WF03b 资源意图三问 is no longer a hard pre-blueprint gate: the agent extracts intent from the teacher's message and profile, asks at most 2–3 questions covering only the gaps, and delivers blueprint v0.1 in the same turn (deliver-then-ask). Slop control moves from rationing to marking: provenance statuses, observation points, and the 极左/极右 warnings replace the evidence ration.
5. **Density guardrails.** Planning-lens turns: ≤3 question cards, and questions without delivered content are a violation direction (warn first, tightened on pilot data). The 主题/项目 fork stays where 枫 put it: `project_signal_level` high around Stage 3 surfaces a branch offer; the spine remains 主题探究.
6. **Template mimicry is a planned capability, not now.** Teachers uploading their own 周/月计划 templates for the agent to fill (枫's most concrete feature ask) is deferred: Phase 1 outputs a generic 周/月计划 format; upload lands with the file-upload surface and its child-data posture review.

Rollout is phased: this ADR (Phase 0) → prompt-only spike with blueprint as a markdown artifact, validated against the doc's five acceptance scenarios (Phase 1) → pilot measurement: turns-to-first-blueprint, questions/turn, %ai_suggestion vs confirmed (Phase 2) → schema hardening: `blueprint_delta` turn field, engine versioning, lens-gated harness rules with both-direction fixtures (Phase 3) → blueprint panel UI (Phase 4). Phases 1+ start after 锋's reworked Stage-1 doc and 枫's PPT are archived in `source-docs/` as faithful extractions.

## Consequences

- Teachers get a complete, revisable blueprint from minimal input; the interview happens *through* the artifact (thin modules visibly thin), not before it.
- Non-negotiable #1 survives by narrowing, not weakening: fabrication rules retarget to unmarked hypotheses and unearned `confirmed` escalations. Every new rule is dormancy-gated (fires only on `blueprint_delta` presence or planning lens), so existing flows, styles, and fixtures must pass byte-unchanged — any old fixture needing edits is a pollution finding.
- The 蓝图共创 response style folds away once the planning lens makes its directive the default; response styles stay prose-level persuasion (warn-only), never structural.
- `safeTemplate` needs a planning-lens variant — the current fallback asks for field facts, which in planning lens is itself the refusal defect.
- The quality question the old ration secretly answered — how much blueprint from how little input (the sweet spot) — is now open and empirical: PRD Open Question #6, answered in Phase 2.
- Full-blueprint-per-turn would blow the token budget (the doc does not cost this); Phase 3 must ship delta-based updates (`blueprint_delta`), not re-emission.

## Alternatives considered

- **Adopt the doc verbatim** (stored `interaction_mode`, trigger-phrase mode routing): brittle on mixed turns, duplicates `teacher_mode`, and makes mode a lock — rejected in favor of the derived lens.
- **Keep 资源意图三问 as a hard gate**: safest quality floor, but reinstates exactly one round of the 逐项过关 friction teachers rejected; marking + observation points carry the quality load instead.
- **Do nothing / styles only**: 蓝图共创 as an opt-in style leaves the base contract's 证据优先 wording fighting the blueprint (observed: partial effect) and fails the pilot's core complaint.
- **Jump straight to schema hardening**: rules and caps would be set with zero pilot data; the prompt spike is cheap and reversible, the schema is neither.
