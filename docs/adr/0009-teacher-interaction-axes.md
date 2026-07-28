# ADR-0009: Teacher interaction axes and cross-course teacher memory

Date: 2026-07-29 · Status: accepted

## Context

Response behavior is currently one choice from seven strings. `STYLE_DIRECTIVES` in `prompt-builder.mjs` maps a single `profile.stylePref` to a single directive sentence appended to the system prompt. 蓝图共创 is the default; the rest are alternatives. One selection, one axis, no memory of whether it fit.

The 2026-07-28 meeting produced a six-dimension framing (poster: [source-docs/assets/20260728-teacher-interaction-axes.png](../../source-docs/assets/20260728-teacher-interaction-axes.png)), with a stated purpose that is worth quoting because it constrains the design: 「不是给老师贴标签，而是帮助智能体根据行为习惯动态调整协作方式」, and four usage principles — 画像来自真实互动，不靠一次性判断；允许老师随时切换当次协作方式；后台判断稳定，前台表达灵活；目标不是统一老师，而是适配老师。

The same meeting asked for preferences that persist so that a teacher returning for a tenth session feels the agent has learned them. That requires state whose lifetime is the *teacher*, not the course — a scope the system does not currently have. `course_state` dies with the course; 教师档案 is read-only context the teacher fills in by hand.

## Decision

### 1. Six axes, scored, replacing the single style selector

| Axis | Low | Mid | High |
|---|---|---|---|
| 引导强度 | 直接执行 | 适度提醒 | 深度共创 |
| 结构化程度 | 自然交流 | 有结构 | 清单表格化 |
| 输出节奏 | 一次性完整输出 | 先框架后展开 | 逐步确认推进 |
| 解释深度 | 只看结论 | 结论＋简要理由 | 深入逻辑分析 |
| 智能体主动性 | 严格按输入 | 合理补全 | 主动提醒与挑战 |
| 方案开放度 | 明确方案 | 2–3 个选择 | 开放式共创 |

Each axis holds an integer 1–5 with a confidence value. Prompt assembly renders the vector into directive sentences the same way `STYLE_DIRECTIVES` renders one today — the model receives prose, never numbers, because a number in a prompt invites the model to reason about the scale instead of behaving.

The seven existing style presets survive as **named points in the six-dimensional space**, not as a parallel mechanism. 蓝图共创 is the default vector (low 引导强度, mid 结构化, low 输出节奏 — deliver whole then revise, mid 解释深度, mid 主动性, low 方案开放度). 极简速览 is another. This keeps every shipped fixture and every teacher's current setting meaningful after migration, and keeps the profile UI able to offer "pick a style" as the fast path.

### 2. Three inputs, ranked, and the teacher always wins

- **Onboarding**, three or four questions at most, producing a low-confidence starting vector. Not a questionnaire the teacher has to complete — skippable, and skipping yields the default vector.
- **Behavioral inference** from real interaction: shortening requests, "为什么这样设计" follow-ups, accepting versus rewriting delivered plans, asking for options versus asking for one answer. Each observation is a small nudge on one axis with a confidence increment. 画像来自真实互动，不靠一次性判断 — no single turn may move an axis more than one step, and inference never fires on the first turns of a session.
- **Explicit teacher control**: six handles in the profile, visible, labelled with the poster's own low/mid/high words. A teacher-set value pins the axis at full confidence and inference stops nudging it until the teacher unpins.

Precedence: explicit > inferred > onboarding > default. And per the poster's second principle, a teacher may override the vector **for one turn** (「这次直接给我一版就好」) without changing the stored profile — 后台判断稳定，前台表达灵活.

### 3. Teacher memory is cross-course; course memory is not

Split by lifetime, because the meeting's own success test (a tenth session that feels learned) fails if preferences reset per course:

| Store | Lifetime | Shape | Format |
|---|---|---|---|
| `teacher_profile` | the teacher, across every course | singleton, ~20 fields: the six axes with confidences, 地区／年段／教龄, entry-path preference (引导 vs 直接开工), tool familiarity | JSON |
| `interaction_signals` | the teacher, append-only | one row per observation: `turn_id, axis, signal, delta, at` | row-oriented (TSV/JSONL) |
| `course_state`, `course_plan`, `course_plan_blueprint` | one course | unchanged | JSON |

Format follows shape, not fashion: a single record with twenty distinct fields amortizes nothing under a header row, so `teacher_profile` stays JSON and keeps its validation; the signal log is hundreds of homogeneous rows, which is exactly where a header-once table pays ([ADR-0007](0007-tiered-context-and-change-propagation.md) §2). The rule for the codebase: **TSV for repeated rows, JSON for singleton records.**

The axis vector enters the prompt as rendered prose. The signal log never does — it is derivation input and audit trail, not context.

### 4. Observability

`teacher_profile` and `interaction_signals` are new state and carry the AGENTS.md obligation in full: visible in the debug drawer (including *which* signal moved *which* axis, so an inference that feels wrong is diagnosable rather than mysterious), carried by the client session-log export, and carried by the admin export. A teacher must be able to see the current vector and why it is where it is — an agent that quietly profiles its user and cannot show its work is a trust defect regardless of accuracy.

Data posture: these are teacher-behavioral records, not child records, so non-negotiable #4 does not bind them directly. They are still personal data — same residency and retention posture as the rest of the account, and no third party receives them.

### 5. Pedagogy canon precedence

林博士's condensation of 叶老师's deep-learning principles (≤10 sentences) enters the system prompt as the **governing** pedagogy. On conflict with the model's own training — mainstream Western early-childhood research — the injected canon wins, and the agent is instructed to reason from it rather than average the two. Assumption on the record: these principles are within what a competent model already understands, so injection shapes emphasis rather than teaching new content. If pilot output shows the model cannot act on a principle it does not natively hold, that principle needs worked examples, not more sentences.

The canon governs pedagogy. It does not override the runtime harness: no principle, however framed, licenses asserting child facts without evidence.

## Consequences

- `STYLE_DIRECTIVES` becomes a preset table over the vector rather than the mechanism itself. Migration must leave existing profiles behaving identically — a teacher on 极简速览 sees no change until they touch a handle.
- Six axes multiply the prompt-behavior surface: the harness can no longer assume one style shape when checking density or closure rules. Rule fixtures need at least the default vector and one extreme.
- Inference can be wrong, and wrong inference degrades trust faster than no inference. Confidence gating, the one-step-per-observation cap, and visible provenance in the drawer are the mitigations; if pilots still report drift, inference ships off by default and the handles ship alone.
- Cross-course teacher state is the first store whose lifetime exceeds a course. On the no-backend static tier it lives in localStorage and does not follow the teacher across devices — a real limitation to state plainly in the UI rather than paper over.

## Open questions

- Which behavioral signals are reliable enough to act on? Rewriting a delivered plan could mean 方案开放度 is too low, or simply that the plan was wrong.
- Does the entry-path preference (引导 vs 直接开工) belong on the 引导强度 axis rather than as its own field?
- How does a second teacher in the same kindergarten inherit anything useful, or is every teacher cold-started?
