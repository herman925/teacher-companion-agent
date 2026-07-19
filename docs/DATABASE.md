# DATABASE.md — Data shape and API surface

| | |
|---|---|
| **Status** | Design v0.1 — 2026-07-14. PostgreSQL is provisioned on the pilot VM (ADR-0002); the persistence layer described here is **not yet implemented** — today `demo/serve.mjs` is stateless and course state lives in browser localStorage. A **demo persistence tier** (JSON store, §4) is designed as the runnable bridge for demonstrating real server-side chat history on localhost or the Tencent VM, ahead of the full Postgres build. |
| **Engine** | PostgreSQL 16, localhost-only on the pilot VM, database `teacher_platform` |
| **Upstream design** | [ARCHITECTURE.md](ARCHITECTURE.md) §4–§5 (state engine, DB modeling rules) |
| **State schema** | [harness/schema/course-state.schema.json](../harness/schema/course-state.schema.json) — single source of truth for the course state document |

## 1. Modeling principles

1. **Hybrid relational + JSONB.** Row-shaped data (users, messages, violations) gets columns and indexes; the course state document stays one JSONB value validated against the JSON Schema above. The schema file is law — the DB never invents its own shape for course state.
2. **Append-only where auditability matters.** Messages, snapshots, and violations are never updated or deleted by application code. This is the fabrication-resistance promise made queryable: every child-evidence claim must trace to stored rows.
3. **The engine writes state; the LLM never touches the DB.** Only the deterministic engine (after L3 validation) applies a state delta and writes the new snapshot, inside one transaction.
4. **Owner scoping everywhere.** Every query filters by the authenticated teacher's `user_id`. No cross-teacher reads; no admin backdoor without an audit trail.
5. **No binary child data in the DB.** Photos and materials live in object storage (Tencent COS, private bucket, signed URLs); the DB stores references and consent/retention metadata only.

## 2. Tables

```sql
-- Teachers (the only human users in v1)
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         text UNIQUE,                 -- SMS login (v1); nullable for invite-code pilots
  display_name  text NOT NULL,
  password_hash text,                        -- argon2id; NULL when SMS-only
  invite_code   text,                        -- pilot onboarding path
  settings      jsonb NOT NULL DEFAULT '{}', -- UI prefs, preferred provider — never secrets
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

-- One row per theme-inquiry course a teacher runs.
-- A course IS the conversation thread: companion coaching runs one long
-- chat per course, so there is no separate "conversation" entity —
-- course id doubles as the conversation id everywhere.
-- Quota: max 30 courses per user (abuse guard, enforced in the create
-- endpoint; teachers realistically run 2–5 per semester).
CREATE TABLE courses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  title         text NOT NULL,               -- e.g. 「醒狮」
  course_state  jsonb NOT NULL,              -- current document, validates against course-state.schema.json
  state_version integer NOT NULL DEFAULT 0,  -- bumps on every applied delta
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_courses_owner ON courses (user_id, updated_at DESC);

-- Immutable audit trail: one row per applied state delta (ARCHITECTURE.md §4).
-- Storage strategy: delta-always + checkpoint. Every row carries state_delta
-- (small). The full course_state document is stored ONLY at checkpoints —
-- every CHECKPOINT_EVERY = 20 versions and on any stage change — never every
-- turn. Reconstruct version V: load the nearest checkpoint <= V, replay the
-- deltas forward. Preserves audit + recovery (PRD user story 25) at ~1/20 the
-- snapshot storage of full-document-per-turn.
CREATE TABLE course_snapshots (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  course_id     uuid NOT NULL REFERENCES courses(id),
  state_version integer NOT NULL,            -- version AFTER applying the delta
  state_delta   jsonb NOT NULL,              -- validated delta that produced this version (always present)
  course_state  jsonb,                       -- full document; NON-NULL only when is_checkpoint
  is_checkpoint boolean NOT NULL DEFAULT false,
  message_id    bigint,                      -- the turn that proposed it (FK added after messages)
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, state_version)
);
-- Fast "nearest checkpoint <= V" lookup for reconstruction
CREATE INDEX idx_snapshots_checkpoint ON course_snapshots (course_id, state_version DESC) WHERE is_checkpoint;

-- One row per chat message — never an unboundedly growing document
CREATE TABLE messages (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  course_id     uuid NOT NULL REFERENCES courses(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  role          text NOT NULL CHECK (role IN ('teacher','agent','system')),
  content       text NOT NULL,               -- teacher text or validated reply_markdown
  turn_contract jsonb,                       -- parsed turn for agent rows: closure_loop, evidence_refs, asks. state_delta is NOT duplicated here — it lives in course_snapshots (single home)
  provider      text,                        -- minimax | glm | kimi | qwen | mock …
  usage         jsonb,                       -- prompt/completion token counts for cost tracking
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_messages_course ON messages (course_id, id);

-- Runtime-harness violations (L3 failures, L4 outcomes) — product telemetry
CREATE TABLE violations (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  course_id     uuid REFERENCES courses(id),
  message_id    bigint REFERENCES messages(id),
  rule          text NOT NULL,               -- e.g. closure-loop-incomplete, evidence-missing, adult-slogan
  detail        jsonb NOT NULL,
  resolution    text NOT NULL CHECK (resolution IN ('regenerated','safe-template','passed-after-retry')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Uploaded evidence and generated materials: COS references, never blobs
CREATE TABLE materials (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id     uuid NOT NULL REFERENCES courses(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  kind          text NOT NULL CHECK (kind IN ('photo','observation','document','generated')),
  cos_key       text NOT NULL,               -- object key in the private COS bucket
  mime_type     text NOT NULL,
  contains_children boolean NOT NULL DEFAULT false,  -- drives retention + access rules
  retention_until   date,                    -- minimal-retention policy, set on upload
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_materials_course ON materials (course_id, created_at DESC);
```

Evidence referencing: a turn's `evidence_refs[]` point at `messages.id` and `materials.id` rows. The L3 fabrication heuristic (child-claims require evidence) resolves against these tables — that is why they are append-only.

### Sizing and lookup (why this is enough)

A message row is ~1–5 KB (teacher text or reply plus `turn_contract` JSONB; Postgres TOAST-compresses large JSONB automatically). Messages, worst case per teacher: 30 courses × ~200 turns × 5 KB ≈ 30 MB; a 50-teacher pilot tops out around 1.5 GB against 60+ GB of disk.

Snapshots are the bigger line item, and the reason for the checkpoint scheme above. The `course_state` document grows all course long (evidence ledger + `cycle_history`), reaching tens of KB late in a course. Writing the full document every turn would cost ~doc_size × turns ≈ 10 MB/course ≈ 300 MB/teacher — roughly 10× the messages. Writing the full document only every 20th version plus on stage change (deltas between) cuts that to ~1/20 while keeping full audit and replay: reconstruct any version from the nearest checkpoint plus a bounded delta replay.

Chat history is not a storage problem — photos are, which is why they live in COS, not here. Retrieval for display is the `(course_id, id)` index: a page of history is one index-range scan regardless of table size. The LLM prompt uses a much smaller window — the last 10 messages plus the current `course_state` document (the document already holds every fact; recent turns only supply conversational flow) — so per-turn token cost stays flat as history grows. Full-text search over history is deliberately out of v1; add `pg_trgm`/FTS only when a teacher actually asks to search old chats.

### What we deliberately do NOT store

- **Teachers' own model API keys.** Production model: platform-seeded keys in server env, platform pays for tokens, per-teacher spend tracked via `messages.usage`. A teacher-supplied key (dev/testing) stays in that browser's localStorage and travels per-request, exactly as today — it never lands in a table. Storing vendor keys server-side would add an encryption-at-rest liability for near-zero benefit; if a real need ever appears, that is its own ADR.
- **Secrets of any kind in `users.settings`** — prefs only; the API layer must reject writes containing key-shaped values (same redaction lexicon as the session-log panel).

### 2b. Blueprint persistence (Phase-3 design; ADR-0003)

The 课程预设蓝图 is a versioned tree that lives **inside `course_state`** as `course_plan_blueprint` — it needs no relational node table. Rationale: the tree is always read and written whole-or-by-delta with the course (never queried across courses by node), JSONB keeps it schema-checked by `course-state.schema.json`, and the existing checkpoint-snapshot machinery gives version history and replay for free — `blueprint_delta`s ride `state_delta` in `course_snapshots`, full documents at checkpoints. A node table would buy cross-course node queries nobody has asked for, at the price of a second consistency domain.

Node shape (each node, arbitrary depth — the mindmap's "relationships" are exactly this containment tree plus `evidence_refs` pointers into the evidence ledger; no separate edge storage):

```jsonc
{
  "id": "network_map.guanxi",          // stable slug; display numbers are client-derived, never stored
  "title": "关系层", "body": "……",
  "status": "confirmed | teacher_preset | ai_suggestion | hypothesis | pending_validation",
  "rationale": {                        // why this node exists — powers the detail view (DESIGN.md §5b)
    "heard":   [{ "quote": "附近有醒狮队，可以约参观", "msg_id": "…" }],  // verbatim teacher words / Q-and-A that produced it
    "assumed": "班里孩子对面具类道具敏感，入口偏物象层",                 // the guess, when it is one
    "pedagogy": "共同经验先行——幼儿园教育基于经验（小小探索家五步）",       // why the guess is professionally sound
    "profile_basis": "教师档案：中班、30人、番禺"                        // which profile/history facts informed it
  },
  "evidence_refs": ["ev-…"],           // links into children_evidence once field data confirms it
  "added_v": "v0.1", "changed_v": "v0.2",
  "children": [ /* same shape */ ]
}
```

Alongside the tree: `blueprint_version`, `revision_log[]` (`{v, node_id, op, basis}` — why the plan changed), `validation_queue[]` (derived from hypothesis-status nodes; drives 轻量回传). Status escalation to `confirmed` is engine-only (teacher UI event or evidence), never model-written — the truth/guess tag pipeline from the 2026-07-17 meeting is this field plus that rule.

**Future profile enrichment (recorded, not designed):** `users.settings.profile` stays the structured v1 profile. A richer longitudinal profile — accumulated preferences, interaction style, vectorized memory over past courses — is a separate post-pilot design with its own PIPL surface (profiling of identifiable persons); park it as open question 6 below and do not bolt vectors onto `users.settings`.

## 3. Transaction shape of one validated turn

Single transaction, after L2–L4 succeed:

1. `INSERT` teacher message → `messages`
2. `INSERT` agent message (validated turn contract) → `messages`
3. Engine applies `state_delta` → `UPDATE courses SET course_state, state_version = state_version + 1`
4. `INSERT` into `course_snapshots`: always the validated `state_delta`; the full `course_state` document only when this version is a checkpoint (every 20th version or a stage change), with `is_checkpoint = true`
5. `INSERT` any violations recorded on the way → `violations`

Concurrency guard: the `UPDATE` carries `WHERE state_version = $expected` (optimistic lock). A stale write aborts the whole transaction — no half-applied turns.

## 4. API surface

### Today (implemented in `demo/serve.mjs`)

| Method + path | Purpose | Auth |
|---|---|---|
| `GET /*` | Static demo UI | none |
| `POST /api/chat` | One turn through the pipeline (adapter → harness L2–L4 → engine). State travels with the request; SSE same-origin, buffered JSON cross-origin. | none (test-only) |

### Demo persistence tier (JSON store) — the runnable bridge

Today the demo is stateless: `course_state` + transcript live in the browser's localStorage and travel with every `/api/chat` request. That survives a page reload in one browser, but it is not chat history in any real sense — no cross-device, no course list, nothing on the server. To *demonstrate* chat history (survives across devices, a course/history list, the actual one-row-per-message model) the demo grows a thin server-side store, runnable on localhost and the Tencent VM. GitHub Pages cannot host this tier — it is static, no server — which is why it is scoped out. Test data only until 备案 (OPERATIONS.md); JSON files sit on the VM's local disk, onshore.

**One swappable interface (`demo/src/store.mjs`)** so the JSON implementation now and a Postgres implementation later are drop-in behind the same calls — callers, client, and pipeline never learn which is underneath:

```
listCourses(userId)                        -> [{ id, title, updated_at }]
createCourse(userId, title)                -> course            // enforces the 30-course quota (§2)
getCourse(userId, courseId)                -> course + course_state (head)
appendMessage(courseId, msg)               -> message row       // append-only
getMessages(courseId, { before, limit })   -> paged history
saveState(courseId, delta, newState, ver)  -> void             // optimistic lock on ver (§3)
```

- **Now:** `demo/src/store/json-store.mjs` → one JSON file per course under `demo/.data/` (gitignored — child-data non-negotiable #4). Whole-file read/write; fine at demo scale (one teacher, a few courses).
- **Later:** `demo/src/store/pg-store.mjs` → the §2 tables, same interface, no caller changes.

**Endpoints the demo grows** — a subset of the v1 surface below, with a single hard-coded demo user (no auth this tier):

| Method + path | Purpose |
|---|---|
| `GET /api/courses` | List the demo user's courses |
| `POST /api/courses` | Create a course (starts stage 0; rejects past the 30-course quota) |
| `GET /api/courses/:id` | One course with its current state document |
| `GET /api/courses/:id/messages?before=&limit=` | Paged chat history |
| `POST /api/courses/:id/chat` | Turn endpoint with **server-side state** — replaces stateless `/api/chat`: server loads state + last 10 messages, runs the same pipeline, appends both message rows, saves the new state |
| `PATCH /api/courses/:id` | Rename a course (owner only; 1–16 chars). Sets `title_locked` so auto-titling never overwrites a human choice. |
| `DELETE /api/courses/:id` | Delete one course the demo user owns. The history rail's multi-select and delete-all loop this endpoint. |

Auto-titling: after each accepted turn, an untitled course (still 新课程, not `title_locked`) takes its name from `course_state.theme_resource.name` — the model already extracts the theme through the normal `state_delta` pipeline, so no extra LLM call and no schema change. If no theme exists yet, the first teacher message trimmed to 16 chars is used as a stopgap. The admin data listing joins `users` so consoles show `username（昵称）` instead of raw ids; UUIDs remain in the full record.
| `GET /admin` · `GET/DELETE /api/admin/*` | Data console (`admin.html`): list all courses with message/snapshot counts, view a full record, export all, delete/multi-delete. Auth: `ADMIN_TOKEN` env gates the API — the page sends SHA-256 of the password in `x-admin-token` (plaintext also accepted for curl). Unset = open, correct only on the tunnel-gated dev instance (tunnel = machine auth). Planned: password retired, authorized-machine only. See OPERATIONS.md "Inspecting demo data". |

Deletion vs append-only: §1 keeps messages/snapshots append-only so child-evidence claims stay auditable — that rule governs edits *within* a course. Deleting a *whole* course is a different act: a data subject erasing their own record (PIPL right to erasure), legitimate even in v1. The demo JSON store hard-deletes the course file. For Postgres v1, course deletion should be a soft-delete/archive (tombstone the row, purge on the retention timer, cascade COS deletion for child materials) rather than a hard `DELETE`, so an in-flight audit is never silently broken — a persistence-layer-build decision, flagged here.

**Maps to the v1 tables** `courses` + `messages` exactly, so client and pipeline shape do not change when Postgres lands. **Skipped this tier:** auth (one demo user), `course_snapshots` checkpointing (optional — deltas can be appended to the same JSON for a replay demo), `violations`/`materials` (unchanged from today). The one-row-per-message model and the load-last-10 prompt window (§ sizing) are honored as-is.

**Client change (`main.js`):** localStorage stays as an offline cache, but when `apiBase` points at a server the course list and history load from `/api/courses…`, and a turn posts `courseId + message` (server owns history) instead of shipping the whole transcript each turn.

### Accounts, roles, and login (v1 design — gates the dev→main merge)

Publishing the persistence tier to the public instance is blocked on auth: today it is one shared demo user, so the open internet would share (and could delete) one dataset. Design of record:

- **Roles**: `admin`（Herman/运营 — full console, user management）, `teacher`（own courses only — every query already scopes by `user_id`, so history sharing disappears the moment login exists）, `visitor`（演示模式 only: mock provider, nothing persisted）. Stored as `users.role text NOT NULL DEFAULT 'teacher'`.
- **Login paths, in priority order**:
  1. **WeChat（小程序 + web 扫码）** — the pilot audience lives there. 小程序 gets `wx.login` → `code2Session` → stable `openid` (no password at all); phone number via the button-based phone-auth capability when we need a contact channel. Web login needs the Open Platform website app + filed domain (ARCHITECTURE.md §5).
  2. **SMS code** — mainland-native fallback (~¥0.05/条), doubles as the phone-binding step.
  3. **Admin-created accounts** — the admin console gets a 用户管理 tab: create/invite accounts (username + one-time password), reset passwords, disable users, assign roles. This is deliberately registration-free so Herman can provision pilot teachers from outside the mainland without touching WeChat/SMS flows.
  4. Email is recorded as unlikely: mainland teachers rarely use it and deliverability from a mainland VM is poor — revisit only if a real cohort asks.
- **Display name (昵称)**: system-unique; changeable once per 6 months (`users.display_name_changed_at`); filtered through a CN+EN profanity/sensitive-word list on set — a content-compliance requirement for anything user-visible in mainland deployments, not a nicety.
- **Real-name question (open, verify before launch)**: WeChat accounts are already real-name-verified at the platform level (phone binding under the real-name rules), and the mini-program *developer subject* must be verified. Whether **we** must additionally collect user identity depends on the service category regulations for education/content services — do not assume either way; resolve during 备案/登记 with the platform checklists. Recorded as open question #4 below.

**Schema (build spec).** Extends §2 `users`; visitor is not a row — it is the absence of a session (演示模式 only, nothing persisted).

```sql
ALTER TABLE users
  ADD COLUMN role text NOT NULL DEFAULT 'teacher' CHECK (role IN ('admin','teacher')),
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  ADD COLUMN wechat_openid text UNIQUE,          -- code2Session identity (小程序)
  ADD COLUMN display_name_changed_at timestamptz,-- 6-month change lock
  ADD COLUMN must_change_password boolean NOT NULL DEFAULT false, -- admin-created accounts
  ADD COLUMN created_by uuid REFERENCES users(id);
CREATE UNIQUE INDEX idx_users_display_name ON users (display_name);

-- Server-side sessions: opaque 128-bit id in an httpOnly SameSite=Lax cookie.
-- Chosen over JWT because revocation (lost phone, disabled account) matters
-- more than statelessness on a single VM.
CREATE TABLE sessions (
  id           text PRIMARY KEY,                 -- random, url-safe
  user_id      uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,             -- 30-day rolling
  revoked_at   timestamptz,
  user_agent   text                              -- 用户中心 device list
);
CREATE INDEX idx_sessions_user ON sessions (user_id);

-- Every admin action on another user is auditable (no admin backdoor without a trail, §1).
CREATE TABLE admin_audit (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_id    uuid NOT NULL REFERENCES users(id),
  action      text NOT NULL,                     -- create_user | reset_password | disable_user | enable_user | set_role
  target_user uuid REFERENCES users(id),
  detail      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

Passwords: hashed with `scrypt` from `node:crypto` (per-user salt, cost recorded in the hash string) — zero-dep; §2's argon2id note upgrades to a real dependency decision only if one is ever accepted. Admin-created accounts get a one-time temporary password (shown once in the console) plus `must_change_password`.

**Auth endpoints (extends the v1 table below).**

| Method + path | Purpose |
|---|---|
| `POST /api/auth/login` | username/phone + password → session cookie |
| `POST /api/auth/wechat` | 小程序 `code` → `code2Session` (appid/secret server-side) → find-or-create by `wechat_openid` → session |
| `POST /api/auth/logout` | revoke the session |
| `GET /api/me` | current user, role, teacher profile |
| `PATCH /api/me` | display name (uniqueness + 6-month lock + profanity list, server-checked), password change, teacher profile |
| `GET /api/me/sessions` · `DELETE /api/me/sessions/:id` | 用户中心 device list + revoke |
| `GET /api/admin/users` | list users (admin) |
| `POST /api/admin/users` | create account; returns the one-time temp password (admin) |
| `PATCH /api/admin/users/:id` | reset password / disable / enable / set role (admin; all writes → `admin_audit`) |

The teacher profile moves server-side into `users.settings.profile` so it follows the account across devices; the demo's localStorage profile remains the visitor/offline path. The CN+EN profanity wordlist is a bundled data file checked server-side on every display-name write.

**Build order** (each step shippable): ① sessions + password login + per-user scoping on `/api/courses*` — this alone unblocks dev→main; ② 用户中心 (people icon); ③ admin console 用户 tab + audit; ④ WeChat 小程序 login; ⑤ SMS.

### Needed once persistence lands (v1 target)

| Method + path | Purpose |
|---|---|
| `POST /api/auth/login` | SMS code or invite-code + password → session cookie |
| `POST /api/auth/logout` | End session |
| `GET /api/courses` | List the teacher's courses |
| `POST /api/courses` | Create a course (starts stage 0 intake; rejects beyond the 30-course quota) |
| `GET /api/courses/:id` | Course with current state document |
| `GET /api/courses/:id/messages?before=<id>` | Paged chat history |
| `POST /api/courses/:id/chat` | The turn endpoint, server-side state (replaces stateless `/api/chat`) |
| `POST /api/materials/upload-url` | Mint a short-lived signed COS upload URL (client uploads direct — bytes never transit the VM) |
| `GET /api/materials/:id/view-url` | Mint a short-lived signed view URL, owner-checked |
| `GET /api/courses/:id/export` | Stage-5 story export (gap-check first, per stage-gate table) |
| `GET /api/healthz` | Liveness for monitoring |

Everything under `/api/` except `login` and `healthz` requires the session and is scoped to the session's `user_id`. No admin API in v1 — operational queries go through `psql` with an audit note in HANDOFF.md.

## 5. Backups and retention

- Nightly `pg_dump` to the private COS bucket (cron on the VM); 30-day rolling window.
- `materials` rows with `contains_children = true` get `retention_until` enforced by a scheduled cleanup job: COS object deleted first, row tombstoned (kind preserved, `cos_key` nulled) so evidence references stay resolvable without retaining the image.
- Restore drill is part of go-live checklist — a backup that has never been restored does not count.

## 6. Open questions

1. SMS login vs invite-code for pilot cohort — decide before building `POST /api/auth/login` (cost vs friction; ARCHITECTURE.md prices SMS at ~¥0.05/条). The admin-created-accounts path (§4 auth design) may make invite codes unnecessary.
2. Does stage-5 export need server-side rendering (docx/pdf) or is client-side enough? Affects whether an export worker joins the VM.
3. Violations table growth policy — keep forever (research value) or aggregate after N months?
4. Real-name obligations for the 小程序 user base (see §4 auth design) — verify against WeChat platform rules and the education-service category during 备案/登记; do not guess.
5. **Longitudinal teacher profile.** Post-pilot: demographics + preference signals + possibly vectorized memory of intentions/style across courses, feeding prompt context beyond today's static 教师档案. Needs its own schema and a PIPL profiling assessment before any embedding of teacher-derived text; explicitly out of v1.
6. **官方服务 vs BYOK (planned end-state for model access).** The provider zoo in the settings modal is a dev-phase tool. Production collapses to two modes: **官方服务** — the platform provides model access as SaaS: keys live server-side in the proxy env (already the production key-custody design, §2 "what we do NOT store"), the platform pays vendors, per-teacher consumption is metered from `messages.usage` for quota/billing; **自备密钥 BYOK** — a teacher/org pastes their own vendor key, which stays per-request/localStorage exactly as today. Decision needed later: quota model (per-seat allowance vs pay-per-use) and whether BYOK survives past the pilot.
