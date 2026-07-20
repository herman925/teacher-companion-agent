# Release 2026-07-20 — Blueprint workspace (dev + public)

Head: `d39ec72` · deployed to the dev instance and the PUBLIC instance (43.136.113.129, `channel: public` verified live). Nine feature commits `805aa88..d39ec72`. 211/211 tests, full gate green.

## Success criteria — affirmation with evidence

| # | Criterion | Delivered | Evidence |
|---|---|---|---|
| 1 | Harness thorough and reliable | 211 tests, every rule with both-direction fixtures; 3 multi-agent adversarial workflows (36 agents) — 23 confirmed findings, all fixed and pinned with tests | `demo/tests/blueprint*.test.mjs`, `tests/integration/harness-line.test.mjs`; workflow findings in HANDOFF 2026-07-19/20 entries |
| 2 | Blueprint useful to teachers; grows pedagogy, offers choices, inspires | 枫's five steps with full week-1 教案 (目的/流程/材料/安全/观察点/表征), per-resource 材料清单, printable 家长信, 换个玩法 variants, why-notes, rationale quoting the teacher's own words; the direction pick kept as the teacher's own judgment (never rubber-stamped); scored by a 3-lens pedagogy judge panel whose findings were all closed | `demo/src/mock.mjs` blueprint turns; panel verdicts + fixes in HANDOFF (final entry); field measurement = ADR-0003 Phase 2 on the live public instance, metrics pre-registered |
| 3 | Client-side processing reduces server load | Numbering, collapse, status rollups, tidy-tree geometry, SVG render, entry/FLIP motion, filtering, bulk-confirm resolution — all computed in the browser; the server ships structure once | `demo/src/blueprint-util.mjs`, `demo/src/blueprint-map-layout.mjs`, `demo/src/ui/render.js` |
| 4 | Elegant, no overlap, motion-captivating | Four distinct chat surface categories, one column width, uniform bubbles, aligned status gutter, distinct status palette (信任蓝/待验证紫), grow-from-parent map entry with edge draw-on and FLIP reflow, GSAP `clearProps` overlap fix, two-theme + 375px verification | DESIGN.md §2a-status/§4/§4b/§5b; screenshots under `tmp/` from the verification runs |
| 5 | 小程序 compatibility and compliance reflected | Three-tier path; 企业主体-only web-view, 备案≥24h + HTTPS + 业务域名, Skyline limitation, POST-SSE streaming named as the Tier-2 gate (real-device measurement required), 深度合成-AI问答 类目 + vendor 算法备案 path, 2025-09 AI-labelling rule, UnionID one-account design; six open questions recorded, no guessing | ARCHITECTURE.md §7b |

Also in this release: the 导图 system decision (mermaid/drawio/excalidraw evaluated and rejected — DESIGN.md §4 decision record; ~250 owned lines instead), 用户中心 as the settings home verified mobile full-sheet, the session-log diagnosis (stage-5 dead-end → honest horizon handles + recap), and md updates across DESIGN / ARCHITECTURE / DATABASE / PRD twins / ADR-0003 / HANDOFF.

Known user-side dependencies: pilot-teacher field measurement (Phase 2, instrumentation shipped) and the real-device web-view streaming test (Tier-2 gate).
