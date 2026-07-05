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
├── index.html           # chat SPA shell
├── serve.mjs            # zero-dep local server: static + /api/chat SSE proxy + harness
├── src/
│   ├── main.ts          # UI: chat, closure-loop card, entry-card render, debug drawer
│   ├── adapter/         # provider registry + JSON strategies + quirk handlers
│   ├── harness/         # L2 parse · L3 validators · L4 retry (shared with future prod)
│   ├── engine/          # course_state store (localStorage) + transition table
│   └── prompts/         # base + per-stage system modules (zh-CN)
└── tests/               # both-directions validator fixtures
```

- TypeScript compiled with esbuild-free approach TBD at build time (constraint: keep the repo zero-npm-dependency if practical; otherwise a single pinned dev dependency is an ADR-worthy exception).
- GSAP via CDN for motion; design per DESIGN.md.
- No CloudBase in the demo: `engine/` persists to localStorage behind the same interface the CloudBase implementation will use.

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
