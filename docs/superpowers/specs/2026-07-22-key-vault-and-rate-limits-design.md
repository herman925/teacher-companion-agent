# Per-account server-side key vault + persistent rate limiting — design

Date: 2026-07-22. Status: approved by Herman (this session). Builds on dev tip `4666351`.

## Problem

1. **Cross-account key leak.** BYOK model keys live in browser-wide localStorage (`cst.keys`) and ride every `/api/chat` body. Two accounts in one browser share keys; logout does not clear them; any devtools/XSS access reads them.
2. **No brute-force protection.** `/api/auth/login`, the admin-token check, and 改密码 can be retried without limit. The ADMIN_TOKEN compare is plain `===` (timing-unsafe).
3. **No API quotas.** A single account (or a leaked token) can burn unlimited model-provider spend.

Credential verification itself is already server-side (`store.verifyLogin`, scrypt + `timingSafeEqual`) — confirmed, not part of the problem.

## Decisions (locked)

- **Custody: write-only server vault.** The client sends a key once on save; the server stores it encrypted per-account and injects it at provider-call time. No endpoint ever returns a key value. The client only ever sees 已配置/未配置 flags.
- **Static/offline tier keeps localStorage BYOK** (no backend = no accounts; honest note in the UI). Backend-with-auth tiers (dev + public pilot) use the vault only.
- **Migration: ask once, then purge.** On login with leftover `cst.keys`, one inline prompt — 保存到你的账号 / 仅清除 — and localStorage keys are wiped either way. Never silently import (would gift user A's keys to user B).
- **Rate limits are server-authoritative and persistent.** Counters in the file store, server clock only, survive restarts. Nothing client-supplied is trusted for limiting.
- **No hardware identifiers.** Browsers cannot read HWID/MAC; fingerprinting is spoofable and a PIPL 个人信息 problem. Substitutes: user-id keys for authenticated endpoints (IP rotation irrelevant once a token is required), per-username counters for login (defeats IP rotation for targeted attacks), anonymous random device cookie as a third login key, and a global login circuit breaker for spray attacks. Honest limit: a determined distributed attacker is not fully stoppable at app level; scrypt cost + strong temp passwords remain the floor.
- **Admin relief in `/admin`**: view tripped limits, unlock per-row or all; unlocks are audited.
- **UX: no raw error pages.** 429s render as inline warm-family errors at the surface that caused them, with live countdowns.

## 1. Server key vault

- New `demo/src/key-vault.mjs`: AES-256-GCM encrypt/decrypt with `KEYS_SECRET` (32-byte base64 secret in the VM `.env`, never in the repo). Ciphertext format `v1$ivB64$tagB64$ctB64`. Pure functions; unit tests cover roundtrip, tamper detection (auth-tag failure), and wrong-secret failure. Missing/malformed `KEYS_SECRET` disables the vault with a loud boot warning (login still works; key-save returns 503 with an honest message).
- `store.mjs` grows: `setUserKey(userId, provider, keyOrNull)`, `getUserKeysDecrypted(userId)` (server-internal, never serialized into any response/export), `keyFlags(userId)` → `{glm: true, …}`. Ciphertext persists in `.data/auth/keys.json` (already 403-guarded by the static-handler fix).
- Blast radius, documented: VM compromise exposes `KEYS_SECRET` + ciphertext together — same radius as today's env keys. Rotation = change `KEYS_SECRET`, teachers re-enter keys (decrypt-failure rows are dropped with a journal line, UI shows 未配置).

## 2. API + turn path

- `PUT /api/me/keys/:provider` `{key}` — auth-gated; empty/null deletes. Provider id must be a known registry id or `custom`.
- `GET /api/me/keys` — flags only.
- `runTurn` key precedence when the request carries a valid session: **account keys > env keys > body keys** (body keys effectively vanish because the authed client stops sending them). The no-auth offline/dev tier keeps today's `body.keys` path.
- Isolation tests both directions: A's token cannot read or use B's keys; no token → 401; flags endpoint never contains values (asserted by string-scan of the response).
- Admin console, per-course 下载, 导出全部, session-log export: carry flags at most — a test greps every export payload for a seeded key value and must find nothing.

## 3. Client

- Authenticated + backend online: drawer key fields become write-only (`type=password`, save → PUT → field clears → badge repaints from flags). No localStorage key writes; `chatRequestBody` omits `keys`; `isConfigured(id)` = server flags ∪ env flags. Logout clears in-memory flags and repaints.
- Migration prompt (login, leftover `cst.keys` present): inline in the login flow, not a browser dialog. Both choices wipe `cst.keys` + in-memory copy afterwards.
- Static/offline tier: unchanged behavior + one honest note in the drawer（密钥仅存于此浏览器）.

## 4. Governance

- New ADR `docs/adr/0005-per-account-key-vault-and-rate-limits.md`: custody decision, blast radius, PIPL reasoning for the device cookie, rotation story, why in-file counters (single-process pilot) over external stores.
- SECURITY.md: vault + rate-limit sections; the honest in-file/single-process limits. MODEL-APIS.md §3 custody wording. AGENTS.md non-negotiable #5 updated: demo localStorage wording scoped to the no-backend tier; pilot keys live in the per-account vault.

## 5. Rate-limit gate — persistent, server-authoritative

- New `demo/src/rate-gate.mjs`: sliding-window fail/use counters with pluggable clock (tests inject time). Persisted via the store to `.data/rate-limits.json`, debounced writes; loaded at boot, so restarts do not reset windows.
- Policies (env-overridable defaults):
  - Login fails: 5/15min per-username (success resets), 10/15min per-IP, 10/15min per-device-cookie (`cst_dev` httpOnly random id, set on first visit; anonymous, no PII).
  - Global login circuit breaker: >60 failures/min across all keys → login endpoint answers 429 for 60s (spray-attack slow-mode), journal-logged.
  - Admin-token fails: 5/15min per-IP. ADMIN_TOKEN compare switches to `timingSafeEqual` over sha256 digests.
  - 改密码 old-password fails: 5/15min per-user.
  - Model turns: 30/hour + 200/day per-user (spend protection). Key saves: 20/hour per-user.
- Over limit → `429` + `retry-after` seconds + one generic message（「尝试次数过多，请稍后再试」）— no username-exists oracle. Journal rows carry kind + key (username/IP/user-id), never passwords or keys.
- Both-directions tests: 6th bad login on one username → 429 while a fresh username still gets 401-with-message; window expiry unlocks; turn quota trips at 31 and a different user is unaffected; counters survive a store reload (simulated restart).

## 6. Admin relief + client UX

- `/admin` 限流 section: table of tripped keys (类型, key, 失败次数, 解锁时间) with per-row 解除 and 全部解除; `GET /api/admin/rate-limits`, `DELETE /api/admin/rate-limits/:id`, `DELETE /api/admin/rate-limits`. Every manual unlock writes an audit row.
- Client 429 surfaces, all warm-family, no raw pages:
  - Login pane: inline brick message with live countdown（「尝试次数过多，请 X 分钟后再试」）, retry button disabled until expiry.
  - Chat turn: existing error-notice card, retry re-enabled after `retry-after`.
  - Key save: inline message under the field.

## Out of scope

- Persistent distributed rate limiting (Redis etc.) — single-process pilot; revisit at real scale.
- Password policy changes, 2FA, session hardening — separate work.
- 官方服务 (platform-provided keys) product tier — the vault is a prerequisite, not the product decision.

## Verification

Full gate green; new unit/endpoint tests both directions as listed; browser verification of the exact leak scenario: two accounts in one browser — B never sees or uses A's keys, A's flags reappear on A's login; login lockout countdown renders inline; admin unlock restores login immediately.
