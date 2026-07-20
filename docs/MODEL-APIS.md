# MODEL-APIS.md — LLM Provider Evaluation

Research snapshot: **2026-07-05** (prices carry active promos — recheck at contract time; Kimi raised prices +58% and GLM international +67–100% within the last year, so never hard-code cost assumptions).

Decision summary (details below): **MiniMax-M3 default · GLM-5.2 fallback-1 and JSON-correctness anchor · Kimi k2.6 fallback-2 · Qwen (qwen-plus) cheap/resilience tier**. A server-side proxy is mandatory for all providers.

## 1. Comparison table

| | MiniMax-M3 | Zhipu GLM-5.2 | Kimi kimi-k2.6 | Qwen (Qwen3.7-Max / qwen-plus) |
|---|---|---|---|---|
| Context window | 1M (≥512K guaranteed) | 1M, 128K max output | 256K | 1M (Max); 128K–1M (plus, tiered) |
| Input ¥/M tok | ¥2.1 (≤512K; 50% promo, list ¥4.2) | ¥8 (cache hit ¥2) | ¥6.5 miss / ¥1.1 cache hit | Max ~¥6 (promo, tiered); plus ~¥0.8 |
| Output ¥/M tok | ¥8.4 (≤512K; promo) | ¥28 | ¥27 | Max ~¥18 (promo); plus ¥2–4.8 |
| OpenAI-compat base URL | `https://api.minimaxi.com/v1` | `https://open.bigmodel.cn/api/paas/v4` | `https://api.moonshot.cn/v1` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| JSON enforcement | tool-calling (no documented `json_schema`) | **`json_schema` constrained decoding** | `json_object` + "JSON" in prompt | `json_object` only; not in thinking mode; avoid `max_tokens` |
| SSE streaming | yes | yes | yes | yes |
| Free tier | promo periods only | ~20–25M signup tokens + **GLM-4.7-Flash permanently free** | Tier 0 (near-unusable: 3 RPM) | ~1M tok/model signup (~90 days) |
| Entry rate limits | ~500 RPM paid; peak throttling 15:00–17:30 | concurrency-tiered | **Tier 0: 3 RPM** → ¥50 recharge = 200 RPM | generous for paid |
| Browser-direct (CORS) | no | no | no | no |
| 备案 | approved | approved | approved | approved |

## 2. Per-provider notes (what matters for us)

### MiniMax-M3 (default)
- Best price-per-capability of the flagships; 1M context comfortably holds a full course conversation + `course_state`.
- **Caveat 1**: no documented schema-constrained output on the OpenAI-compat endpoint → enforce our turn contract via a **tool-call definition** (the state-delta object as a tool schema) + server-side validation/repair (runtime harness L3/L4 does this anyway).
- **Caveat 2**: M-series are interleaved-thinking models — strip/handle reasoning content before JSON parsing; preserve it across turns per their multi-turn guidance.
- MiniMax-M2.7 (204.8K ctx, ¥2.1/¥8.4, cache ¥0.42) is the cost variant for routine turns.

### Zhipu GLM-5.2 (fallback 1, correctness anchor)
- The **only provider with true JSON-Schema constrained decoding** (`response_format: json_schema`, since GLM-4.7) — our shared turn-contract schema runs natively here. When MiniMax JSON proves flaky in testing, swap default and fallback.
- In-provider degradation tiers: GLM-5-Turbo (cheap agent model) and **GLM-4.7-Flash (permanently free)** — the free tier for development and prompt iteration.
- Marketed and reputed for long-horizon multi-step adherence — matches multi-round 陪跑 conversations.

### Moonshot Kimi kimi-k2.6 (fallback 2)
- Most expensive output (¥27/M); smallest (still ample) context.
- **Automatic context caching** (¥1.1 cache-hit input) is genuinely valuable for long multi-turn sessions.
- **Operational trap**: Tier 0 is 3 RPM — recharge ≥¥50 on day one or it looks like an outage.
- Documented `content_filter` error path — teacher content about children can trip over-eager filters; the adapter must catch and retry/reword gracefully.

### Qwen / DashScope (cheap + resilience tier)
- qwen-plus at ~¥0.8/¥2–4.8 is the best cost floor for low-stakes turns (classification, short follow-ups, state-diff summarization) if we later add turn-level routing.
- Structured output is the weakest: `json_object` only, incompatible with thinking mode, docs warn against `max_tokens`.
- **Bailian is itself an aggregator** hosting MiniMax/GLM/Kimi behind one DashScope key — our disaster-recovery path if a vendor account is suspended.

## 3. Cross-cutting facts

- **CORS**: none of the four sanction browser-direct calls; official guidance is env-var keys behind your own backend. → The **proxy is mandatory** even for the demo (local Node proxy in dev; CloudBase function in production). This is where the runtime harness validators live anyway.
- **Compliance**: all four are 备案-approved 生成式AI services. Calling an approved model via API means our product layer needs 登记 (registration referencing the upstream 备案号), not its own model 备案. Input AND output are filtered server-side by the vendors (mandated keyword libraries); expect occasional `content_filter` finishes on benign education content — build a graceful retry/reword path into the adapter.
- **Aggregators**: SiliconFlow 硅基流动 is the closest domestic OpenRouter (strong for open-weight models; GLM-5 and Kimi K2.x are open-weight). Verdict: with 3–4 providers all OpenAI-compatible, our own ~50-line provider registry is simpler than an extra availability/markup layer. SiliconFlow = emergency extra fallback only.

## 4. Adapter design consequences (normative for the demo)

1. One OpenAI-compatible client; per-provider config = `{baseURL, model, key, jsonStrategy, quirks}`.
2. `jsonStrategy`: `"json_schema"` (GLM) · `"tool_call"` (MiniMax) · `"json_object_prompt"` (Kimi, Qwen).
3. Quirk handlers: strip interleaved thinking (MiniMax); catch `content_filter` (all, esp. Kimi); no `max_tokens` with Qwen structured output.
4. Vendor calls stream (`stream: true`, 2026-07-20): the adapter accumulates chunks back into the non-streaming completion shape, so parse/validate is unchanged, while live progress flows out through an `onDelta` callback — `first` (TTFT), `thinking` (GLM-family `reasoning_content` chunks AND MiniMax `<think>…</think>` content, both handled generically), `content` (char count; tool-call argument chunks count here, raw JSON args are never teacher-facing). Usage = whatever the final chunk carries (`stream_options.include_usage` is NOT sent — not universally accepted); a null usage is tolerated. Side-channel plain calls (title agent) and any call without `onDelta` stay non-streaming.
5. Timeout 600s per call (raised from 180s 2026-07-20: healthy glm-5.2 coding-plan turns run 80–115s and real turns exceeded 180s under load). Every proxy in front must read longer than the adapter — the public nginx reads at 660s — so the abort is always ours and reports through the stream.
6. Failover chain on 5xx/timeout/`content_filter`-hard-fail: MiniMax → GLM → Kimi. Qwen behind `enableQwen` flag.
7. Validation lives server-side (harness L3), independent of provider promises — even GLM's constrained decoding doesn't validate *semantic* rules (closure loop, stage gates, evidence refs).
8. Output-length discipline: the turn contract stays JSON (constrained decoding + the whole L2/L3 stack depend on it; evaluated and rejected TOON 2026-07-20 — its savings target flat uniform arrays, our contract is a nested non-uniform tree, and no vendor constrains non-JSON output). Bloat is fought with deltas instead: `blueprint_delta` for small edits, history carries only `reply_markdown` for past agent turns, and harness rule 3c warns when a resent blueprint is ≥60% byte-identical to state. **Revisit later**: if usage stats show flat tabular fields (周计划 rows, 材料清单) dominating output tokens, consider a compact encoding for those `data` fields only — measure first via the debug drawer's per-turn usage numbers.

## 5. Source URLs

- MiniMax: [pricing](https://platform.minimaxi.com/docs/guides/pricing-paygo) · [M3 product](https://www.minimaxi.com/models/text/m3) · [OpenAI-compat API](https://platform.minimax.io/docs/api-reference/text-openai-api)
- GLM: [GLM-5.2 docs](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.2) · [GLM-4.7-Flash free](https://docs.bigmodel.cn/cn/guide/models/free/glm-4.7-flash) · [structured output](https://docs.z.ai/guides/capabilities/struct-output) · [pricing](https://bigmodel.cn/pricing)
- Kimi: [pricing](https://platform.kimi.com/docs/pricing/chat) · [rate limits](https://platform.kimi.com/docs/pricing/limits) · [JSON mode](https://platform.moonshot.cn/docs/guide/use-json-mode-feature-of-kimi-api)
- Qwen: [model pricing](https://help.aliyun.com/zh/model-studio/model-pricing) · [structured output](https://help.aliyun.com/zh/model-studio/qwen-structured-output) · [OpenAI compat](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)
- Regulatory: [产品层登记 vs 模型备案 analysis](https://zhuanlan.zhihu.com/p/1906399088192255516) · [安全要求](https://www.secrss.com/articles/64276)
- Aggregator: [SiliconFlow](https://siliconflow.cn/)
