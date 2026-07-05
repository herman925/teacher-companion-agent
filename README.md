# China Teacher Resources Development Platform

中文版本：[README.zh-CN.md](README.zh-CN.md)

A web-based AI companion (陪跑智能体) that accompanies kindergarten teachers through local-culture theme-inquiry courses — from resource intent, through evidence-driven action cycles, to the final course story (课程故事). Built on the V1.3 integrated workflow spec (番禺幼教AI主题探究陪跑智能体集成工作流).

## The one-sentence thesis

The workflow spec is strict; a naive implementation becomes a form-filling bot. This platform aims the strictness at the model (runtime harness: evidence-first, closure loops, stage gates) while the teacher gets a natural conversation (dynamic screening: read state first, one question at a time, always with examples).

## Repository map

| Path | Contents |
|---|---|
| `source-docs/` | The V1.3 workflow spec (docx + faithful markdown extraction). Upstream reference — read-only. |
| `docs/` | [PRD (EN)](docs/PRD.md) · [PRD (简中)](docs/PRD.zh-CN.md) · [ARCHITECTURE](docs/ARCHITECTURE.md) · [MODEL-APIS](docs/MODEL-APIS.md) · [glossary](docs/glossary.json) · ADRs |
| `harness/` | Dev harness: commit gate, glossary/parity/style checks. See [AGENTS.md](AGENTS.md). |
| `demo/` | Minimal-loop web demo: chat UI + runtime harness + model adapter. |
| `tests/` | Node-native tests for the harness line. |

## Getting started

```bash
npm install        # zero dependencies; wires git hooks
npm run gate       # run the full dev-harness gate
npm test           # harness-line tests
```

Demo (once built): `node demo/serve.mjs`, open the printed URL, paste a MiniMax/GLM/Kimi API key in the settings drawer.

## Status

Phase 0 — spec, governance, architecture exploration, and the §7 minimal-loop demo. AI drawing, WeChat Mini Program packaging, and real accounts are deliberately deferred; see [PRD §5.2](docs/PRD.md).

## Working agreements

Humans and coding agents both follow [AGENTS.md](AGENTS.md). The glossary is law; docs are bilingual twins; the gate must pass before commits; child evidence is never fabricated.
