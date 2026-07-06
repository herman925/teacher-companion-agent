# HANDOFF

Latest session first. Keep entries short and factual; link instead of restating.

## 2026-07-06 (later) — Branching mock, 开发者模式, hosting

- Mock redesigned as a state-machine with **five entry flows** (WF01 entry recognition → 从零陪跑 / 已有主题优化 / 过程中续聊 / 课程故事整理 / 素材支持), each walking different V1.3 nodes; every turn passes the runtime harness; story flow reaches stage 5 only after real evidence; mid-course honestly stays at stage 0 (0→3 jump is illegal) and says so.
- **开发者模式** toggle (settings): per-turn `wf_trace` annotation (nodes + principles + state notes) + a stage 0-5 工作流地图 in the debug drawer with ✓ on `completed_nodes`. New `demo/src/wf-nodes.mjs` catalog (42 nodes).
- Demo runs fully client-side in 演示模式 (`demo/src/ui/local-turn.mjs`) → live on GitHub Pages (Chao0s/teacher-companion-agent, Actions deploy of `demo/`). Real providers need the proxy: `s.yaml` + [docs/DEPLOY.md](docs/DEPLOY.md) (Alibaba FC Options A/B; Tencent CloudBase Run Option C — aligns with the WeChat-mini-app direction). UI has a 服务器地址 field; no-backend real-model turns degrade to labelled 模拟演示.
- Repo published: `github.com/Chao0s/teacher-companion-agent` (public) + real fork `herman925/teacher-companion-agent`. A 12-page wiki is drafted (pending first-page init on GitHub, then push).

## 2026-07-06 — Launcher, model discovery config, compliance path, knowledge graph

- `launch-demo.bat`: double-click launcher (Node check → server → browser; optional port arg).
- Settings drawer is now full service config: per-provider keys + 「获取模型列表」 live model dropdowns (new `/api/models` proxy endpoint), per-provider model overrides, 自定义端点 (any OpenAI-compatible API). Browser-verified incl. stub endpoint + captured wire bodies.
- [docs/LAUNCH-COMPLIANCE.md](docs/LAUNCH-COMPLIANCE.md): 备案/登记/PIPL/WeChat tracks; blocked on D1 (legal subject), D2 (domain), D3 (data scope) — Herman's decisions.
- `.understand-anything/knowledge-graph.json` generated (understand-anything v2.8.1 procedure run manually — plugin wasn't loaded in-session): 174 nodes / 378 edges / 6 layers (上游规范·产品文档·治理与开发护栏·测试·运行时核心·界面) / 11-step zh tour; validation 0 issues; fingerprints baseline written so future runs can be incremental. View via the `/understand-anything` dashboard skill in a session with the plugin loaded.
- Outer workspace repo: Hualong move committed (`0d3a7b0`, rename-detected); sibling repos gitignored there. NOTE: Hualong's own git hooks are silently off until `hooks:install` is re-run from inside `Hualong Platform/`.

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
