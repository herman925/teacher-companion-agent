# ARCHITECTURE.md — System Design

| | |
|---|---|
| **Status** | Draft v0.1 — design target; only the demo slice is being built this phase |
| **PRD** | [PRD.md](./PRD.md) / [PRD.zh-CN.md](./PRD.zh-CN.md) |
| **Provider research** | [MODEL-APIS.md](./MODEL-APIS.md) (snapshot 2026-07-05) |
| **Backend research snapshot** | 2026-07-05 (CloudBase pricing/runtime facts below carry that date) |

## 1. System context

```
┌─────────────┐   HTTPS/SSE   ┌──────────────────────────────┐   HTTPS/SSE   ┌─────────────┐
│  Teacher's   │ ────────────▶ │  Proxy layer                 │ ────────────▶ │  LLM vendor │
│  browser     │               │  demo: local Node serve.mjs  │               │  MiniMax /  │
│  (web SPA)   │ ◀──────────── │  prod: CloudBase function    │ ◀──────────── │  GLM / Kimi │
└─────────────┘               │  (functions-framework, SSE)  │               │  / Qwen     │
       │                      │  · model adapter + failover  │               └─────────────┘
       │                      │  · runtime harness L2–L4     │
       │                      │  · state-machine engine      │
       │                      └──────────┬───────────────────┘
       │            CloudBase js-sdk     │ node-sdk
       ▼                                 ▼
┌──────────────────────────────────────────────────────────────┐
│  Tencent CloudBase (mainland region)                          │
│  auth (SMS → WeChat later) · document DB · storage · hosting  │
│  collections: users / courses / messages / materials /        │
│               violations                                      │
└──────────────────────────────────────────────────────────────┘
```

Design rule that makes the demo honest: **the demo's local Node proxy and the production CloudBase function share the same core modules** (adapter, runtime harness, state engine — plain ESM, no platform APIs). Only the transport shell differs.

## 2. Why a proxy is not optional

All four candidate vendors block browser-direct calls (CORS) and treat frontend-exposed keys as compromised ([MODEL-APIS.md §3](./MODEL-APIS.md)). The proxy is also positively needed for:
- key custody (server-side env/config),
- SSE re-emission under our own auth,
- **runtime-harness validation before the teacher sees a token of round-final content**,
- per-teacher usage logging and retry/repair.

## 3. The turn pipeline (runtime harness home)

Per teacher message:

1. **Load** `course_state` (+ last N messages) → build prompt: base system module (spec §1 principles + §6 prohibitions) + stage module (spec §4) + dynamic-screening contract + state snapshot.
2. **Call** model via adapter (JSON strategy per provider: `json_schema` GLM · `tool_call` MiniMax · `json_object`+prompt Kimi/Qwen).
3. **Parse** turn contract: `{reply_markdown, state_delta, closure_loop?, evidence_refs[], asks?}`.
4. **Validate (L3, deterministic)**:
   - closure loop four-part completeness when the turn ends a round;
   - `state_delta` legality against the stage-transition table (e.g., Stage 2 requires non-empty `children_evidence`);
   - fabrication heuristic: child-claims (孩子发现/理解/感受到…) require `evidence_refs` into stored evidence;
   - adult-slogan lexicon scan on child-facing tasks (传承精神/弘扬文化/文化责任…);
   - screening contract: ≤1 question per intake turn, question carries examples.
5. **On failure**: regenerate once with the violation report injected (L4); second failure → safe template + violation logged.
6. **Apply** validated `state_delta` via the deterministic engine; snapshot state version; persist message + usage + violations.
7. **Stream** the reply (validated turns stream from the retry buffer; streaming-vs-validation tension is resolved by validating *structural* parts on the final buffer while streaming prose — acceptable for demo; production may hold-and-release round-final messages only).

## 4. State machine engine

- `course_state` JSON Schema: `harness/schema/course-state.schema.json` (single source of truth; validated by the dev harness `schemaCheck`).
- The **LLM proposes, the engine disposes**: `state_delta` is a constrained patch (whitelisted paths per stage); transitions computed from the spec §2 流转规则 table, encoded as data:

| From | To | Gate |
|---|---|---|
| S0 intake | S1 experience/questions | `resource_entry_card` confirmed (or 待现场确认-marked) + `theme_fit_level` set |
| S1 | S2 goals axis | `children_evidence` non-empty **and** `driving_question` candidates exist |
| S2 | S3 cycles | `goals_assessment_axis` confirmed; GRASPS present if public delivery intended |
| S3 round N | S3 round N+1 | teacher feedback received (`awaiting_feedback` cleared) — **never auto-advances** |
| S3 | S4 delivery | product prototype exists + real audience identified |
| any | S5 story export | teacher requests **and** materials gap-check run first |

- Every applied delta produces an immutable snapshot (`courses/{id}/snapshots`): auditability + recovery (PRD user story 25).

## 5. Backend: Tencent CloudBase (verified 2026-07)

Verdict from research: **good fit** — CloudBase pivoted to AI-native workloads; pilot infra cost is trivial next to token spend. Build constraints (both hard):

1. **函数型云托管 (functions-framework / "functions 2.0") only** — the sole runtime with SSE/WebSocket streaming; also gives identical local dev in Node/Docker. Legacy 云函数 1.0 cannot stream.
2. **ICP 备案 early** — the default `*.tcloudbaseapp.com` domain is now test-only (rate-limited, risk-control); a custom filed domain is required for production and also unlocks WeChat web login (Open Platform website-app prerequisite). File under the operating legal subject as soon as it's decided.

Component choices:
- **Auth**: SMS login v1 (native, ~¥0.05/条); WeChat login phase-2 (needs Open Platform approval + filed domain). Anonymous login for trial mode.
- **DB modeling**: `course_state` = one compact doc per course (nested-field updates via `db.command`); **chat history = one doc per message** (`uid + courseId + ts` indexed) — never an unboundedly growing document; snapshots as separate docs. Security rules scope everything to owner (`auth.uid`).
- **Storage**: photos via temp signed URLs + security rules, never public URLs (child-image caution, AGENTS.md non-negotiable 4).
- **Vector personalization (deferred by design)**: v1 = structured profile injected into prompts (zero infra). CloudBase 知识库 (managed RAG over md/pdf/docx, `searchKnowledgeBase()`) covers materials-RAG natively when needed. Standalone Tencent VectorDB ≈ ¥336+/mo with no free tier → add only when custom per-user embeddings are demonstrably needed. Full-chat-history vectorization stays parked.
- **AI-layer churn warning**: console-configured CloudBase Agents were discontinued 2025-09; free token promos ended 2026-06. We build against stable primitives (functions + our own vendor keys through the adapter), not CloudBase's built-in model billing — this also preserves provider freedom.

Cost (pilot, ~50 teachers): resource-point model (2026-06-29): 免费体验版 3,000 pts/mo; 个人版 ¥19.9/mo (40k pts) likely suffices; 标准版 ¥199/mo for headroom. Infra ≈ ¥15–30/mo equivalent; dominant cost is LLM tokens (¥50–300/mo at pilot scale) + SMS (~¥50–100/mo). **Total ¥100–500/mo**, matching the PRD ceiling; +¥336/mo only if VectorDB is added.

## 6. Compliance posture (PIPL / minors)

- Users are adults (teachers), but uploaded observations/photos are **children's PI = sensitive PI by definition** (PIPL Art. 31): guardian consent via kindergarten enrollment agreements; separate children's-privacy policy; PIPIA on file; minimal retention; class-scoped access via security rules.
- Mainland region keeps data at rest onshore; **no cross-border transfer** (would trigger CAC assessment).
- Vendor moderation: all four LLM vendors filter input and output server-side (备案 requirement); our layer needs product 登记 referencing upstream 备案号, not model 备案. Tencent 内容安全 APIs callable from the same functions if we add our own UGC moderation pass.
- **No third-party model sees child photos** without an explicit ADR (AGENTS.md non-negotiable).

## 7. Demo slice (this phase)

```
demo/
├── DESIGN.md            # semantic design system (source of truth for look & feel)
├── index.html           # chat SPA shell (zh-CN)
├── serve.mjs            # zero-dep local server: static + /api/chat SSE + turn pipeline
├── src/
│   ├── types.mjs        # JSDoc typedefs: turn contract, violations, provider config
│   ├── adapter.mjs      # provider registry + per-provider JSON strategies + failover
│   ├── harness.mjs      # runtime harness: L2 parse · L3 validators · L4 policy
│   ├── engine.mjs       # deterministic course_state engine + stage-gate table
│   ├── mock.mjs         # scripted contract-compliant walkthrough (no key needed)
│   ├── prompts/         # L1: base + contract + per-stage system modules (zh-CN)
│   └── ui/              # main.js · render.js (sanitizeMarkdown) · motion.js · styles.css
└── tests/               # both-directions validator fixtures + mock walkthrough
```

- Plain JSDoc-typed ES modules, no build step (ADR-0001); GSAP via CDN for motion; design per DESIGN.md.
- No CloudBase in the demo: course_state persists to localStorage in the browser; the server is stateless (state travels with each request), behind the same turn-pipeline interface a CloudBase function will implement.
- The `mock` provider runs canned turns through the SAME L2/L3/L4 pipeline — UI and harness are demonstrable without any API key.

## 7b. WeChat 小程序 compatibility & compliance

The product direction includes a WeChat entry point (teachers live in WeChat). Three integration tiers, in ascending cost; the staged path is tier by tier, and tiers 2+ share one critical-path dependency chain: **domain → ICP 备案 → HTTPS**, the same long pole already tracked in [LAUNCH-COMPLIANCE.md](./LAUNCH-COMPLIANCE.md).

**Tier 1 — web app (today).** Teachers open the site in WeChat's built-in browser via a shared link. Works now over bare IP; nothing WeChat-specific required. Limitation: no 小程序 presence, no WeChat identity.

**Tier 2 — 小程序 `web-view` shell (recommended next).** A minimal native shell whose single page hosts our existing web app in a `<web-view>`. Hard requirements (verified against WeChat docs):

- **企业主体 only.** 个人主体 and 海外主体 小程序 cannot open arbitrary H5 in `web-view`; enterprise real-name (企业认证) is mandatory. The filing subject decision (LAUNCH-COMPLIANCE **D1**) is therefore also the 小程序 subject decision.
- **HTTPS + filed domain, no IP.** The target must be an HTTPS domain whose ICP 备案 is at least 24 hours old; `IP:port` is rejected outright.
- **业务域名 whitelist.** The domain is registered under 小程序后台 → 开发设置 → 业务域名, verified by a 校验文件 at the domain root; any iframe host inside the page must be whitelisted too.

Inside `web-view` the page runs in WeChat's embedded browser — X5/TBS on Android, WKWebView on iOS, *not* the MP framework (the newer Skyline engine does not support `web-view` at all). ES modules, CSS custom properties, `<details>`, localStorage (per-origin, not shared with MP storage) and GSAP track the WebView engine and are expected to work — the demo already runs in mobile WeChat's browser. **The load-bearing risk is streaming**: our chat is a POST `/api/chat` returning an SSE body, so we depend on `fetch()` + `ReadableStream` delivering incrementally (classic `EventSource` is GET-only). Whether X5/WKWebView stream or buffer that response must be measured on real devices before Tier 2 is committed; server-side, any reverse proxy needs `proxy_buffering off`. Code reuse ≈ 100%.

**Tier 3 — native 小程序 (only if product demands it).** Full rewrite of the UI layer: WXML/WXSS, no DOM — `<details>` becomes view+state, GSAP does not run (no DOM), the SVG 导图 would be re-implemented on MP canvas. Streaming moves to `wx.request({ enableChunked: true })` with a reframed SSE parser (and a UTF-8 decode shim — MP has no `TextDecoder`); localStorage becomes `wx.setStorageSync`. The platform-free core (proxy, adapter, runtime harness, engine, prompts) ports untouched. Native pages need no 业务域名, but everything in the compliance list below still applies. Do not start this before pilot evidence justifies it.

Compliance notes specific to the MP surface (beyond §6):

- **深度合成-AI问答 服务类目 is mandatory** for an AI-answering product, and it is not open to 个人主体. Qualification = own 算法备案 (生成合成类/深度合成) or — more commonly — the upstream model vendor's 备案 plus a 合作协议 naming the algorithm and 备案编号 (consistent with LAUNCH-COMPLIANCE Track B: we already call filed models). A 安全评估报告 may also be requested. WeChat review rejects AI-chat features that lack these filings — MP submission comes *after* the compliance track closes, never around it.
- **AI-content labelling**: 《人工智能生成合成内容标识办法》(effective 2025-09-01) requires a visible AI生成 notice on generated content plus an implicit provider identifier in metadata — the runtime output surface needs this label added before any MP release.
- Child-related media and observations inherit the existing posture: mainland residency, minimal retention, no third-party model sees child photos without a recorded ADR. WeChat login would supply platform-level real-name identity for teacher accounts (`code2Session` — the DATABASE.md §4 account design assumes it).

**One account across web and 小程序.** A 小程序 does not replace the web app — the two are surfaces over the same backend, and course history must follow the teacher across both. The design that makes this work is already half-built: accounts, sessions and courses are **server-side** (auth store → PostgreSQL later), so any authenticated surface retrieves the same history; nothing about history lives in a WeChat identity. What Tier 2+ adds is identity *binding*: WeChat login yields a per-app `openid` (different per 小程序/公众号/网站应用) — cross-surface matching requires `UnionID`, which exists only when the MP and the web's 微信开放平台 app are registered under the same subject (again D1). The account model: our `users` row is primary; `wechat_unionid` (and per-surface openids) are *bindings* on it, so a teacher can log in with password on the web, WeChat on the phone, and land in the same courses. Never make WeChat identity the primary key — teachers without WeChat login (admin-provisioned pilot accounts) must remain first-class.

Open questions (verify before Tier 2 work starts; no guessing):

1. **web-view streaming**: does POST-based `fetch`/`ReadableStream` deliver incrementally inside current X5 (Android) and WKWebView (iOS), or buffer? Real-device measurement required — this gates Tier 2.
2. **Education 类目**: the exact 服务类目 for a teacher-research aid (教师教研辅助工具 framing, not student-facing tutoring — likely avoids 办学许可证, unverified), and whether a non-经营性 tool triggers ICP 许可证 rather than plain 备案 — 待核实 with the filing agent.
3. **深度合成 category acceptance**: does a borrowed vendor 算法备案 + 合作协议 suffice for our 教研 framing, and is the 安全评估报告 demanded? — 待核实.
4. **AI-label placement**: per-message vs page-level for the visible AI生成 notice in a chat UI to pass review — unverified.
5. `<details>`/CSS-custom-props floor on the oldest X5 kernel we would commit to, and localStorage eviction behavior in iOS WKWebView (visitor 演示模式 relies on it; signed-in courses are server-side and unaffected).
6. **UnionID mechanics for our subject setup**: confirm the MP and a 网站应用 can share one 微信开放平台 account under the pilot's legal subject, and the web-side 扫码 OAuth flow's requirements/cost — 待核实 during D1.

## 8. Alternatives considered

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| Backend | CloudBase | Supabase/self-host PG, Aliyun stack | Mainland compliance path, WeChat synergy, pilot cost ≈ 0; consistent with sister project's evaluation. Revisit only if functions-framework SSE proves unreliable in practice. |
| Model abstraction | Own ~50-line registry | SiliconFlow/Bailian aggregator as primary | Fewer availability/markup layers; all vendors OpenAI-compatible anyway. Bailian kept as disaster-recovery (one key proxies all four vendors). |
| JSON enforcement | Per-provider strategy + server validation | Trust vendor JSON modes | Only GLM has constrained decoding; semantic rules (closure loop, gates, evidence) need our validators regardless. |
| Demo transport | Local Node proxy | Browser-direct calls | CORS-blocked by all vendors; proxy mirrors production and hosts the harness. |
| State transitions | Deterministic engine, LLM proposes deltas | LLM-managed state | Fabrication resistance, auditability, replayability — the product's core promise. |

## 9. Open questions

1. Streaming vs validation: is hold-and-release acceptable UX for round-final messages in production, or do we need incremental structural validation?
2. TypeScript build: zero-dep constraint vs esbuild dev dependency — decide at demo build time (ADR if we take the dependency).
3. 登记 process timeline for the product layer — needs owner and date once pilot org is confirmed.
4. Voice input (teacher feedback) — vendor ASR vs browser SpeechRecognition (mainland support poor) — later phase.
