# LAUNCH-COMPLIANCE.md — 备案 and Regulatory Critical Path

| | |
|---|---|
| **Status** | Prep checklist v0.1 — blocked on Decision D1 (legal subject) |
| **Research basis** | [ARCHITECTURE.md](./ARCHITECTURE.md) §5–6, [MODEL-APIS.md](./MODEL-APIS.md) §3 (snapshots 2026-07-05) |
| **Rule** | Per AGENTS.md: no guessing — items below marked 待核实 need verification with the filing agent/Tencent at execution time |

## Why this is the critical path

The demo runs locally today, but **nothing public can ship without ICP 备案**: CloudBase's default `*.tcloudbaseapp.com` domain is test-only (rate-limited, risk-control), and a custom domain on mainland hosting legally requires filing. The same filed domain is also the prerequisite for WeChat web login (Open Platform website-app approval). Filing takes roughly 3–22 working days after materials are complete — it should start as soon as D1 is decided, in parallel with all engineering work.

## Decisions needed first (owner: Herman / 园方)

- **D1 — Legal subject (主体).** Who files: the kindergarten, an affiliated company, or a partner entity? Determines all filing materials and the WeChat Open Platform account owner. The Hualong project resolved the equivalent question in its ADR-0010 — check whether the same subject can host both projects, or whether this platform (serving Panyu 教研, not one kindergarten) needs a different subject. **Everything below is blocked on this.**
- **D2 — Domain.** Register (or designate) the production domain under the D1 subject; domain registrant identity must match the filing subject.
- **D3 — Pilot data scope.** Confirm the pilot stores teacher-uploaded child observations/photos (sensitive PI) or launches text-only. Text-only materially simplifies the PIPL workload below.

## Track A — ICP 备案 (start immediately after D1/D2)

1. Buy/hold the domain under the D1 subject; real-name verify the registrar account. 
2. In the Tencent Cloud console (account owned by D1 subject), start ICP 备案 for the domain against the CloudBase environment. Materials (typical; exact list per province — 待核实 for Guangdong): business license / 事业单位法人证书, legal representative ID, authorized contact ID + phone, host agreement, site description ("教师教研辅助工具" framing — accurate and low-risk).
3. Guangdong 管局 review: historically ~1–3 weeks. During review the domain must not resolve to the site.
4. After approval: bind custom domain in CloudBase static hosting (free HTTPS cert), add 备案号 to the site footer.
5. 公安备案 within 30 days of going live (待核实 whether required for this site category in the pilot district).

## Track B — Generative-AI product layer (parallel, after Track A starts)

- We call already-备案 models (MiniMax/Zhipu/Moonshot/Alibaba are all approved services). The product layer therefore needs **登记 referencing the upstream 备案号(s)**, not its own model 备案 (MODEL-APIS.md §3). Confirm the current 登记 process and whether a Panyu-district education-sector product has extra requirements — 待核实 with the filing agent.
- Keep the provider abstraction honest in filings: register the providers actually used in production (initially MiniMax + Zhipu; update if the default switches).
- Vendor-side content moderation is inherent (their filters run on input and output); our own layer logs `content_filter` events (adapter already handles the error path).

## Track C — PIPL / minors' data (before any real classroom data)

1. **PIPIA (个人信息保护影响评估)** on file before pilot: processing purpose, minimization, retention, access scoping. Scope depends on D3.
2. **Guardian consent** channel: via kindergarten enrollment agreements / class-level consent for observation records used in 教研 — coordinate with the pilot 园所; text template needed (owner: 园方 + us).
3. **Children's privacy policy** (separate document from the general one) + teacher-facing upload guidance (no full names — the platform already enforces anonymized `child_ref` in `course_state`; no faces without consent tier — 待核实 consent tier design).
4. Storage controls (already in ARCHITECTURE §6): mainland region only, signed URLs, class-scoped security rules, no cross-border transfer, **no third-party model sees child photos without a dedicated ADR**.
5. Retention schedule: align with the Hualong project's minors-data retention ADR (ADR-0009 there) — adopt or consciously diverge, record as this repo's ADR when decided.

## Track D — WeChat (phase 2, non-blocking)

- WeChat web login needs an Open Platform **网站应用** under the D1 subject with the filed domain (approval ~7 days after 备案). Only start once Track A completes. SMS login carries the pilot until then.

## Sequence summary

```
D1 legal subject ──► D2 domain ──► Track A ICP (1–3+ weeks) ──► custom domain live ──► Track D WeChat
                                   Track B 登记 (parallel)
D3 data scope   ──► Track C PIPIA + consent (before first real classroom data)
```

## Open items ledger

| # | Item | Owner | Status |
|---|---|---|---|
| 1 | D1 legal subject decision | Herman / 园方 | open |
| 2 | D2 domain choice + registration | Herman | blocked on 1 |
| 3 | D3 pilot data scope (photos or text-only) | Herman / 园方 | open |
| 4 | Guangdong 备案 material list confirmation | filing agent | 待核实 |
| 5 | 生成式AI product 登记 current process | filing agent | 待核实 |
| 6 | Guardian consent template | 园方 + us | blocked on 3 |
| 7 | Retention schedule ADR | us | blocked on 3 |
