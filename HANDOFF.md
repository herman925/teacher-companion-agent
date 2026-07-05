# HANDOFF

Latest session first. Keep entries short and factual; link instead of restating.

## 2026-07-05 — Bootstrap: docs, harness, demo core

**What exists now**

- Repo bootstrapped as an independent git history (separate from Hualong Platform). Source spec (V1.3 docx) copied + faithfully extracted to [source-docs/workflow-v1.3.zh-CN.md](source-docs/workflow-v1.3.zh-CN.md).
- Bilingual PRD ([EN](docs/PRD.md) / [zh-CN](docs/PRD.zh-CN.md)) — core thesis: dynamic screening (strictness aimed at the model, not the teacher).
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — CloudBase target with two hard constraints (functions-framework for SSE; ICP 备案 early). [MODEL-APIS.md](docs/MODEL-APIS.md) — 2026-07 provider snapshot; MiniMax-M3 default, GLM-5.2 JSON anchor, Kimi fallback, Qwen flag.
- Dev harness ported from Hualong (gate/glossary/parity/typewriter/judges/hooks) + two new blocking checks: `schema-check` (course_state schema ↔ engine ↔ adapter drift) and `prompt-lint` (prompt corpus keeps spec §1/§6 content).
- Demo core, all tested: prompts (L1, zh-CN), runtime harness (L2 parse / L3 validators / L4 retry+degrade), deterministic engine with stage gates, provider adapter with failover, zero-dep SSE server, scripted mock provider that passes the real pipeline. Tests: 89/89 (`npm test`).
- Demo UI (chat, artifact cards, closure-loop card, chips, debug drawer) — built per [demo/DESIGN.md](demo/DESIGN.md); wire protocol in serve.mjs.

**Verified**: full test suite; full gate; mock turn over HTTP SSE (`curl` walkthrough). Browser verification of the final UI: see latest session below / pending if this is the top entry.

**Next steps (suggested order)**

1. Browser-verify the UI end-to-end on the mock walkthrough (5 turns → story fragment); then with a real key (GLM-4.7-Flash is free) to see real-model JSON compliance and L3/L4 behavior — capture violation stats.
2. Prompt iteration against real providers; tighten `prompt-lint` anchors as prompts evolve.
3. Enable `designJudge` (warn) in harness.config.json once the UI stabilizes.
4. Decide 试点 org + legal subject → start ICP 备案 (critical path, ~3–22 working days).
5. CloudBase spike: functions-framework SSE echo + document DB write, reusing demo/src core modules unchanged.
6. Deferred by design: AI drawing, WeChat MP packaging, real accounts, vector personalization (v1 uses structured profile injection).

**Open risks / questions**

- MiniMax-M3 JSON-via-tool-call reliability unproven against the real API (research says no `json_schema` on OpenAI-compat endpoint) — if flaky, swap default with GLM per MODEL-APIS recommendation.
- PRD Open Questions §10: voice input timing, photo evidence compliance (ADR needed before any model sees child photos), 八乡资料 corpus strategy, 教研员 read-only accounts.
- Demo streams hold-and-release (no token streaming) — acceptable for demo; production UX decision pending (ARCHITECTURE §9.1).
