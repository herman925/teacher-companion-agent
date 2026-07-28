# ADR-0006: Workbench-first delivery and the 月→周→日 plan tree

Date: 2026-07-29 · Status: accepted

## Context

Through ADR-0003 the conversation was the product and the blueprint panel was a render target: the model delivered planning content in `reply_markdown`, the engine absorbed `blueprint` artifacts into `course_state.course_plan_blueprint`, and the panel drew whatever landed there. The teacher read the plan in the panel but *worked* in the chat, addressing nodes indirectly through packed 批注 (`packBlueprintComments`).

The 2026-07-28 team meeting ([source-docs/20260728_Team Meeting.md](../../source-docs/20260728_Team%20Meeting.md)) inverted that. Two findings drove it:

1. **The node-scoped dialogue is the thing teachers cannot get elsewhere.** 陈栩锋 framed the differentiator, as a consensus reached with 林朝湃: the left side can behave like a 导师 much as any general assistant does, but the right side lets a teacher point at 活动方案 3.2.1 inside her own plan and get an answer 在特定的场域里面. His comparison was a visiting expert giving a lecture at a kindergarten — that expert will never 「因为某一个老师、某一个班级去特定地帮你把脉和诊断」. The panel plus the per-node dialogue is the moat; the chat alone is a commodity.
2. **A theme-inquiry plan is time-shaped, not module-shaped.** Teachers do not ask for 「模块四」; they ask for 「第二周」. The blueprint's module tree (五种组织形式, 环创, 家长信) is a *content* decomposition, correct for delivering the 预设包 but wrong as the spine a teacher navigates for the following month.

The meeting also settled layout. The floating-dialogue proposal — one full-screen workbench with a summonable chat bubble over it — was **Herman's**, raised precisely because if the workbench is the product then a 50/50 split wastes the thing being sold. 林朝湃's objection was about user acceptance rather than merit (「我不确定用户会不会接受」), and 陈栩锋 chose 「左右吧」. 冯浩然 predicted the real endpoint: some users will prefer each, so the eventual answer is a customizable layout. Resolution: build both, ship the split first, phone forced to one surface at a time.

## Decision

1. **The 工作台 is the deliverable; the chat is the editor bound to a selection.** Every turn now has a *subject*: either the whole course (the teacher typed into the free chat) or one node (the teacher opened it). The subject is engine-owned, derived from the UI selection, and passed to prompt assembly — the model never chooses its own subject and never writes it.

2. **The 左侧对话区 is scoped to the 教研员 role**: intake, course judgement, explaining *why* a plan node reads the way it does, giving activity guidance, and diagnosing a specific 活动方案. It stops being the primary surface for delivering plan bodies — plan content is delivered *into the tree*, and the chat says what changed and why.

3. **A `course_plan` tree becomes the navigable spine, alongside the blueprint, not replacing it.** Two trees with distinct jobs and one direction of derivation:

   - `course_plan_blueprint` (ADR-0003) remains the **content** mother object: what the course *is* — theme positioning, the five organization types, materials, 家长信, provenance per node. Unchanged.
   - `course_plan` is the **time** projection: `月计划 → 周计划 → 日计划/活动方案`. Its nodes carry a `blueprint_refs` array pointing at the blueprint nodes they realize.

   Derivation runs blueprint → plan, never the reverse. A plan node with no `blueprint_refs` is legal (a teacher can add an activity that was never preset) and renders as such; a blueprint node realized by no plan node is the tree's honest way of showing unscheduled content.

4. **Node ids encode hierarchy and are stable.** `m2`, `m2.1`, `m2.1.3` — the existing `normalizeBlueprint` id discipline extends to `course_plan`. Display numbering stays client-side and deterministic (`numberBlueprint`); the model never writes display numbers. This id shape is what makes the flat skeleton serialization in [ADR-0007](0007-tiered-context-and-change-propagation.md) reconstruct a tree without nesting.

5. **Every node carries a work status distinct from its provenance status.** `BLUEPRINT_STATUS` answers *how sure are we this is true* (`confirmed` / `teacher_preset` / `ai_suggestion` / `hypothesis` / `pending_validation`). The new `work_status` answers *where is this in the teacher's process* (`draft` / `adjusting` / `needs_review` / `settled`). Conflating them would let "the teacher is mid-edit" read as "unverified against children" — the two must not share a field.

6. **Opening a node offers 问 and 改 as distinct entries.** The meeting's design assumed a node is opened to modify it; teachers open nodes to *ask* at least as often. The node dialogue opens with both affordances visible rather than a guidance line that presumes intent, and the chosen intent is recorded on the turn — 问 turns must not produce a `plan_delta`.

7. **Layout for v1: left/right split retained.** Mobile: full-screen single pane with an explicit switch. Desktop: split, with a custom arrangement deferred. Floating dialogue is revisited on pilot feedback, not before.

## Consequences

- The unit of work becomes a node, which is what makes tiered context possible at all — a turn with a known subject can be given a small context. ADR-0007 depends on this decision.
- Two trees is real complexity, and the honest alternative (re-parent blueprint modules under 月计划) was rejected because the blueprint's五-organization-type structure is upstream content spine from `stage1-workflow-v1.0` — flattening it into a calendar would lose 枫's Stage-1 shape and make ADR-0004's engine-lit nodes unmatchable.
- `blueprint_refs` is the seam where the two trees can drift. A weekly plan citing a blueprint node that was later removed must degrade to a visible dangling reference, never a silent drop.
- Observability (AGENTS.md): `course_plan`, `work_status`, node-dialogue turns and their subject must all reach the debug drawer, the client session-log export, and the admin export. A node conversation that exists only inside the panel widget is a defect.
- The chat's demotion does not weaken the runtime harness: closure loop, evidence rules and stage gates apply to node-scoped turns identically. A short node answer still may not assert what children did.

## Open questions

- Does a 日计划 node exist in v1, or does 周计划 hold 活动方案 directly? The meeting said 月周日 but only ever demonstrated month → week → activity.
- When a teacher edits a plan node whose content came from a blueprint node, does the blueprint node follow? Current answer: no — the plan node's `blueprint_refs` gains a divergence marker and the blueprint stays as the record of what was preset.
