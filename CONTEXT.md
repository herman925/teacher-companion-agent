# CONTEXT — the ubiquitous language

One page. Read this before you touch anything. Canonical bilingual terms live in [docs/glossary.json](docs/glossary.json) and are gate-enforced; this file explains what they *mean* to each other.

## The product in three sentences

A kindergarten teacher in 番禺 must build a theme-inquiry course around local culture. The **companion agent (陪跑智能体)** writes her a month of plan from a short conversation, shows it as a tree, and answers questions about any part of it. It never claims what children did unless a record says so.

## The nouns

| Term | What it is |
|---|---|
| **companion agent (陪跑智能体)** | The product. Not a chatbot, not an AI teacher. |
| **course state (`course_state`)** | The per-course state document. The deterministic engine writes it, never the model directly. |
| **plan tree (`course_plan`)** | The time projection: 月计划 → 周计划 → 活动. A phase of 2–5 weeks, then weeks, then activities that carry their own dates. **A day is a date on an activity, never a level.** This tree is also the theme map — there is no second diagram. |
| **blueprint (`course_plan_blueprint`)** | The content spine: what the course *is*, with per-node provenance. Derivation runs blueprint → plan, never back. |
| **node** | One item in either tree. Has a stable id (`3.2.1`), a provenance status, and a work status. |
| **skeleton** | One short row per plan node — titles and statuses only, no bodies — rendered as TSV into every prompt. |
| **subject** | The tag on every message saying what it is about: `course`, or a node id. Engine-owned; the model never chooses it. |
| **runtime harness (运行时护栏)** | Guards the *model* at run time. Three jobs only: scope shell, evidence and provenance, structural integrity. |
| **dev harness (开发护栏)** | Guards *this repository*: commit gate, glossary, bilingual parity, house style. Different thing. Do not confuse them. |
| **scope shell** | The boundary that refuses off-purpose requests before the model call. |
| **memory scopes** | Four: node, course, **class**, teacher. A class outlives a course. |
| **course story (课程故事)** | The Stage-5 export. Assembled from recorded evidence, never from invention. |

## The two status axes — never merge them

- **Provenance** — `confirmed` / `teacher_preset` / `ai_suggestion` / `hypothesis` / `pending_validation`. Answers *how sure are we this is true*.
- **Work status** — `draft` / `adjusting` / `needs_review` / `settled`. Answers *where is this in her process*.

Merging them lets "she is mid-edit" read as "not verified against children".

## Where truth lives

**The artifact is the memory, not the conversation.** Conversations are working surfaces. The plan tree and the memory stores persist. Anything decided in a turn and not written into state is lost.

Context never travels between conversations. Every conversation reads the same tree and writes to the same tree.

Storage and context are separate decisions. We **store** one subject-tagged message log per course. We **send** the model only what the current turn needs: its ancestor plans plus that node's recorded revision reasons.

## The four non-negotiables

1. **The agent never fabricates child evidence.** Any path that lets the model assert children's discoveries without a record is the highest-severity defect. This is the product's reason to exist.
2. **Strictness points at the model, never the teacher.** No teacher-facing form for any state field. Intake is conversational — **dynamic screening (动态识别)**.
3. **Culture stays backstage.** Adult slogans never appear in child-facing output.
4. **Child data is sensitive.** Mainland residency, minimal retention, scoped access.

A fifth, operational: **model keys never enter the repository.**

## What a turn does

1. The scope shell reads the incoming message. Off-purpose requests stop here, before any cost.
2. The engine assembles context in bands: rules, skeleton, focus, recent.
3. The **model adapter (模型适配层)** calls a provider. Output is always JSON, schema-enforced.
4. The runtime harness validates the turn. Violations trigger one regeneration, then a safe fallback.
5. The engine applies the delta. The model proposes; the engine decides.

## Serialization boundary

**TSV for repeated rows, JSON for everything else — and always JSON for model output.**

TSV renders row-shaped data into the prompt and out to analysts. Model output stays JSON because vendor schema enforcement has no TSV equivalent, and because a misaligned TSV column parses *successfully* with wrong values. A shifted column reading `hypothesis` as `confirmed` is precisely the failure non-negotiable #1 exists to stop, arriving with no error to catch.

Every TSV block: no empty cells (write `-`), no prose, ~8 columns, a version marker in the header.

## Rules that catch people out

- **The glossary is law.** Forbidden variants are blocking errors. To discuss a forbidden term, wrap it in `inline code`.
- **Docs are bilingual.** PRD and README twins are one unit, gate-checked for heading parity.
- **No guessing.** Never invent API behavior, pricing, or compliance details. Unknowns become recorded open questions.
- **The spec is upstream.** `source-docs/` is read-only. Deviations are deliberate, documented decisions.
- **New state must be observable and exportable.** Debug drawer, client export, admin export — answer all three before shipping it.
- **UI is verified by rendering.** "It compiled" is not verification.
- **A rule named after a retired mechanism is not necessarily part of that mechanism.** Read what a rule enforces before retiring it.

## Where to look next

| Question | File |
|---|---|
| How does a course get built, step by step? | [docs/WORKFLOW.md](docs/WORKFLOW.md) · [zh](docs/WORKFLOW.zh-CN.md) |
| What are we building and why? | [docs/PRD.md](docs/PRD.md) · [zh](docs/PRD.zh-CN.md) |
| Why is it like this? | [docs/adr/](docs/adr/) — 0003 blueprint-first · 0006 workbench · 0007 context · 0010 conversation model · 0011 memory · 0012 harness |
| How do I work here? | [AGENTS.md](AGENTS.md) |
| What happened last session? | [HANDOFF.md](HANDOFF.md) |
