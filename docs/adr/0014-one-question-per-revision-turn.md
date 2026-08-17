# ADR-0014: One question per revision turn

Date: 2026-08-17 · Status: accepted · Amends [ADR-0012](0012-runtime-harness-after-the-workflow.md) §1

## Context

The first long live session against a real model (MiniMax, 中秋 theme, an authenticated teacher account) produced a good plan tree and then stalled on it. The teacher redirected the theme — 「不要發明精靈了，要不是跟精靈做朋友的主題月？」 — and the agent answered with a well-reasoned paragraph and a question card. She answered it. The agent produced another paragraph and another question card. Three turns passed with the tree untouched.

Nothing in the harness objected, and nothing should have under the rules as they stood: every card was complete, the count was far below the warn threshold of 5, and the caution in the second turn was the confirmation rule doing its job (rewriting p3 and p4 without her explicit yes would have been the agent deciding for her).

Herman, watching it:

> 我覺得在用戶追加問題、想要修改藍圖的時候，我想要給 Harness 一點點限制：它最多隻能追問用戶一題，不能超過一題。一題之後如果用戶回答了，無論答案是清晰、混亂還是有的沒的，你都要直接讓提示去生成下一步的藍圖，反正不合心意的用戶自己會修改。

The insight is about **where the cost of being wrong sits**, and it changes with the artifact:

- **During intake there is no artifact.** A question is the only way the model learns the class, and a wrong assumption propagates into everything built afterwards. Asking is cheap; guessing is expensive. This is why the card count was deliberately left uncapped ([ADR-0003](0003-blueprint-first-planning-lens.md) §5, DESIGN.md §4).
- **During revision there is a tree in front of her.** A wrong node costs her one click — she opens it and says what to change. A question she has already answered costs her an entire round-trip, and reads as not listening. Asking is now the expensive move and guessing is the cheap one.

The same rule cannot serve both. So the cap is asymmetric, and the thing that flips it is whether a plan tree exists.

## Decision

### 1. Once the plan tree has a node, a turn may ask at most one question

Two blocking rules in `demo/src/harness.mjs` (L3), both dormant while `state.course_plan` is empty:

| Rule | Fires when | Action |
|---|---|---|
| `revision_question_cap` | a plan exists and the turn carries more than one question card | block |
| `revision_asked_twice` | a plan exists, the previous agent turn asked, and this turn asks again **without writing a delta** | block |

Blocking means an L4 retry with the reason, not a dropped turn.

### 2. Asking while also moving the tree stays legal

`revision_asked_twice` requires *no* `plan_delta` and *no* `blueprint_delta`. 边改边确认 — proposing a version and asking whether it landed right — is how a revision round should read, and banning it would push the model toward silent guessing, which is worse. What is banned is a turn that only asks.

### 3. A vague answer is not grounds for a second question

This is the half that carries Herman's 「无论答案是清晰、混乱还是有的没的」. When her answer leaves the model short, it writes a version anyway, hedged with 可能／预计 and marked 预设，待现场验证, and lets her correct it on the tree. The escape hatches in the 动态识别契约 already say this for intake (「先跳过」「我不确定」「你先给个初稿」 are legal answers); this extends the same posture to revision, where it matters more.

### 4. `askedLastTurn` is read from the record, not from the model

`serve.mjs` derives it from the previous agent message's stored `turn_contract.questions`, not from the rendered prose and not from anything the model self-reports. A question mark in a sentence is not a card; a card is what she can answer. A model asked to remember how many times it has asked will simply be wrong.

### 5. This adds a fourth job to the runtime harness

[ADR-0012](0012-runtime-harness-after-the-workflow.md) §1 says the harness keeps three jobs **and only three**: the scope shell, evidence and provenance, structural integrity. This rule is none of them. It is an interaction-economy rule — it constrains how many round-trips the model may spend before delivering.

Recorded plainly rather than filed under structural integrity, because pretending it fits an existing category is how a boundary quietly stops meaning anything. The 小沙盒 principle is unchanged in spirit: inside the shell the model still plays freely, and this rule polices pacing, never content. But the fence moved, and ADR-0012 §1 should be read as three jobs plus this one.

The rule still points at the model and never at the teacher (non-negotiable #2). She may ask as many questions as she likes, in any order, and change her mind about all of them.

## Consequences

**Good.** A revision round is one exchange, not three. The tree moves every turn it can. The model stops treating an ambiguous answer as a reason to stall.

**Risk we accept.** The model will sometimes propose from too little and get it wrong. That is the deliberate trade: a wrong node is one click from being right, and it is visible, whereas a question is invisible work the teacher performs for us. `预设，待现场验证` is what makes the wrong version honest rather than a claim.

**Risk we do not yet know the size of.** Whether one question is enough to aim with, in practice, on a real revision. Pilot data settles it — the session log records per-card answered/skipped, and `revision_question_cap` / `revision_asked_twice` hits are recorded in `gate_report`, so a model that keeps hitting the cap is visible rather than merely obedient.

**Untouched.** The intake keeps its uncapped count and its >5 warn. The confirmation rule ([ADR-0010](0010-conversation-and-workbench-model.md) §6) is untouched and takes precedence: a turn that must ask before rewriting confirmed content is still right to ask, and that ask is the one question it gets.

## Rolling this back

Recorded because Herman asked for it explicitly at the time of the change: this is a behavioural rule tuned on one session's evidence, and if pilot data disagrees it should come out cleanly.

- **Soften without removing:** change `action: 'block'` to `'warn'` on either rule in `demo/src/harness.mjs` rule 2c. The rule then records without retrying, and the session log keeps measuring — the right first step if the cap is firing on legitimate turns.
- **Raise the cap:** the `> 1` in `revision_question_cap` is the only number. Two questions per revision turn is a one-character change.
- **Remove entirely:** delete rule 2c from `harness.mjs`, the `askedLastTurn` derivation in `serve.mjs`, rule 8 from `demo/src/prompts/base.zh.md`, and the revision paragraph in `demo/DESIGN.md` §4. The fixtures in `demo/tests/question-cards.test.mjs` (the block six under 「one follow-up once a plan exists」) go with it. Nothing else depends on it; no state, no migration, no stored data carries this shape.
- **What to watch before deciding:** the rate of `revision_question_cap` in `gate_report` against how often a revision round still needs a second exchange. A cap that never fires is either working or unnecessary, and only the round count tells you which.
