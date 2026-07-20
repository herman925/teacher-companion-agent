# ADR-0004: Engine-lit workflow nodes (computed lights on the 工作流地图)

Date: 2026-07-20 · Status: accepted

## Context

The debug drawer's 工作流地图 lights nodes solely from `state_delta.completed_nodes` — the model's own claim that it did the work. Two problems surfaced together on 2026-07-20:

1. The stage-1 redesign (source-docs/stage1-workflow-v1.0.zh-CN.md, blueprint-first) changed what the stage-1 nodes *are*. The catalog was still V1.3, so lights pointed at retired semantics (e.g. WF04 「预备资产网络」 never lit because no prompt mentions it).
2. A self-reported light is a fabrication channel: a node like 发掘幼儿已有相关知识 could "light" without any child evidence in state — the exact defect class non-negotiable 1 exists to kill, in miniature.

## Decision

- **Stage 0/1 node catalog re-derived** from stage1-workflow-v1.0. Ids stay stable (existing course states carry them in `completed_nodes`); only names/semantics re-bind. 核心驱动问题推导 leaves stage 1; the 1→2 stage gate keeps its evidence requirement but no longer demands a driving question.
- **Two light provenances.** Preset-artifact nodes — 蓝图一次性输出 (WF04a), 主题预设网络图 (WF04), 资源深度网络 (WF04b), 环境与计划 (WF08) — light **deterministically in `engine.absorbBlueprint`** from what the blueprint demonstrably contains (module id/title match). They are recorded in `course_state.engine_lit_nodes`, which is NOT in the delta whitelist — the model cannot write it. Child-evidence nodes (WF05–WF07b, WF09) stay model-claimed: their truth lives in conversation + 回传, which the engine cannot verify.
- **The map says which is which**: ⚙ engine-verified, ✓ model-claimed, plus a legend. A half-honest map without the distinction would be worse than either extreme.

## Consequences

- A blueprint that ships a 网络图 module lights WF04 even if the model forgets to claim it — matches the observed reality that holistic blueprint delivery IS the completion of those nodes.
- Module matching is heuristic (id/title regex on network/depth/plan keywords). A renamed module could miss; the failure mode is a missing ⚙ light, never a false one.
- Stages 2–5 remain V1.3 and model-claimed until upstream revises them; the same computed-light pattern can extend to any node that gains an observable state condition (e.g. WF09 once 回传 lands as `children_evidence`).
