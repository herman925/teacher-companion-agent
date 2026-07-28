# ADR-0012: What the runtime harness guards once the workflow chain is gone

Date: 2026-07-29 · Status: accepted · Amends [ADR-0011](0011-memory-scopes-and-serialization.md) §5

## Context

[ADR-0010](0010-conversation-and-workbench-model.md) recorded that V1.3's interlocking node chain largely disappears in v1. What it did **not** record is the other half of the same exchange, which the 2026-07-28 transcript makes explicit at 01:12:24–01:13:35: the chain goes, but a harness stays, deliberately, with a different job.

Herman: 「我觉得把它放弃掉是蛮现实的…可能我们也不能说放弃，我们弄一个去芜存菁的 harness，简易的把一些简单的规章，例如说上次浩然他用这个，联网去问哪里长沙的…那天气是什么，那种就还是要保护的…不是贴合工具本来原意的方式来使用我的工具…我们还是要保护我们的工具跟我们的个人财产，不然我们的钱都给他烧光了…我们就另外开发一套，只是把一些大方向它要拒绝掉，小的里面它在里面像小沙盒一样，就让他自己去玩。」 林朝湃 agreed.

Two things make this load-bearing rather than housekeeping:

1. **There is an observed failure, not a hypothetical.** 冯浩然 had already used the agent to ask, through web search, about the weather in Changsha. Every such turn burns tokens the team pays for, on a product that exists to build preschool theme-inquiry plans.
2. **The harness is the product boundary.** Herman put the challenge sharply earlier in the same meeting (25:00): 「我们跟对话型 ai 到底差别在哪？就只差在 harness 吗？…我们做的东西跟外面的什么豆包、那些火山全部都一样的话，我们只需要提供一个 prompt library 送给他们就。我不需要 harness，我只需要一个非常良好的提示词卖给别人就好了。」 Once generation is a general model behind good prompts, what stops this from *being* 豆包 is the shell around it.

Most existing rules, however, were built for the chain. Removing the chain leaves several of them guarding nothing.

## Decision

### 1. The runtime harness keeps three jobs, and only three

| Job | Why it survives |
|---|---|
| **Scope shell** | The tool is for building preschool theme-inquiry courses. Off-purpose use is rejected at the boundary. New in v2, and the reason this ADR exists. |
| **Evidence and provenance** | Non-negotiable #1 is untouched by any of this. Extended by the citation requirement for `confirmed` ([ADR-0010](0010-conversation-and-workbench-model.md) §6). |
| **Structural integrity** | The turn must parse, deltas must be well-formed, node ids must exist. Cheap, deterministic, and the difference between a bad turn and a corrupted plan. |

Inside those bounds the model plays freely — Herman's 小沙盒. The harness rejects 大方向, not phrasing.

### 2. Rules that lapse with the chain

`illegal_stage_jump` and `node_prerequisite` presuppose a state machine that gates progress. With progress no longer gated on 回传, they guard nothing and are retired rather than left to fire on flows that are now legal.

`closure_missing` / `closure_incomplete` weaken from blocking to advisory. [ADR-0008](0008-v1-scope-amendment.md) §3 made 回传 an invitation, so a turn that ends without 「回来请告诉我什么」 is no longer a defect. The closure loop remains good practice and stays measurable; it stops being enforceable.

Retained unchanged: `fabrication`, `adult_slogan` (non-negotiable #3 — culture stays backstage), `multi_question` and `question_no_examples` (the density and 动态识别 guardrails from [ADR-0003](0003-blueprint-first-planning-lens.md) §5), `bad_delta`, `contract_parse`, `blueprint_scope`.

New: `out_of_scope` (§3), `uncited_confirmation` ([ADR-0010](0010-conversation-and-workbench-model.md) §6), `memory_contradiction` ([ADR-0011](0011-memory-scopes-and-serialization.md) §5).

### 3. The scope shell runs BEFORE the call — and this is the one legitimate pre-send gate

[ADR-0011](0011-memory-scopes-and-serialization.md) §5 rejected a pre-send harness, correctly, for the case it examined: checking that the assembler included memory is checking our own code against itself, and there is no condition in the world to test.

The scope shell is the opposite case and the exception is principled:

- There **is** a real condition to test — the teacher's incoming message.
- Blocking after the response has already spent the money. Cost protection is the entire point, so a post-hoc check would defeat it.

So: an inbound scope check, cheap and deterministic, before a request is built. A refusal is a normal turn — plain, friendly, in the product's register, pointing back at what the tool does — never an error page.

### 4. Scope is judged on purpose, not keywords, and the boundary is not where it looks

This is the part that will break the product if we get it wrong, so it is stated as a rule rather than left to implementation taste.

- 「长沙今天天气怎么样」 — out of scope. No course, no class, no plan.
- 「明天下雨的话，周二那个户外龙舟活动怎么办」 — **in scope**, and about the weather. It is course work.

A naive keyword filter blocks the second, and a teacher who gets refused while doing her actual job will not come back. The check must therefore key on whether the turn is about *this teacher's course work*, not on topic words. Practical consequence: when in doubt, **let it through**. A false block costs a user; a false pass costs one turn of tokens.

Nothing about a course being early or thin makes a message out of scope — a teacher who has not started planning yet is still a teacher planning.

### 5. Mechanism is deliberately left open, with a stated default

Three candidate layers, and the honest position is that only the first saves money:

1. **Deterministic pre-filter** for the unambiguous — a bare weather/news/stock/translation/general-coding request with no course context in state and no course reference in the message. Free, instant, blocks the observed 长沙天气 case.
2. **Prompt-level scope statement** so the model declines in register when the pre-filter cannot decide. Costs a full call; buys good behavior, not savings.
3. **Post-response check** that the reply stayed in scope, feeding the existing regenerate path. Costs two calls; reserved for evidence of leakage.

Default: ship 1 and 2. Add 3 only on pilot evidence. A model-based inbound classifier is rejected for v1 — it turns every teacher message into two calls, which is the cost problem wearing a different hat.

### 6. Web search is in the blast radius

The observed failure went out over 联网搜索. That toggle is still a UI placeholder wired to nothing, so nothing is leaking today — but when it is wired, search must be reachable only for course-relevant retrieval (the 资源检索 in Workflow v2 phase B), never as a general query channel. This is the same boundary, one layer down, and it must land in the same change as the toggle.

## Consequences

- Every rule in §2 marked lapsed or weakened needs its fixtures revisited. Both directions, as always: a retired rule must stop firing on flows that are now legal, and the surviving rules must pass byte-unchanged. A fixture that needs editing to accommodate a *retired* rule is a signal the rule was doing something else too.
- The scope shell needs both-direction fixtures of its own from day one: 「长沙今天天气怎么样」 must be refused, and 「明天下雨的话周二那个户外活动怎么办」 must sail through untouched. The second fixture matters more than the first.
- Refusals are teacher-visible product surface, so their wording belongs in DESIGN.md §7 register, not in an error string.
- Cost protection becomes measurable: refused turns, and tokens not spent, both belong in the session log so the guard can be shown to be earning its place.
- This narrows the harness rather than dismantling it. If a future proposal reads 「工作流没有了，所以护栏也没有了」, point it here — the chain went, the shell stayed, and the shell is what distinguishes this from a prompt library.

## Open questions

- Where exactly does the pre-filter get its signal? Course state presence is a strong hint but a brand-new course legitimately has none.
- Does a refusal count as a turn in the transcript and the exports? It should be visible, but it did not produce a plan — probably an event, not a message.
- Rate limiting overlaps with cost protection ([ADR-0005](0005-per-account-key-vault-and-rate-limits.md)) and the two should not be built twice.
