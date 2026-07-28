# ADR-0008: V1 scope amendment — optional network map, optional driving question, unforced 回传

Date: 2026-07-29 · Status: accepted · Amends [ADR-0003](0003-blueprint-first-planning-lens.md), [ADR-0004](0004-engine-lit-workflow-nodes.md)

## Context

The 2026-07-28 meeting cut v1 scope in three places that the shipped code treats as required:

1. **主题预设网络图 is not mandatory in v1.** ADR-0003's acceptance amendment §1 makes it a Round-1 deliverable, and ADR-0004 lights `WF04` deterministically when a blueprint carries a network module. A v1 that does not always produce one leaves that light permanently dark and Round 1 permanently incomplete against its own spec.
2. **`核心驱动问题` is not forced.** ADR-0004 already moved its derivation out of stage 1 and dropped it from the 1→2 gate. The meeting went further: it comes out of the blueprint content spine too — 聚焦探究点即可, and a driving question may emerge later in conversation if the teacher wants one.
3. **回传 is not required.** The meeting's wording: 「不强制老师回流信息，重点观察提示可以简化」。

The third is the dangerous one. 「不强制回传」 is a statement about *teacher obligation*. Read carelessly, it becomes a statement about *model licence* — if nobody has to report what happened, the agent may be taken to have permission to write what probably happened. That reading would destroy non-negotiable #1, which is the product's reason to exist. This ADR exists as much to draw that line as to record the cuts.

## Decision

### 1. 主题预设网络图 becomes offered, not required

The network map moves from mandatory Round-1 artifact to a capability the agent offers when the theme is broad enough to benefit and the teacher wants it. Round 1's required deliverable narrows to: intent summary + extension, gap-covering card questions, and the theme positioning the plan tree is built on.

`WF04` stays in the node catalog and keeps its deterministic engine light (ADR-0004): when a blueprint *does* carry a network module, the light fires exactly as before. It simply stops being a node that every course must reach. The 工作流地图 legend gains an "optional in v1" mark so a dark `WF04` reads as *not requested* rather than *not done*.

### 2. `核心驱动问题` leaves the v1 content spine

Blueprints and plans are built around 探究点. No prompt asks for a driving question, no gate requires one, no artifact type demands one. The glossary term stays canonical (it is still the right name for the thing) and the capability stays reachable: if a teacher asks for one, or the conversation produces one, it is recorded normally. `WF`-node treatment matches §1 — retained, optional.

### 3. 回传 is unforced for the teacher, and the evidence gate is unchanged for the model

Stated as two separate rules because they are two separate things:

- **Teacher side.** No round blocks on a 回传. The `closure_loop` still names what would be useful to bring back (that is guidance, and teachers say they value it), but 「回来请告诉我什么」 is an invitation. A teacher who never reports anything must still get a complete, usable plan. Observation prompts simplify: fewer, shorter, tied to the activity in front of the teacher rather than to a reporting schedule.
- **Model side, unchanged and non-negotiable.** Every assertion about what children *did*, *said*, *discovered*, *were interested in*, or *learned* still requires recorded evidence. Removing the requirement to report removes a *source* of evidence — it does not lower the bar for claims. With fewer 回传 arriving, the correct behavior is *fewer realized-child-fact statements*, not the same statements with weaker grounding.
- **Therefore:** unmarked hypotheses and unearned `confirmed` escalations remain the highest-severity defect class. Planning content stays freely generatable (ADR-0003 §1); not-yet-happened child reactions stay marked 「预设·待现场验证」. A course that runs to completion with zero `children_evidence` entries is a legitimate outcome whose plan is entirely preset-provenance — and the export must show it that way.

### 4. Activity content schema is owned upstream

林博士 owns what a 活动方案 must contain. Until that lands, v1 uses the five-organization-type shape from `stage1-workflow-v1.0` unchanged. This ADR records the ownership so the schema does not get invented in a prompt file.

## Consequences

- ADR-0003's acceptance amendment §1 (two-round delivery) survives, with Round 1's required content narrowed. Round 2 (the full 预设包) is unchanged.
- ADR-0004's two-provenance light model survives intact; only the expectation that every course lights `WF04` is withdrawn. No code path that lights a node deterministically changes — the failure mode stays "missing light, never false light".
- Harness rules that assumed a driving question or a mandatory network map must be re-checked against a compliant fixture that has neither. Both directions, as always: the rule must fire on a violating fixture and stay silent on a compliant one.
- The fabrication rules need no weakening to accommodate any of this, and any future proposal that frames 「不强制回传」 as licence to assert should be pointed back at §3.
- Pilot risk to watch: with the network map optional and the driving question gone, a v1 course can be pedagogically thin without tripping any gate. The counterweight is 林博士's canon injection ([ADR-0009](0009-teacher-interaction-axes.md) §5) and the activity schema in §4, neither of which is a hard gate. If pilot plans read shallow, the answer is upstream content, not restored gates.
