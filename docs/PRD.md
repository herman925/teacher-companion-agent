# PRD — 小小探索家 Little Explorers: Preschool Theme-Inquiry Course Assistant
## AI Theme-Inquiry Companion for Kindergarten Teachers (番禺幼教AI主题探究陪跑智能体)

Formerly the working title "China Teacher Resources Development Platform"; renamed 2026-07-16.

| | |
|---|---|
| **Status** | Draft v0.1 |
| **Source spec** | [workflow-v1.3.zh-CN.md](../source-docs/workflow-v1.3.zh-CN.md) (《番禺幼教AI主题探究陪跑智能体集成工作流 V1.3（标注版/锋改）》) |
| **Chinese version** | [PRD.zh-CN.md](./PRD.zh-CN.md) |
| **Owner** | Herman |
| **Last updated** | 2026-07-05 |

---

## 1. Problem Statement

Kindergarten teachers in Panyu (番禺) are asked to run **theme-inquiry / project-based inquiry courses around local cultural resources** (龙舟 dragon boats, 趁墟 market fairs, 祠堂 ancestral halls, 醒狮 lion dance…). Doing this well requires a demanding loop: understand why you chose the resource, translate it into entry points children can genuinely experience, harvest children's real questions, derive a driving question, set a goals/assessment axis, run multi-round action cycles that respond to what children actually did, and finally distill an evidence-backed **course story (课程故事)**.

Most teachers cannot sustain this loop alone. Generic chatbots fail them in two opposite ways:

1. **Fabrication** — a vanilla LLM happily invents children's interests, questions, and progress, producing polished-but-fake curriculum documents with no evidence value.
2. **Form-filling rigidity** — a naive implementation of the V1.3 workflow spec (which is written as tables, templates, and a state machine) turns the assistant into a bureaucratic wizard: a fixed interrogation of fields before anything useful happens. Teachers experience it as *filling in forms for the bot*, not being accompanied by a coach.

The core product problem: **be as strict as the spec demands — but aim the strictness at the model, not at the teacher.**

## 2. Product Vision

A web-based **companion (陪跑) chat platform** where a teacher talks naturally about their class and their resource, and the agent:

- **Recognizes where the teacher is** (five entry modes: from-zero / optimize-existing / mid-course feedback / story export / material support) instead of making them declare it;
- **Elicits adaptively** — one focused question at a time, always with concrete example answers, never asking for something it can already infer from the conversation or stored state;
- **Refuses to fabricate** — without child evidence it only offers "possible directions" plus a next evidence-gathering task;
- **Ends every round with the fixed closure loop**: what you can go do → what materials I suggest → what to bring back → what I'll do with it;
- **Waits for reality** — between action rounds, the agent pauses until the teacher returns with real classroom feedback, then adjusts the path;
- **Remembers** — accounts, per-course `course_state`, chat history, and (later) vectorized teacher profiles make round N+1 smarter than round N.

The V1.3 spec is the **behavioral contract**; the platform's job is to honor it invisibly. The teacher should feel a knowledgeable colleague; the state machine should live entirely backstage.

## 3. Users & Personas

| Persona | Description | Primary needs |
|---|---|---|
| **P1 — 一线教师 Frontline teacher** (primary) | Kindergarten teacher, mixed digital literacy, 15–30 min sessions between classroom duties, mobile or desktop web | Fast entry, low typing burden, concrete tasks, materials she can print/use tomorrow, help with 课程故事 writing |
| **P2 — 教研员/园长 Teaching-research lead / principal** | Reviews courses across classes, cares about evidence quality and cultural-education value | Course story exports (园本汇报 / 区级 / 申报 / 公众号 versions), visibility into course progression |
| **P3 — 平台运营/研发 Platform operator** (us) | Maintains prompts, harness rules, model adapters | Observability of rule violations, model comparison, prompt iteration without redeploys |

## 4. The Core Interaction Thesis: Dynamic Screening, Not Form-Filling

This section is the heart of the PRD. The V1.3 spec itself already gestures at this (WF03b's three questions must each carry examples; WF20d requires the agent to draft 2–3 context-fitted example answers *before* asking the teacher's third focus sentence). We generalize it into a platform-wide interaction contract:

### 4.1 The Screening Contract (adapted from grill-style interviewing)

1. **Read before asking.** Every turn begins by reading `course_state` + conversation history. Anything already known or confidently inferable is *never* asked again. (Spec principle: 状态机优先.)
2. **One question at a time.** The agent asks at most one focused question per turn during intake/elicitation, and explains in one clause *why* it's asking.
3. **Always offer a recommended answer.** Every question ships with 2–3 concrete, context-fitted example answers the teacher can tap or adapt — never a blank field. (Generalizes WF03b 每问带例子 and WF20d 先给示例.)
4. **Accept mess, extract structure.** Teachers answer in natural language, voice-note style, or photos of a question wall. The agent extracts state fields from messy input; the teacher is never shown a schema.
5. **Infer entry, confirm cheaply.** WF01 entry recognition is a *classification the agent performs*, surfaced as a one-tap confirmation ("听起来你已经带着孩子做过一轮了，我们接着上次的进度聊？"), not a menu the teacher must decode.
6. **Skip satisfied gates silently.** If the teacher's first message already contains resource intent + class profile, the agent jumps straight to the 切口卡 draft. Stage gates are checked, not performed.
7. **Escape hatches everywhere.** "先跳过 / 我不确定 / 你先给个初稿" are always valid answers; the agent marks the field 待现场确认 and moves on (as WF03b specifies).

### 4.2 What stays strict (aimed at the model)

The runtime harness (§7) enforces, per turn:

- **Evidence-first**: no claims about children's discoveries/understanding/feelings without recorded evidence in `children_evidence`; violations are blocked and regenerated.
- **Culture stays backstage**: cultural threads appear only as teacher-facing hints, each translated into a child-actionable micro-task; adult slogans (传承精神/文化责任 as child goals) are lint failures.
- **Closure loop present**: every round-ending message must contain the four closure elements (做什么/用什么素材/回来告诉我什么/我会继续帮什么).
- **Stage-gate legality**: the agent cannot enter Stage 2 (goals axis) without child evidence; cannot output a long project plan while gates are unmet; cannot fabricate cycle progress while `awaiting_feedback`.
- **No blanket projects**: 适配性筛查 (theme-fit screening) must precede any project-scale plan; short-activity themes get lightweight plans only.

## 5. Scope

### 5.1 In scope (this phase)

1. **Bilingual PRD** (this document + PRD.zh-CN.md).
2. **Development harness** — repo governance adapted from the Hualong Platform harness (gates, glossary consistency, structure checks) plus project-specific checks (course_state schema validation, prompt-rule lint).
3. **Architecture & API exploration** — documented evaluation of MiniMax (default), GLM & Kimi (fallback), Qwen (exploratory); Tencent CloudBase as leading backend candidate.
4. **Web demo of the minimal loop** (spec §7): resource input → WF03b three-question intake (as conversation) → 资源课程化切口卡 → fit screening → one experience task + interview card → teacher feedback intake (incl. 三类儿童观察 + 三句聚焦反馈) → child question pool + cultural-possibility hints → candidate driving questions → one action cycle → course-story fragment. HTML + TypeScript, GSAP-animated, runtime harness active, pluggable model adapter.
5. **DESIGN.md** — semantic design system for the demo UI.

### 5.2 Out of scope (deferred)

- **AI image generation / drawing** (环创图式, poster art) — text scaffolds only for now.
- WeChat Mini Program packaging (web-first; MP later if pilot demands).
- Real account system in the demo (demo uses local storage; CloudBase auth is designed, not built).
- Multi-teacher collaboration on one course; admin dashboards.
- Automated photo/audio analysis of child evidence (teacher describes; upload-and-store only).
- Fine-tuning; we work prompt-side only.

## 6. User Stories

**Intake & screening**
1. As a teacher, I want to start by just saying "我想带孩子做龙舟" and have the agent figure out what to ask next, so that I don't fill in a registration form before getting value.
2. As a teacher returning mid-course, I want the agent to recognize me and resume from my course state, so that I never re-explain my class.
3. As a teacher who can't answer "为什么想做这个资源", I want selectable candidate intents with the option 待现场确认, so that uncertainty doesn't block me.
4. As a teacher, I want every question to come with tappable example answers, so that answering takes seconds on my phone.

**Stage 0–1 (intent, fit, experience, questions)**
5. As a teacher, I want a 资源课程化切口卡 generated from my answers, so that I can see child entry points instead of adult knowledge points.
6. As a teacher, I want an honest 适配性筛查 (short activity vs theme inquiry vs project potential), so that I don't over-build a project the theme can't carry.
7. As a teacher, I want a first-experience plan with observation points and an interview card (3 child questions + 3 adult follow-ups), so that the first outing produces usable evidence.
8. As a teacher, I want to dump children's raw utterances/photos after the activity and get back a categorized question pool with adult-phrasing stripped out, so that real child questions drive the course.
9. As a teacher, I want cultural-possibility hints attached to child questions *as backstage notes with child-sized tasks*, so that culture deepens without sloganeering.

**Stage 2–3 (goals, cycles)**
10. As a teacher, I want 2–3 candidate driving questions scored on 儿童性/真实性/行动性/公共性/文化可能性, so that I pick with judgment, not from scratch.
11. As a teacher, I want the goals axis (core understanding, four-dimension goals, cultural goal ladder, GRASPS) drafted for confirmation, so that assessment thinking doesn't require a workshop.
12. As a teacher, I want each action round to end with the closure loop, so that I always know what to do and what to bring back.
13. As a teacher, I want the agent to *wait* for my real feedback instead of writing round 2 fiction, so that the record stays true.
14. As a teacher, I want to report 三类儿童观察 and 三句聚焦反馈 with agent-drafted examples for the third sentence, so that focused reflection takes 3 minutes.
15. As a teacher, I want the agent to answer *my* stated question-to-judge first in its analysis, so that I feel heard rather than processed.
16. As a teacher, I want stuck points (卡壳) turned into next-round inquiry tasks, so that failure becomes curriculum.
17. As a teacher, I want project-signal alerts (项目化探究信号) only when ≥3 signals accumulate, so that scale grows from evidence.

**Stage 4–5 (delivery, story)**
18. As a teacher, I want delivery prep where children present with their own words/works, so that showcases aren't recitals.
19. As a teacher, I want a materials-gap check before story export, so that gaps get filled cheaply instead of papered over.
20. As a teacher, I want the course story drafted from actual cycle history in true chronological messiness, so that it reads as real practice, not backwards-written perfection.
21. As a teacher/principal, I want multi-version export (完整案例/汇报摘要/申报/公众号), so that one course serves many audiences.

**Platform**
22. As a teacher, I want an account with my chat and course history, so that the companion improves as it knows my class.
23. As a platform operator, I want every model call validated against harness rules with violations logged, so that prompt regressions are visible.
24. As a platform operator, I want a provider-agnostic adapter (MiniMax default; GLM/Kimi fallback; Qwen behind a flag), so that model choice is an ops decision, not a rewrite.
25. As a platform operator, I want course_state stored as versioned snapshots per turn, so that state corruption is recoverable and auditable.

## 7. System Requirements

### 7.1 The state machine (from spec §2, normative)

- `course_state` with fields: `course_id`, `teacher_mode`, `class_profile`, `theme_resource`, `teacher_resource_intent`, `resource_entry_card`, `theme_fit_level`, `children_evidence`, `child_question_pool`, `driving_question`, `goals_assessment_axis`, `cycle_history`, `child_learning_stage`, `project_signal_level`, `story_materials`, `child_participation_difference`, `teacher_focus_feedback` — plus platform fields `stage`, `completed_nodes`, `awaiting_feedback`, `pending_confirmations`, `schema_version`.
- Stage transitions follow spec §2's 流转规则 (e.g., no Stage 2 without child evidence; Stage 5 gap-check before export). Transitions are computed by a **deterministic engine**, not by the LLM: the LLM proposes state deltas; the engine validates and applies them.
- JSON Schema for `course_state` lives in `harness/schema/course-state.schema.json` and is the single source of truth for demo, docs, and prompt templates.

### 7.2 Runtime harness (LLM governance)

Layered defense, cheapest first:

| Layer | Mechanism | Catches |
|---|---|---|
| L1 System prompt | Spec §1 principles + §6 prohibitions compiled into the system prompt; per-stage prompt modules (spec §4 cycle prompts) | Most violations, by construction |
| L2 Structured output | Model must return `{reply_markdown, state_delta, closure_loop, evidence_refs}` via JSON mode/tool call | Missing closure loop, malformed state |
| L3 Deterministic validators | Post-generation checks: closure-loop completeness; stage-gate legality of `state_delta`; fabrication heuristics (child-claims without `evidence_refs`); adult-slogan lexicon scan on child-facing tasks | Rule violations that slip L1/L2 |
| L4 Regenerate-with-feedback | On L3 failure: one retry with violation report injected; on second failure: degrade to safe template + log | Persistent violations |

Violation logs are a first-class artifact (P3's observability).

### 7.3 Model adapter

- OpenAI-compatible chat-completions client; provider registry: **MiniMax (default) → GLM → Kimi** failover chain; **Qwen** behind an evaluation flag.
- Requirements per provider: SSE streaming, JSON/tool-calling mode, system-prompt adherence in zh-CN. Findings recorded in [MODEL-APIS.md](./MODEL-APIS.md).
- Demo: key entered client-side (localStorage, never committed). Production: keys live in CloudBase functions only.

### 7.4 Backend (design target: Tencent CloudBase)

- Web SPA (static hosting) + CloudBase auth (phone/WeChat) + document DB collections: `users`, `courses` (course_state + snapshots), `messages`, `materials`, `violations`.
- Cloud function as LLM proxy (keys server-side, SSE pass-through), harness validators run server-side in the same function.
- **Personalization roadmap**: v1 — structured profile (region, grade band, class size, resource repertoire, style preferences) injected into prompts; v2 — embeddings over teacher's course/chat corpus for retrieval-augmented personalization (candidate: Tencent VectorDB or in-DB embedding fields); full-chat-history vectorization explicitly *later*.
- Details and verified capabilities in [ARCHITECTURE.md](./ARCHITECTURE.md).

### 7.5 Non-functional

- **Language**: product UI and agent output in Simplified Chinese; codebase/docs bilingual with EN primary for engineering docs.
- **Latency**: first streamed token < 3s p50 on MiniMax; closure-loop validation adds < 150ms.
- **Truthfulness**: zero tolerance for fabricated child evidence in validated output (L3 blocks; measured via violation log).
- **Compliance**: mainland-hosted data; regulated (备案) models only; minors' data minimization — the platform stores teacher observations, and uploads are teacher-mediated; PIPL notes in ARCHITECTURE.md.
- **Cost ceiling (pilot)**: ~50 teachers, target < ¥500/month model spend at default model.

## 8. Demo Acceptance Criteria (this iteration)

1. Opening a static page, entering an API key, and typing "我想带中班孩子做醒狮" yields: entry recognition (silent), WF03b conversation with per-question examples, and a rendered 切口卡 — with **no form UI anywhere**.
2. Declining to answer ("不知道，你帮我想") still produces a 切口卡 with 待现场确认 marks.
3. Asking for a full project plan before evidence exists is *courteously refused* with a next-evidence task (L3 gate demonstrably fires — visible in a debug drawer).
4. Submitting mock teacher feedback (原话 + 卡点 + 三类观察 + 三句聚焦) advances the cycle; the reply addresses the teacher's third focus sentence *first*.
5. Every round-ending agent message renders the four-part closure loop as a distinct visual component.
6. A debug drawer shows: current stage, state diff per turn, gate checks passed/failed, provider used. (Strictness visible to us, invisible to teachers.)
7. Provider switch MiniMax → GLM via config without code change.
8. Page verified in a real browser (per repo verification norms), animations via GSAP, design conforming to demo/DESIGN.md.

## 9. Metrics (pilot)

- **Anti-form-filling**: median questions asked before first valuable artifact (切口卡) ≤ 4; % of intake questions answered via tapped examples ≥ 50%.
- **Truthfulness**: L3 violation rate per 100 turns (target < 2 after prompt iteration); fabrication class = 0 escaping to teacher.
- **Companionship**: % of courses with ≥2 completed feedback round-trips (the product's whole premise) ≥ 60% of started courses.
- **Story value**: % of Stage-5 exports rated usable by 教研员 without structural rework.

## 10. Open Questions

1. Voice input for teacher feedback (huge for classroom reality) — which iteration?
2. Photo evidence: store-only vs. OCR/描述 assist — compliance review needed before any model sees child photos.
3. 八乡资料 / local culture knowledge base: static curated corpus first, or RAG from day one?
4. Does the pilot need 教研员 accounts (read-only course view) in v1?
5. Exact MiniMax/GLM/Kimi model SKUs and JSON-mode reliability — pending [MODEL-APIS.md](./MODEL-APIS.md) research.
6. 预设/生成 rebalance (upstream proposal [workflow-v1.3-contradictions](../source-docs/workflow-v1.3-contradictions.zh-CN.md) + pilot-teacher feedback): how much complete blueprint to generate from how little input — the "sweet spot" between elicit-more-first and always-generate is an empirical question for a prompt-level spike, not a design debate. Adoption of the proposal (dual scenes, blueprint mother object, soft state machine) awaits an ADR.

## 11. Glossary Anchors

Canonical bilingual terms live in [glossary.json](./glossary.json) and are enforced by the harness glossary check. Key pairs: 陪跑 companion coaching · 资源课程化切口卡 resource-to-curriculum entry card · 主题适配性筛查 theme-fit screening · 儿童问题池 child question pool · 核心驱动问题 driving question · 文化目标阶梯 cultural goal ladder · 卡壳复盘 stuck-point retrospective · 三类儿童观察 three-profile child observation · 三句聚焦反馈 three-sentence focus feedback · 课程故事 course story · 输出闭环 closure loop.
