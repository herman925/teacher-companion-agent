# HANDOFF

Latest session first. Keep entries short and factual; link instead of restating.

## 2026-07-08 (later, 2) — OpenCode Zen hosted provider

- **`opencode-zen`** added alongside the local provider: OpenCode Zen (opencode.ai/docs/zen) is a hosted **OpenAI-compatible** gateway (`https://opencode.ai/zen/v1`, Bearer key from opencode.ai/auth) — so it's just a normal cloud provider, no new adapter path, no local server. Uses the existing `json_object_prompt` strategy + generic `providerSection` UI (key + model row). Default model blank (pick via 获取模型列表; five free models incl. `deepseek-v4-flash-free`). Optional server-side key via `OPENCODE_API_KEY` (serve.mjs ENV_KEYS).
- The local `opencode` (session-API) provider stays — the two are different: Zen = hosted API you paste a key for; `opencode serve` = local server proxying your own model auths.
- Verified: `/api/health` lists both; dropdown + Zen settings section browser-verified. **Not** exercised against the live Zen API — needs Herman's key.

## 2026-07-08 (later) — OpenCode local-server provider

- **New provider `opencode`** (settings drawer, between Kimi and 自定义端点). Drives a local `opencode serve` (opencode.ai/docs/server) — a **session-based API, NOT OpenAI `/chat/completions`**. New adapter path in `demo/src/adapter.mjs` (`callOpencode` + `listOpencodeModels`): `POST /session` → `POST /session/:id/message`, reads assistant text parts. Model id is OpenCode's two-part `providerID/modelID`; default `opencode/deepseek-v4-flash-free` (free, no key). OpenCode holds the model keys itself, so the UI "key" field is the **optional server password** (Basic auth); the failover key-guard and `/api/models` key-check both exempt `kind:'opencode'`.
- **Turn contract via `json_object_prompt`, not the server's `format:json_schema`** — testing showed opencode's json_schema format refused several models (MiniMax: "Model did not produce structured output"). We fold the JSON reinforcement into the `system` field and flatten the transcript into one text part; `tools:{}` keeps the coding agent off the filesystem. Model errors arrive inside a 200 envelope (`info.error`, e.g. disabled Zen model) — surfaced as an `AdapterError`.
- **Verified live** against a running `opencode serve` (v1.17.11, port 4096): `/api/health` lists opencode; `/api/models` flattens 71 models; full `/api/chat` turn passed the runtime harness (gate ok, attempt 1) on both `opencode/deepseek-v4-flash-free` (free) and `minimax-cn-coding-plan/MiniMax-M3` (user-authed, model-override path). Browser-verified the settings section renders (dropdown + baseURL prefilled + password + model row). Demo tests 56/56, gate `--fast` green.
- **To use**: run `opencode serve` in another terminal, run the demo server, pick 「OpenCode（本地）」in settings, 获取模型列表 → choose a model. Note: opencode's `opencode-go` Zen tier returned "Model is disabled" (needs subscription); the `*-free` models and any provider the user has authed (MiniMax/GLM/…) work.
- Not committed: pre-existing unrelated working-tree edits (`.gitattributes`, `.gitignore`, `launch-demo.bat`) left unstaged.

## 2026-07-08 — Awaiting-gate dead-end fix, V1.3 gap nodes (WF04b/WF31b)

- **Live-site bug fixed** (PR #1): every flow dead-ended at the awaiting gates (~exchange 4) — waiting turns had `question: null` (no chips) and gates only accepted Chinese evidence markers; generic/English replies looped two nudge variants forever. Now: all six waiting turns carry 2 gate-unlocking example chips, and every gate escalates after `MAX_NUDGES = 2` — third reply onward is accepted as field feedback regardless（筛选对准模型，不对准老师）. Regression net: `demo/tests/awaiting-escalation.test.mjs` (all five flows must reach the horizon on generic replies alone, ≤14 turns).
- **Spec audit** (V1.3 41 nodes vs implementation): mock walks 31/41 after this session. Two true gaps closed (PR #2): **WF04b 资源深度网络图** (`depth_network` card in turnEntryCard, four layers + 做浅 risk; stage1 prompt section) and **WF31b 文化育人价值复盘** (`culture_review` card in turnStoryExpand, evidence-linked, ladder honestly stops at 情感层; stage5 prompt section). Stage 4 (WF23–27) stays outside the demo boundary per spec §7 — deliberate, documented. Audit correction: stage2 prompt covers WF12–14 via the "WF11–14" range wording — no gap there.
- flow-crawler terminal checks tightened (WF04b, WF31b + culture_review shape); coverage 77 steps / 34 chip branches. Merged to main; live Pages needs the same commits pushed to the Chao0s repo.
- Gotcha: running the harness suite from any path containing `.claude/` (e.g. worktrees under `.claude/worktrees/`) false-fails two pre-edit-guard tests — the guard treats the whole checkout as governance paths. Commit from a path without `.claude/`, or fix the guard later.

## 2026-07-06 (later) — Branching mock, 开发者模式, hosting

- Mock redesigned as a state-machine with **five entry flows** (WF01 entry recognition → 从零陪跑 / 已有主题优化 / 过程中续聊 / 课程故事整理 / 素材支持), each walking different V1.3 nodes; every turn passes the runtime harness; story flow reaches stage 5 only after real evidence; mid-course honestly stays at stage 0 (0→3 jump is illegal) and says so.
- **开发者模式** toggle (settings): per-turn `wf_trace` annotation (nodes + principles + state notes) + a stage 0-5 工作流地图 in the debug drawer with ✓ on `completed_nodes`. New `demo/src/wf-nodes.mjs` catalog (42 nodes).
- Demo runs fully client-side in 演示模式 (`demo/src/ui/local-turn.mjs`) → live on GitHub Pages (Chao0s/teacher-companion-agent, Actions deploy of `demo/`). Real providers need the proxy: `s.yaml` + [docs/DEPLOY.md](docs/DEPLOY.md) (Alibaba FC Options A/B; Tencent CloudBase Run Option C — aligns with the WeChat-mini-app direction). UI has a 服务器地址 field; no-backend real-model turns degrade to labelled 模拟演示.
- Repo published: `github.com/Chao0s/teacher-companion-agent` (public) + real fork `herman925/teacher-companion-agent`. A 12-page wiki is drafted (pending first-page init on GitHub, then push).
- Live-test fixes: stage gates + validateTurn now **delta-aware** (a delta supplying its own prerequisites is legal — kills the spurious 拦截 on the 切口卡 turn); awaiting phase is alive (entry choice acknowledged + written to `resource_entry_card.chosen_entry`, 就地支持 for 素材/预案 asks, nudges cycle variants, empty deltas explained in `state_notes`); **NODE_PREREQS** partial-order validator (`node_prerequisite` strip, delta-as-set) + prereq hints in the 工作流地图.
- 教师档案 (local-only, settings): 地区/年段/班额/偏好 → injected as read-only prompt context (never model-writable; tested); mock interpolates 年段. Dev-mode **提示词（本轮）**: full assembled system prompt per turn — server-returned with `debug:true`, or byte-identical client-side reconstruction in 演示模式 (shared `demo/src/prompt-builder.mjs`, parity-tested).
- Every flow now reaches a **real terminal deliverable** (story: the four-chapter 完整案例版 text with evidence-cited 章眼 + genuine adjustment variants; from_zero: through 驱动问题 pick into stage-3 second-cycle review; mid_course: differing round-2 analysis) and ends at an explicit **演示边界** (two phrasings, never a stall). `demo/tests/flow-crawler.test.mjs` walks 73 steps / 30 example-chip branches through the real pipeline as a permanent regression net. WF30/WF32 marked at delivery, not promise.

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
