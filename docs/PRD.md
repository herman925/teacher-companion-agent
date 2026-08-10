# PRD — 小小探索家 Little Explorers: Preschool Theme-Inquiry Course Assistant

| | |
|---|---|
| **Version** | v2 — rewritten 2026-07-29 for Workflow v2. The v1 document is preserved at [PRD_old.md](PRD_old.md) |
| **Source** | [source-docs/20260728_Team Meeting.md](../source-docs/20260728_Team%20Meeting.md) (verbatim transcript) · [workflow-v1.3.zh-CN.md](../source-docs/workflow-v1.3.zh-CN.md) (stages 2+ still upstream) |
| **Behavior** | [WORKFLOW.md](WORKFLOW.md) / [WORKFLOW.zh-CN.md](WORKFLOW.zh-CN.md) |
| **Decisions** | [ADR-0003](adr/0003-blueprint-first-planning-lens.md) · [0006](adr/0006-workbench-first-plan-tree.md) · [0007](adr/0007-tiered-context-and-change-propagation.md) · [0008](adr/0008-v1-scope-amendment.md) · [0009](adr/0009-teacher-interaction-axes.md) · [0010](adr/0010-conversation-and-workbench-model.md) · [0011](adr/0011-memory-scopes-and-serialization.md) · [0012](adr/0012-runtime-harness-after-the-workflow.md) |
| **Chinese twin** | [PRD.zh-CN.md](PRD.zh-CN.md) — one unit, updated together |

## Problem Statement

A kindergarten teacher in 番禺 is asked to build a theme-inquiry course around local culture — 东乡龙舟, 醒狮, a nearby 祠堂. She has 20-plus children, a full teaching day, home visits, and a 月计划 due. What she needs is not ideas; it is a plan she can actually run, and someone to ask when it stops working on a Tuesday morning.

Four things make this hard today:

**General assistants are unreliable in a way that costs her.** They answer beautifully and inconsistently. Quality swings turn-to-turn, context is lost mid-conversation, and the teacher cannot tell a good answer from a confident wrong one. She is buying certainty and getting a lottery ticket.

**Nobody answers the question she actually has.** A visiting expert lectures the whole kindergarten; they will never look at *her* activity for *her* class and say what to change. Her question is never 「主题探究怎么做」 — it is 「周二这个活动会不会太难」.

**Tools add work instead of removing it.** At the experiment kindergarten's round table, after the 园长 approved the direction, a teacher said: 「最好分析批注都不要让我们写，你们要有个 AI 帮我来分析吧，因为我们的工作量太大了」. Anything that asks her to fill in forms, file reports, or feed information back will be abandoned.

**And the record has to be true.** A course story assembled from invented children's discoveries is worse than no course story: it is a lie about children, submitted upward as evidence of practice.

## Solution

A web companion that grows a whole month of plan from a short conversation, shows it as a tree she can read, and lets her tap any part of it to ask or change — with the record staying honest about what actually happened.

The shape, in one line: **she says what she wants, the agent generates the full plan in one pass, and after that she taps wherever she wants to talk.**

Four properties define it:

**Certainty over flexibility.** The product sells the green minibus, not the red one: fixed stops, predictable arrival, slower is fine. A teacher should be able to trust that the tenth plan is as good as the first.

**The artifact is the memory.** Conversations are working surfaces; the plan tree and the memory stores are what persists. Anything decided and not written into state is lost. Context never travels between conversations — every conversation reads and writes the same tree.

**Evidence gates claims about children, never planning.** The agent will preset an entire month without a single child having done anything. What it will not do is assert what children discovered, said, or learned without recorded evidence.

**The shell is the product boundary.** Inside it — preschool theme-inquiry course building — the model plays freely. Outside it, the tool declines, before the call is made.

## User Stories

### Intake and generation

1. As a teacher, I want to start by typing 「我想带中班的小朋友做东乡龙舟的主题探究活动」, so that I do not fill in a registration form before getting value.
2. As a teacher who does not know what to do yet, I want to pick 「帮我想想做什么」 and be asked first, so that a blank page is not the first thing I face.
3. As a teacher who already knows, I want to pick 「我已经有想法了」 and get a plan in the same turn, so that being prepared is rewarded rather than punished.
4. As a teacher, I want the agent to look up the resource itself — history, customs, what makes it distinctive — so that I do not have to research 龙舟 before I can plan it.
5. As a teacher, I want to be offered a few directions the theme could take, so that I choose between real options instead of inventing from nothing.
6. As a teacher, I want to be asked only about what the agent does not already know, so that I never answer the same question twice.
7. As a teacher, I want to answer in 大白话, so that I am not forced into the vocabulary of a curriculum document.
8. As a teacher, I want to be asked 「你希望一个月后孩子发生怎样的变化」, so that the plan is built toward what I actually care about.
9. As a teacher, I want the agent to start generating once it knows enough, so that I am not walked through a fixed number of rounds for their own sake.
10. As a teacher, I want one last confirmation before the plan is generated, so that a wrong assumption is caught before it becomes twenty activities.
11. As a teacher with more than one class, I want to be asked which class this course is for, so that the plan matches the right children.
12. As a teacher with only one class, I want to never be asked, so that the product does not make me confirm the obvious.
13. As a teacher, I want the whole month generated at once, so that I can see where this is going before I commit to it.
14. As a teacher, I want to be told why it was designed this way and what children might gain, so that I can defend the plan to my 园长 and to myself.

### The workbench

15. As a teacher, I want the plan as a tree of 月计划 → 周计划 → 活动, so that it matches how I already think about a month.
16. As a teacher, I want each activity to carry its date, so that I can see what falls on Tuesday without opening anything.
17. As a teacher, I want the tree to also be the theme network, so that I am not maintaining two pictures of the same course.
18. As a teacher, I want unscheduled deliverables — 环创方案, 材料清单, 家长信 — in the same tree, so that I can find the materials list on a Sunday night.
19. As a teacher, I want the workbench to be read-only, so that I never wonder whether tapping something changed my plan.
20. As a teacher on a phone, I want a list rather than a mind map, so that the plan is usable on the screen I actually carry.
21. As a teacher on a laptop, I want the map view as well, so that I can see the shape of the whole month at once.
22. As a teacher, I want to see which parts are 已确认 versus AI建议, so that I know what I have actually agreed to.
23. As a teacher, I want a node that needs re-checking to say so and say why, so that a warning is information rather than a chore.
24. As a teacher opening the app on the bus, I want to land where I left off, so that four minutes is enough to be useful.
25. As a teacher starting a brand-new course, I want the workbench to show what it will build, so that an empty right-hand panel does not read as a broken product.

### Node conversations

26. As a teacher, I want to tap activity 3.2.1 and talk about that activity, so that I do not have to describe which part of my own plan I mean.
27. As a teacher, I want the activity's plan and reasoning shown before I type, so that opening a node answers my question without a conversation.
28. As a teacher, I want a friendly opening line, so that the space does not feel like an empty room.
29. As a teacher, I want to ask a question without the agent assuming I want to change something, so that curiosity is not treated as dissatisfaction.
30. As a teacher, I want changes to appear in the tree as we talk, so that I can see the effect of what I just said.
31. As a teacher, I want a change that affects another week offered to me rather than applied silently, so that nothing moves while I am looking elsewhere.
32. As a teacher, I want to say 「这个可以」 and have it count as confirmation, so that agreeing does not require finding a button.
33. As a teacher, I want to see what my words just changed, with one tap to undo, so that a misunderstanding costs me a second.
34. As a teacher returning two weeks later, I want the node to still explain itself, so that I do not have to remember why I designed it that way.
35. As a teacher, I want unanswered questions to stay reachable, so that skipping one on the bus does not lose it forever.

### Memory

36. As a teacher, I want to say 「我们班没有鼓」 once, so that I never have to say it again.
37. As a teacher, I want that fact to still apply when I start a different theme with the same children, so that September does not begin with amnesia.
38. As a teacher, I want to see what the agent has remembered about my class, so that its behavior is explicable rather than mysterious.
39. As a teacher, I want to delete a fact it got wrong, so that one misunderstanding does not shape every future plan.
40. As a teacher, I want to be told the moment something is remembered, so that I can correct it while I still remember saying it.
41. As a teacher, I want to never fill in a form about my class, so that the tool keeps its promise about not adding work.
42. As a teacher, I want the agent to adapt to how I like to work, so that the tenth session feels different from the first.
43. As a teacher who prefers being handed one version, I want that rather than three options, so that the tool matches my working style rather than its own.
44. As a teacher, I want to adjust that myself if it guesses wrong, so that I am never stuck inside someone else's idea of me.

### The scope shell

45. As a teacher, I want the tool to say plainly when something is outside what it does, so that I am not given a confident wrong answer.
46. As a teacher asking about rain for an outdoor activity, I want a real answer, so that being on-topic is judged by what I am doing rather than which words I used.
47. As an operator, I want off-purpose requests declined before the model call, so that the budget is spent on teaching.
48. As an operator, I want to read what would have been declined before enforcement is switched on, so that the rule is validated against real teachers rather than guesses.
49. As an operator, I want a declined turn not to consume the teacher's quota, so that she is not charged for being told no.

### Platform and operations

50. As a teacher, I want my courses and history to persist, so that the companion improves as it comes to know my class.
51. As a teacher, I want to keep working when a search or a model call fails, so that an outage somewhere else does not end my planning session.
52. As an operator, I want every model call validated against the harness with violations logged, so that prompt regressions are visible rather than discovered by teachers.
53. As an operator, I want provider choice to be an ops decision, so that switching models is configuration rather than a rewrite.
54. As an operator, I want state stored as versioned snapshots per turn, so that corruption is recoverable and auditable.
55. As a 教研员 or 园长, I want to see how courses are actually being built, so that regional support goes where the difficulty is.
56. As the platform owner, I want child-related data to stay in-region with minimal retention, so that the pilot is defensible.

## Implementation Decisions

### Data model

**One message log per course, subject-tagged.** Storage stays one record per course. Every message carries a subject: `course`, or a node id. Opening a node renders its subject-tagged messages, which reads as a private conversation about that node. There is no thread object, so a node nobody has discussed has nothing — not an empty session, not a row in any list.

*Resolved 2026-07-29 (closes the former open question 7c).* 林朝湃 proposed a fresh zero-context dialogue per node click with prior conversation dropped. Adopted instead: **store one log, send only the minimum.** The two positions turned out to address different layers — his is a policy about what reaches the model, ours is about what is retained — and the tiered context bands below deliver his requirement exactly. Kept because one log preserves global ordering (we can prove the teacher asked about 3.2.1 *before* editing 周2, which a per-node clock cannot), keeps a course to one file for export and later regional aggregation, and avoids materializing ~18 empty dialogues for an 18-node blueprint. To be walked through with 林朝湃 and 陈栩锋; the storage decision does not depend on their agreement, the context policy already matches it.

**Two trees, one shown.** `course_plan_blueprint` remains the content spine with per-node provenance. `course_plan` is the time projection — 月计划 → 周计划 → 活动 — whose nodes carry `blueprint_refs` into the blueprint. Derivation runs blueprint → plan, never the reverse. The panel shows a single hierarchy: time nodes, then a 课程资料 branch for unscheduled deliverables.

**The root is a phase, labelled 月计划** — one continuous stretch of teaching, roughly 2–5 weeks, ignoring calendar boundaries. A longer course grows a second root.

**A day is a date on an activity, not a tree level.** 「今天要做什么」 is a filter. Rescheduling is one field, not a re-parent, so it does not read as a structural edit to the staleness rules.

**Node ids encode hierarchy and are stable.** Display numbering stays client-side and deterministic; the model never writes display numbers.

**Two status axes, never merged.** Provenance (`confirmed` / `teacher_preset` / `ai_suggestion` / `hypothesis` / `pending_validation`) answers *how sure are we this is true*. `work_status` (`draft` / `adjusting` / `needs_review` / `settled`) answers *where is this in her process*. Merging them would let "mid-edit" read as "unverified against children".

**Four memory scopes** — node, course, class, teacher — with a named class object distinct from the existing age-band field. Extraction defaults to course scope; widening to class or teacher is a deliberate teacher action.

### Context assembly

**Tiered by subject, engine-computed.** Four bands: rules (cache-stable prefix), skeleton (one row per plan node, titles only), focus (the subject node's body, ancestor summaries, sibling titles, its revision reasons), recent (a conversation window, narrowed for node turns). The model never selects its own band.

**Stored history is not sent history.** A node turn receives the ancestor plans and that node's recorded revision reasons — not the transcript that produced them. This is the guarantee that satisfies 林朝湃's requirement while keeping one log.

**TSV in, JSON out.** TSV renders the row-shaped bands (plan skeleton, memory, evidence index) and doubles as analytics export sidecars. Model output stays JSON: vendor schema enforcement has no TSV equivalent, and a misaligned TSV column parses *successfully* with wrong values — a shifted column reading `hypothesis` as `confirmed` is precisely the failure the product exists to prevent. TSV rules: no empty cells, no prose, ~8 columns, version marker in the header.

**Memory rides late and always.** Class and course facts sit in the volatile trailing section on every turn — never retrieved by relevance, because one retrieval miss reproduces the failure the class scope exists to prevent. Growth is bounded by merge and supersede, not compression.

**Change propagation marks, never recomputes.** An edit stamps descendants `stale_since` and surfaces 待复查 with the upstream reason; contradicted ancestors get `needs_review`. Provenance never auto-escalates or auto-clears. Regenerating descendants would silently overwrite teacher-confirmed work.

### The harness

**Three jobs, only three:** the scope shell, evidence and provenance, structural integrity. Inside the shell the model plays freely.

**The scope shell runs before the call.** Two signals — does the message touch her course, and is it a bare off-domain query — refusing only when the second is present and the first absent. Judged on purpose, not keywords: 「长沙今天天气怎么样」 is out, 「明天下雨的话周二那个户外龙舟活动怎么办」 is course work. A false block costs a user; a false pass costs one turn. Ships warn-only; enforcement follows a week of real logs.

**The stage gate was split, not retired.** Ordinal sanity and the evidence prerequisites for stages 2 and 5 remain — the latter are non-negotiable #1 expressed as a gate. Only the V1.3 artifact prerequisites lapsed. `node_prerequisite` lapsed in full.

**Confirmation requires a citation.** With the ✓确认 button removed, the model may escalate a node to `confirmed` only by quoting the teacher's words from that turn; an uncited escalation is stripped and logged.

### Storage and export

**Every new state is observable and exportable.** `course_plan`, `work_status`, subject tags, the four memory stores, the class list, scope verdicts and search reports each answer the same three questions: does the debug drawer see it, does the client export carry it, does the admin export carry it.

**Ops logs store excerpts, not conversation.** The scope log keeps a 60-character excerpt — enough to judge a false block, not enough to become a store of teacher conversation.

**Search is a step we run.** GLM/Z.AI standalone endpoint, our query, only during intake; every other provider reports the capability unavailable with a reason.

## Testing Decisions

**A good test here asserts external behavior at the highest available seam, and asserts both directions.** A rule that only ever fires is not a rule: every guard needs a fixture that trips it *and* a fixture that must sail through untouched. The must-pass fixture is usually the more important of the two, because a false block costs a user while a false trigger costs a turn.

**Preferred seams, in order.** Existing pure functions first — `engine.applyDelta` / `stageGateError`, `harness.validateTurn`, `prompt-builder.buildPromptParts`, `blueprint-util`, the `store` facade. One genuinely new seam: `plan-tsv.mjs`, pure in and pure out, with round-trip equality as a test rather than an assumption. Subject tagging, context bands, `plan_delta` and the new violation kinds all extend seams that already have coverage.

**Prior art to copy.** `demo/tests/runtime-harness.test.mjs` for both-direction rule fixtures; `demo/tests/adapter-timeout.test.mjs` for behavior that must fire on one condition and stay silent on another; `demo/tests/web-search.test.mjs` for a vendor contract pinned as a shape so a rename fails loudly; `demo/tests/scope-guard.test.mjs` for the must-pass discipline. `tests/integration/harness-line.test.mjs` remains the reference for dev-harness rules.

**Specific commitments.** Round-trip equality for the TSV converter, including cells that would break alignment. Staleness marking asserted to leave provenance untouched. Confirmation asserted to be stripped without a citation and preserved with one. The evidence gate asserted to still refuse stage 2 without child evidence and stage 5 without process evidence — the fixture that stops a future cleanup from deleting the product's reason to exist.

**Pollution guard.** Existing fixtures must pass byte-unchanged unless the ADR being implemented explicitly changes that behavior. A fixture that needs editing for any other reason is a finding, not a chore.

**UI is verified by rendering.** Any demo change is confirmed in a real browser before it is reported done.

## Out of Scope

- **Regional 教研 data warehouse and leader-facing analytics** — the second audience is the commercial driver but ships after v1. Its data model is *not* deferred: any aggregation touching child observations needs a compliance decision recorded as an ADR before collection starts.
- **主题预设网络图 as a separate artifact** — the plan tree is the theme network; there is no second diagram. The 资源深度网络图 is deleted outright.
- **`核心驱动问题` as required content** — reachable, never forced; 探究点 is enough.
- **Mandatory 回传** — unforced for the teacher, while the model-side evidence gate stays exactly as strict.
- **Voice input** — wanted, and it multiplies transcript length several-fold; it waits until the context measurement exists.
- **Web search for MiniMax, Kimi and the aggregators** — MiniMax has no search in its chat API, and Kimi's builtin is not wired.
- **Node conversations that create their own threads** — resolved above; there is no thread object to build.
- **Teacher-facing forms for any state field** — barred by the interaction thesis, not merely deprioritized.
- **AI image generation, WeChat Mini Program packaging, multi-teacher collaboration on one course, automated photo/audio analysis, fine-tuning.**

## Further Notes

**Blocked on other people, not on us.** The activity content schema (林朝湃 owns it; the node detail view waits on it). The complete six-fact intake list (陈栩锋's message to the group). Whether 月计划 is paperwork submitted on a monthly cycle — if it is, the phase root reopens. 冯浩然's token and cost measurement, which every context decision is provisional until.

**Build order.** The scope shell shipped first. Next is `course_plan` plus `plan-tsv.mjs` — pure modules with no visible output, chosen because they unblock the measurement that everything else waits on. Then memory scopes and the class object, then the read-only workbench and subject tagging, then the interaction axes.

**Measurement owed.** Prompt tokens per course turn and per node turn, cache-hit rate, cost per completed course, **cost per subject switch** (each subject carries its own scoped history, so switching starts a cold cache), and accuracy — whether the model's node references stay correct under TSV. Cheaper tokens with worse targeting is a bad trade that cost data alone would hide.

**A lesson worth keeping.** During this rewrite a decision recorded in an ADR — that `illegal_stage_jump` guarded nothing — turned out to be wrong, and following it would have deleted the evidence gate. A rule named after a retired mechanism is not necessarily part of that mechanism. Read what a rule enforces before retiring it.
