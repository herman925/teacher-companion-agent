# SECURITY.md — security, auth, and user management

| | |
|---|---|
| **Status** | v0.1 — 2026-07-15. Written alongside the auth build (steps ①–③, demo tier). |
| **Scope** | The pilot VM deployment (ADR-0002) and the demo persistence tier. Postgres v1 inherits this design ([DATABASE.md](DATABASE.md) §4). |
| **Posture** | Test data only until 备案 + TLS ([OPERATIONS.md](OPERATIONS.md) standing constraints). Child-data rules are AGENTS.md non-negotiable 4 and are stricter than anything here. |

## 1. Layers at a glance

| Layer | Mechanism | Status |
|---|---|---|
| Network | Tencent firewall: only 22/80/443 open; dev instance loopback-only behind SSH tunnel | live |
| Machine auth | SSH keys — admin (`ubuntu`), teammates (`devtunnel`, forward-only, no shell) | live |
| Transport | HTTP on bare IP; **TLS blocked on 备案** — treat every credential as replayable until then | gap (tracked) |
| App auth | Server-side sessions (opaque cookie) + scrypt passwords | this build |
| Authorization | Roles admin/teacher/visitor; every course query scoped by `user_id` | this build |
| Admin console | Two doors: tunnel = machine auth (no password) / public = password sent as SHA-256 | live |
| Secrets custody | Platform keys + admin password in server `.env` (chmod 600); teacher BYOK keys in the per-account encrypted vault (§6) — never the repo | live |
| Rate limiting | Persistent sliding-window gate (§8): login/admin/password fails, per-user turn quotas; admin relief in `/admin` 限流 | live |
| Auditability | `admin_audit` (every admin action) + append-only messages/snapshots/violations | this build |
| Content compliance | Display-name filter (starter list) + vendor-side moderation on all LLM I/O | this build / vendor |

## 2. Authentication

**Sessions, not JWT.** Login creates a row in `sessions` and sets an opaque random token in an `httpOnly`, `SameSite=Lax` cookie. The server looks the token up on every request. Chosen because revocation (a lost phone, a disabled teacher, a leaked device) matters more than statelessness on a single VM; a JWT cannot be recalled before it expires.

- Token: 192-bit random (`crypto.randomBytes`), never logged, never in a URL.
- Lifetime: 30 days rolling — `expires_at` extends on activity.
- **Listing vs bearing:** the token that *is* the session never leaves the server after Set-Cookie. The 登录设备 list and per-device revocation use a separate public `sid`, so one logged-in device can never read (and hijack) another device's bearer token.
- `Secure` flag is intentionally absent until TLS exists; added the day HTTPS lands.

**Passwords.** Hashed with `scrypt` from `node:crypto` (per-user 128-bit salt; N=32768, r=8, p=1; parameters recorded inside the stored string so they can be raised later without a migration). Verification uses `timingSafeEqual`. Plaintext is never stored or logged. Why scrypt and not argon2id: argon2 needs a native dependency; scrypt is built into Node and memory-hard enough for this threat model. Revisit if a dependency budget ever opens (recorded in DATABASE.md).

**Login paths** (build order): ① username + password (admin-provisioned accounts) — live in this build; ② WeChat 小程序 `code2Session` (no password at all; identity = `openid`); ③ SMS code. Teachers on WeChat never touch passwords; passwords exist mainly for admin-created pilot accounts.

**Visitors** hold no session and no row: 演示模式 only, nothing persisted, `/api/courses*` answers 401.

## 3. Authorization

- Roles: `admin`, `teacher` (default), visitor (= no session).
- Every `/api/courses*` handler resolves the user from the session and scopes queries to that `user_id`. There is no "list all courses" outside the admin surface. This single rule is what makes the dev→main merge safe: strangers stop sharing (and deleting) one dataset the moment sessions exist.
- Disabled accounts (`status = 'disabled'`) fail login and their existing sessions stop resolving.
- `must_change_password` marks admin-provisioned accounts until the first password change; the UI opens 用户中心 on the 账号 pane until cleared (soft enforcement in the demo tier; hard enforcement is a v1 decision).

## 4. Admin console and user management

Two doors, one console (`/admin`):

1. **Tunnel (machine auth).** A teammate's SSH key, approved by Herman, is the authentication; the dev instance never sets `ADMIN_TOKEN`, so inside the tunnel the console needs no password.
2. **Password (unauthorized device).** The public instance sets `ADMIN_TOKEN` server-side; the page sends its SHA-256, never plaintext, never in a URL. Without TLS this hash is replayable by an on-path observer — the hash protects the *password*, TLS (pending) protects the *session*. Planned: retire this door entirely; authorized machines only.

**用户 tab (user management).**

- **Create account, registration-free:** admin enters a username (+ optional display name); the server generates a one-time temporary password, shown exactly once, and flags `must_change_password`. This is deliberately how pilot teachers are provisioned from outside the mainland — no SMS, no WeChat, no registration flow needed.
- **Reset password:** same one-time-temp mechanism.
- **Disable / enable / role change:** two-step confirms; disable kills login and live sessions.
- **Audit:** every one of these actions writes an `admin_audit` row (who, what, whom, when). Existing repo rule: no admin backdoor without a trail.

## 5. Display names and content compliance

User-visible names in a mainland deployment are a compliance surface, not a cosmetic one.

- Uniqueness: system-wide, enforced at write.
- Change cadence: once per 6 months (`display_name_changed_at`).
- Charset and length: 2–20 chars, CJK/latin/digits/`_-·` only (blocks zero-width and homoglyph tricks).
- Filtering: checked server-side on every write against a bundled starter wordlist (CN + EN profanity). **The starter list is not a compliance guarantee** — production must use a maintained lexicon or Tencent 内容安全 text moderation (same API family already noted in ARCHITECTURE.md §6), because the politically-sensitive vocabulary changes and should not be hand-maintained in this repo.

## 6. Model API keys — custody, exactly (revised 2026-07-22, ADR-0005)

- **Teacher-supplied keys (BYOK) live in a per-account server-side vault** when the backend runs with auth + `KEYS_SECRET` (dev and public pilot). Saved once via `PUT /api/me/keys/:provider`, encrypted AES-256-GCM at rest (`.data/auth/keys.json`, ciphertext only), decrypted server-side at provider-call time. **Write-only**: no endpoint returns a key value — the client sees 已配置/未配置 flags. Admin console, exports and session logs carry flags at most (regression-tested by string-scanning every export for a seeded key).
- **Why the reversal** (the old rule said "never stored server-side"): localStorage is browser-wide, not account-wide — on a shared machine every account saw and used the previous person's keys, and any XSS read them wholesale. Cross-account leakage on real shared devices outweighed the encryption-at-rest liability. The old caveat stands where it still applies: the **no-backend static/offline tier keeps localStorage BYOK**, with an in-UI note that keys stay in that browser.
- **Migration**: on login with leftover localStorage keys the UI asks once — 保存到你的账号 or 仅清除 — and purges the browser copy either way. Never silently imported (that would gift user A's keys to whoever logs in next).
- **Blast radius, honestly**: `KEYS_SECRET` sits in the same VM `.env` as everything else, so a box compromise exposes secret + ciphertext together — the same radius as env-seeded platform keys. Rotation = change `KEYS_SECRET`; rows that stop decrypting read as absent and teachers re-enter. The meaningful upgrades remain cloud-layer disk encryption and a secrets manager, deferred past the pilot.
- **Platform keys** (the 官方服务 path) are unchanged: VM `.env`, chmod 600, permission-protected.

## 7. Data protection (recap of stricter rules that live elsewhere)

- Child observations/photos are sensitive PI: mainland residency, minimal retention, COS with signed URLs, tombstoned deletion — DATABASE.md §5, ARCHITECTURE.md §6.
- Messages/snapshots are append-only (fabrication resistance); whole-course deletion is data-subject erasure and is allowed — DATABASE.md §4.
- Model keys: server `.env` (platform) or the per-account encrypted vault (teacher BYOK, §6); plaintext keys never in the repo, the DB, exports, or logs.

## 8. Rate limiting (built 2026-07-22, ADR-0005)

Persistent sliding-window counters (`demo/src/rate-gate.mjs`), server clock only, stored in `.data/auth/rate-limits.json` — restarts do not reset windows. Nothing client-supplied is trusted as a counter value.

| Surface | Keying | Default |
|---|---|---|
| Login failures | per-username (success resets) · per-IP · anonymous device cookie | 5 · 10 · 10 / 15min |
| Login spray (circuit breaker) | global failures/min → login answers 429 briefly | 60/min |
| Admin-token failures | per-IP (compare is `timingSafeEqual`, was plain `===`) | 5 / 15min |
| 改密码 old-password failures | per-user | 5 / 15min |
| Model turns (spend protection) | per-user (per-IP when anonymous); mock exempt | 30/h + 200/day |
| Key saves | per-user | 20/h |

Defaults are env-overridable (`RATE_*`). Over-limit answers `429` + `retry-after` with one generic message — no username-exists oracle. The UI renders these inline (login gate countdown, chat error card, key-field note), never as raw error pages. Admins see and clear counters in `/admin` → 限流 (every unlock audited). Honest limits: single-process, keyed on spoofable signals below the username level; the real defenses remain scrypt cost, strong temp passwords, and the per-username counter (IP rotation does not help a targeted attack). Browsers cannot read HWID/MAC, and fingerprinting was rejected as both spoofable and a PIPL 个人信息 problem — the anonymous device cookie is the deliberate middle ground.

## 9. Known gaps and planned work

| Gap | Plan |
|---|---|
| No TLS (备案 pending) | Everything above assumes replayable transport; add HTTPS + `Secure` cookies + HSTS the day the domain is filed. Until then: test data only. |
| CSRF | `SameSite=Lax` + JSON-only bodies mitigate; add an origin check on state-changing routes with the merge. |
| Admin console auth = token, not role | Console gets session-based admin login when v1 auth replaces the demo tier; token door then retires. |
| Password path itself | Planned end-state: WeChat + authorized-machine only; passwords remain for admin-provisioned accounts as long as needed. |
| Starter profanity list | Replace with maintained lexicon / Tencent moderation before public launch. |
