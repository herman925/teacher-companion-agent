# ADR-0002: Pilot backend runs on a Tencent Lighthouse VM, not CloudBase

**Status:** Accepted · 2026-07-14

## Context

[ARCHITECTURE.md](../ARCHITECTURE.md) §5 named Tencent CloudBase as the leading backend (WeChat adjacency, scale-to-zero pricing, managed auth/DB/storage). [DEPLOY.md](../DEPLOY.md) additionally documented Alibaba Function Compute as a working proxy host and flagged that a committed choice deserves an ADR. Meanwhile a concrete constraint arrived: a prepaid Tencent Lighthouse instance (Guangzhou, 2 vCPU / 4 GB / 70 GB SSD, 600 GB/mo traffic, paid through 2027-07) is already owned, and the pilot needs a live backend now. CloudBase also showed platform churn during research (console Agents discontinued 2025-09, token promos ended 2026-06), which weakens the case for coupling early.

## Decision

The pilot backend is the **Lighthouse VM** at `43.136.113.129`: `demo/serve.mjs` under systemd behind nginx, with **PostgreSQL 16 (localhost-only)** as the database and Tencent COS planned for photo/material storage. The turn-pipeline core (adapter, runtime harness, state engine) stays platform-free ESM, so the CloudBase (or FC) path in DEPLOY.md remains a supported future migration, not a fork.

## Consequences

- Always-on process: no cold starts, true SSE streaming, simplest mental model. In exchange we own OS patching, backups (nightly `pg_dump` to COS), and process supervision.
- Fixed cost ≈ 0 until 2027-07 (instance prepaid); dominant spend stays LLM tokens, matching the PRD cost ceiling.
- Data residency: Guangzhou region keeps child-related data onshore (PIPL posture unchanged from ARCHITECTURE.md §6).
- Still blocked on ICP 备案 for a domain + TLS; until filed, the deployment is test-only over bare IP and must carry no real teacher/child data.
- WeChat mini-program synergy is deferred, not lost: CloudBase remains the documented path if that phase arrives, and this ADR must be revisited then.
- Managed-auth/DB/storage conveniences are forgone; a persistence layer (schema, auth, snapshots) must be built on PostgreSQL.

## Alternatives considered

- **Tencent CloudBase (functions-framework)**: still the best WeChat-era fit, but adds platform-churn risk, a new billing model to learn, and no advantage while the VM is already paid for.
- **Alibaba Function Compute**: proven deploy path (DEPLOY.md Option A), but splits the stack across two clouds for no pilot benefit.
- **SQLite on the VM**: zero-ops and adequate at pilot scale, but PostgreSQL costs nothing extra here and avoids a second migration when concurrency or JSONB querying grows.
