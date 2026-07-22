# AGENTS.md — Working Agreements

Canonical source of truth for how humans and coding agents work in this repository. `CLAUDE.md` imports this file and adds Claude-Code-specific wiring only; where they overlap, this file wins.

## What this repository is

The spec, governance, and demo home of **小小探索家：学前教育主题探究课程助手 (Little Explorers — Preschool Theme-Inquiry Course Assistant**; formerly the working title 教师资源发展平台, renamed 2026-07-16) — a web-based 陪跑智能体 (companion agent) that accompanies kindergarten teachers through local-culture theme-inquiry courses. The behavioral contract is the V1.3 workflow spec at [source-docs/workflow-v1.3.zh-CN.md](source-docs/workflow-v1.3.zh-CN.md); an upstream revision proposal ([source-docs/workflow-v1.3-contradictions.zh-CN.md](source-docs/workflow-v1.3-contradictions.zh-CN.md), 2026-07 讨论稿) argues for rebalancing 预设/生成 — under discussion, not yet adopted (adoption goes through an ADR). The product thesis is in [docs/PRD.md](docs/PRD.md).

Two harnesses live here — do not confuse them:

- **Dev harness** (`harness/`) governs this repo: commit gate, glossary, bilingual parity, house style. It constrains *developers and coding agents*.
- **Runtime harness** (`demo/src/harness/` when built) governs the LLM at runtime: evidence-first, closure loop, stage gates. It constrains *the model*, never the teacher.

## Non-negotiables

1. **The agent never fabricates child evidence.** Any code path, prompt, or doc that lets the model assert children's discoveries/interests/progress without recorded evidence is a defect of the highest severity. This is the product's reason to exist.
2. **Strictness points at the model, not the teacher.** No teacher-facing form UI for state fields; intake is conversational (dynamic screening). If a design forces the teacher to perform the state machine, redesign it.
3. **Culture stays backstage.** Cultural threads are teacher-facing hints translated into child-actionable micro-tasks. Adult slogans as child goals (传承精神、文化责任…) must never appear in child-facing output.
4. **Child-related data is sensitive.** Teachers upload child observations/photos: mainland data residency, minimal retention, scoped access, no third-party model sees child photos without an explicit compliance decision (recorded as an ADR).
5. **Model keys never enter the repo.** Demo keys live in localStorage; production keys live in cloud functions. Any committed secret fails review.

## Working rules

- **The glossary is law.** Canonical terms live in [docs/glossary.json](docs/glossary.json). Forbidden variants are blocking errors. To mention a forbidden term deliberately (e.g., to discuss it), wrap it in `inline code`.
- **Docs are bilingual.** EN and 简中 twins (PRD.md ↔ PRD.zh-CN.md, README pair) are one unit; update both in the same change. Parity is gate-checked.
- **No guessing.** Unknowns (platform behavior, pricing, compliance, spec ambiguities) become recorded open questions — in the doc's own Open Questions section or `docs/GRILLING.md` once it exists. Never invent API behavior, costs, or compliance details.
- **The spec is upstream.** `source-docs/` is an immutable reference (it belongs to 锋/陈枫's process). We do not edit it; deviations from it are deliberate, documented decisions in the PRD or an ADR.
- **Decisions become ADRs** in `docs/adr/` when they are hard to reverse, surprising without context, and the result of a real trade-off. Otherwise skip the ceremony.
- **The gate must pass before a commit.** `node harness/gate.mjs` (or `npm run gate`). Don't bypass with `--no-verify` without a stated reason.
- **The harness asks; it doesn't silently block.** Guarded paths trigger confirmation prompts, not hard failures. Agent-initiated destructive actions (deleting scratch, editing the glossary, bypassing the gate) require explicit user confirmation first.
- **UI is verified by rendering.** Any change to the demo is verified in a real browser (screenshot or interactive check), never by "the server started."
- **New state must be observable and exportable — mandatory design consideration.** Every feature that creates or holds state (client or server) must answer, in its design, before it ships: ① does the debug drawer / session log see it? ② does the client-side export (session-log JSON) carry it? ③ does the server-side / admin export carry it — or is it deliberately client-only, with the reason stated? State that exists only inside a widget is a defect, not an omission. (Added 2026-07-21 after 工作台 批注 and card answers initially shipped without export coverage.)
- **Style.** Plain language a tired teacher could read. Short sentences. No emoji in documentation prose. Full-width punctuation in Chinese prose. Conventional Commits (`feat|fix|docs|design|harness|test|chore|refactor|ci|build|perf`).

## Layout

| Path | What | Owner-ish |
|---|---|---|
| `source-docs/` | V1.3 spec + 2026-07 调整建议 discussion doc (docx + faithful markdown extractions) | Upstream — read-only |
| `docs/` | PRD (EN/zh), ARCHITECTURE, MODEL-APIS, glossary, ADRs | Product |
| `harness/` | Dev harness: gate, checks, judges, config | Governance |
| `demo/` | Web demo: chat UI, runtime harness, model adapter, DESIGN.md | Engineering |
| `tests/` | Node-native tests for the dev harness line | Governance |

## Session hygiene

- End significant sessions with a handoff note in `HANDOFF.md` (create on first use): what changed, what's verified, what's next, open risks.
- Scratch goes in `tmp/` or `.scratch/` (gitignored); `npm run clean:temp` lists/removes it.
