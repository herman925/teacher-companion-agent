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
| Secrets custody | Model keys + admin password in server `.env` (chmod 600) or browser localStorage — never the repo | live |
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

## 6. Model API keys — custody, exactly

- **Teacher-supplied keys (BYOK) are never stored server-side**, dev or public. The key lives in that browser's localStorage, travels inside each `/api/chat` request, is used for the single vendor call, and is never written to the store or the logs (the session-log redacts key-shaped values at append time). Nothing to encrypt because nothing persists. Caveats: localStorage is plaintext on the teacher's own machine (client-side encryption would be theater — the page must be able to read it), and until TLS lands the per-request transit is bare HTTP like everything else.
- **Platform keys** (the 官方服务 path) live in the VM's `.env` files, chmod 600, readable only by the service user — permission-protected, not encrypted at rest. Encrypting them at rest on the same box that must read them adds no real barrier; the meaningful upgrades are disk encryption at the cloud layer and a secrets manager, both deferred until past the pilot.
- Rejected alternative (recorded in DATABASE.md §2): storing teacher keys server-side "for convenience" — an encryption-at-rest liability for near-zero benefit.

## 7. Data protection (recap of stricter rules that live elsewhere)

- Child observations/photos are sensitive PI: mainland residency, minimal retention, COS with signed URLs, tombstoned deletion — DATABASE.md §5, ARCHITECTURE.md §6.
- Messages/snapshots are append-only (fabrication resistance); whole-course deletion is data-subject erasure and is allowed — DATABASE.md §4.
- Model keys: server `.env` or the teacher's own browser; never the repo, never the DB.

## 8. Known gaps and planned work

| Gap | Plan |
|---|---|
| No TLS (备案 pending) | Everything above assumes replayable transport; add HTTPS + `Secure` cookies + HSTS the day the domain is filed. Until then: test data only. |
| No rate limiting / lockout on login | Add simple per-IP + per-account backoff before dev→main merge. |
| CSRF | `SameSite=Lax` + JSON-only bodies mitigate; add an origin check on state-changing routes with the merge. |
| Admin console auth = token, not role | Console gets session-based admin login when v1 auth replaces the demo tier; token door then retires. |
| Password path itself | Planned end-state: WeChat + authorized-machine only; passwords remain for admin-provisioned accounts as long as needed. |
| Starter profanity list | Replace with maintained lexicon / Tencent moderation before public launch. |
