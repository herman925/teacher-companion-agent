# ADR-0005 — Per-account server-side key vault + persistent rate limiting

| | |
|---|---|
| **Status** | Accepted — 2026-07-22 |
| **Context** | Spec: [docs/superpowers/specs/2026-07-22-key-vault-and-rate-limits-design.md](../superpowers/specs/2026-07-22-key-vault-and-rate-limits-design.md). Supersedes the custody position recorded in SECURITY.md §6 (v0.1) and DATABASE.md §2 ("teacher keys are never stored server-side"). |

## Decision

1. **Teacher BYOK keys move from browser localStorage into a per-account, server-side, write-only vault.** Saved once (`PUT /api/me/keys/:provider`), encrypted AES-256-GCM under `KEYS_SECRET` (server `.env`), decrypted only at provider-call time. No endpoint returns a key value; the client sees 已配置/未配置 flags. The no-backend static/offline tier keeps localStorage BYOK with an in-UI note.
2. **Existing browser keys are migrated by asking, never by importing.** One login-time prompt（保存到你的账号 / 仅清除）; both choices purge the browser copy. Silent import was rejected: on a shared machine it gifts the previous person's keys to whoever logs in next — the leak being fixed.
3. **Rate limiting becomes server-authoritative and persistent.** Sliding-window counters (`demo/src/rate-gate.mjs`) on the server clock, stored in the file store, surviving restarts. Login failures key on username (primary), IP, and an anonymous device cookie, with a global circuit breaker; admin-token and old-password failures are gated; model turns carry per-user (per-IP when anonymous) spend quotas. Admins view and clear counters in `/admin` → 限流 (audited). The admin-token compare moved to `timingSafeEqual`.

## Why the custody reversal

The old position optimized against an encryption-at-rest liability and assumed one browser ≈ one teacher. The pilot broke that assumption: accounts share machines, and localStorage is browser-scoped — every account on a device saw and could use the previous account's keys, and any XSS read them wholesale. A cross-account credential leak on real shared devices outweighs the liability of ciphertext on the same disk as its secret.

## Honest limits (recorded, not hidden)

- A VM compromise exposes `KEYS_SECRET` and the ciphertext together — the same blast radius as env-seeded platform keys. Rotation = change the secret; undecryptable rows read as absent and teachers re-enter. Real upgrades (cloud disk encryption, secrets manager) stay deferred past the pilot.
- Browsers cannot read HWID/MAC; device fingerprinting was rejected as spoofable and a PIPL 个人信息 collection problem. The device cookie is an anonymous random id — a supplement, not a defense. The per-username counter is what defeats IP rotation for targeted attacks; distributed spray attacks are slowed (circuit breaker), not fully stoppable at app level.
- Counters are single-process and file-backed — correct for the pilot VM, replaced by an external store if the deployment ever becomes multi-process.

## Consequences

- SECURITY.md §6/§8 rewritten; DATABASE.md §2 and AGENTS.md non-negotiable 5 updated.
- The client stops sending `keys` in turn bodies when the vault is active; server key precedence is account > env > body.
- `KEYS_SECRET` (≥16 chars) must be provisioned in each instance's `.env`; without it the vault disables loudly (key-save answers 503, login unaffected) and the legacy localStorage path remains.
