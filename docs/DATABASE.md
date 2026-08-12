# DATABASE.md — Data shape and API surface

| | |
|---|---|
| **Status** | Design **v0.2 — 2026-07-29, rewritten for Workflow v2** (plan tree, four memory scopes, subject-tagged messages, uploads, row-level security). Superseded v0.1 dated 2026-07-14. PostgreSQL is provisioned on the pilot VM (ADR-0002); the persistence layer described here is **not yet implemented** — today `demo/serve.mjs` is stateless and course state lives in browser localStorage. A **demo persistence tier** (JSON store, §4) is designed as the runnable bridge for demonstrating real server-side chat history on localhost or the Tencent VM, ahead of the full Postgres build. |
| **Engine** | PostgreSQL 16, localhost-only on the pilot VM, database `teacher_platform` |
| **Upstream design** | [ARCHITECTURE.md](ARCHITECTURE.md) §4–§5 (state engine, DB modeling rules) |
| **Security posture** | [ADR-0013](adr/0013-security-and-data-custody-for-launch.md) — RLS from the first table, LighthouseCOS for files, three account states. **Read it before creating any table.** |
| **Reality check** | 2026-07-29: the database exists and holds **zero tables**. Data is still JSON files on disk. Nothing here is built. |
| **State schema** | [harness/schema/course-state.schema.json](../harness/schema/course-state.schema.json) — single source of truth for the course state document |

## 1. Modeling principles

1. **Hybrid relational + JSONB.** Row-shaped data (users, messages, violations) gets columns and indexes; the course state document stays one JSONB value validated against the JSON Schema above. The schema file is law — the DB never invents its own shape for course state.
2. **Append-only where auditability matters.** Messages, snapshots, and violations are never updated or deleted by application code. This is the fabrication-resistance promise made queryable: every child-evidence claim must trace to stored rows.
3. **The engine writes state; the LLM never touches the DB.** Only the deterministic engine (after L3 validation) applies a state delta and writes the new snapshot, inside one transaction.
4. **Owner scoping is enforced by the database, not by discipline.** Every query still filters by the authenticated teacher's `user_id`, but row-level security makes that a guarantee rather than a habit: a query that forgets its filter returns nothing instead of everything (§2c). Admin reads are a deliberate, separately-roled bypass with an access log, never an accident.
5. **No binary child data in the DB.** Photos and materials live in object storage (LighthouseCOS, private bucket, short-lived presigned URLs); the DB stores references and retention metadata only. On this hardware that is not a preference — the 70GB **system** disk holds Postgres, so files filling it would stop the database and take the service down (ADR-0013 §6).
6. **Memory accepts a closed set of fact kinds.** Facts are typed, not free text (§2e). A child observation has no kind to be filed under, so it cannot enter memory and bypass the evidence rules — the guard is structural rather than a keyword filter.
7. **Tree-shaped data stays in JSONB.** The blueprint (§2b) and the plan tree (§2f) both live inside `course_state`. Neither is ever queried across courses by node, both are read and written whole-or-by-delta, and both get version history free from the existing checkpoint machinery.

## 2. Tables

```sql
-- Teachers (the only human users in v1)
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         text UNIQUE,                 -- SMS login (v1); nullable for invite-code pilots
  display_name  text NOT NULL,
  password_hash text,                        -- argon2id; NULL when SMS-only
  invite_code   text,                        -- pilot onboarding path
  role          text NOT NULL DEFAULT 'teacher' CHECK (role IN ('teacher','admin','leader')),
  -- Three states, not a scale (ADR-0013 §11). `revoked` = the teacher left the
  -- school or was banned: login refused, DATA KEPT. `erased` = gone. Revocation
  -- is not deletion, and conflating them was the mistake this CHECK prevents.
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','erased')),
  revoked_at    timestamptz,                 -- starts the retention clock (§5)
  settings      jsonb NOT NULL DEFAULT '{}', -- UI prefs, 教师档案, interaction-axis vector — never secrets
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

-- Named classes (ADR-0011 §3). A class OUTLIVES a course: 「班上没有鼓」 must
-- still apply when the same children start a different theme in September.
-- This is an identity (中三班), not the age band already in 教师档案.
CREATE TABLE classes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,               -- 中三班
  age_band      text,                        -- 小班 | 中班 | 大班
  class_size    integer,
  is_default    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- At most one default per teacher, enforced by the database rather than by the
-- endpoint that happens to write it.
CREATE UNIQUE INDEX idx_classes_one_default ON classes (user_id) WHERE is_default;

-- One row per theme-inquiry course a teacher runs.
-- A course IS the conversation thread: companion coaching runs one long
-- chat per course, so there is no separate "conversation" entity —
-- course id doubles as the conversation id everywhere.
-- Quota: max 30 courses per user (abuse guard, enforced in the create
-- endpoint; teachers realistically run 2–5 per semester).
CREATE TABLE courses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  class_id      uuid REFERENCES classes(id), -- which class this course is for; NULL until asked
  title         text NOT NULL,               -- e.g. 「醒狮」
  course_state  jsonb NOT NULL,              -- current document; holds course_plan (§2f) and the blueprint (§2b)
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
  -- ONE log per course; the subject is a TAG, never a container (ADR-0010 §1).
  -- 'course' or a node id. Defaulting to 'course' is what makes this additive:
  -- every message written before subjects existed reads back as course-level,
  -- so there is no migration. Ordering stays global — we must be able to prove
  -- she asked about 3.2.1 BEFORE she edited 周2, which per-node logs cannot.
  subject       text NOT NULL DEFAULT 'course',
  content       text NOT NULL,               -- teacher text or validated reply_markdown
  turn_contract jsonb,                       -- parsed turn for agent rows: closure_loop, evidence_refs, asks. state_delta is NOT duplicated here — it lives in course_snapshots (single home)
  provider      text,                        -- minimax | glm | kimi | qwen | mock …
  usage         jsonb,                       -- prompt/completion token counts for cost tracking
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_messages_course ON messages (course_id, id);
-- Rendering one node's conversation is an index scan, not a filter over the course.
CREATE INDEX idx_messages_subject ON messages (course_id, subject, id);

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
  -- RANDOM key, never the uploaded filename: courses/<uuid>/<uuid>.<ext>.
  -- Filenames leak information and collide.
  cos_key       text NOT NULL,               -- object key in the PRIVATE LighthouseCOS bucket
  mime_type     text NOT NULL CHECK (mime_type IN ('application/pdf','image/jpeg','image/png',
                  'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
  size_bytes    bigint NOT NULL,
  -- A phone JPEG carries GPS coordinates. A picture of children plus the exact
  -- location of the kindergarten in one file is not something to store and hope
  -- about, so metadata is stripped at ingest and the fact is recorded.
  exif_stripped boolean NOT NULL DEFAULT false,
  contains_children boolean NOT NULL DEFAULT false,  -- drives retention + access rules
  retention_until   date,                    -- minimal-retention policy, set on upload
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_materials_course ON materials (course_id, created_at DESC);

-- Teacher memory (ADR-0011). ONE table with a scope column, not four tables:
-- scope is data, not structure. NODE memory is absent on purpose — it is
-- GENERATED (rationale + revision log inside the tree), never extracted.
CREATE TABLE facts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope         text NOT NULL CHECK (scope IN ('course','class','teacher')),
  course_id     uuid REFERENCES courses(id) ON DELETE CASCADE,
  class_id      uuid REFERENCES classes(id) ON DELETE CASCADE,
  -- The closed taxonomy (ADR-0013 §9). 「班上没有鼓」 is equipment; 「孩子们对
  -- 鼓声特别有反应」 fits no kind and is refused — which is how a child
  -- observation is stopped from entering memory and bypassing the evidence
  -- rules, without guessing at the text.
  kind          text NOT NULL CHECK (kind IN ('equipment','space','schedule',
                  'class_composition','teacher_preference')),
  body          text NOT NULL,
  quote         text,                        -- the teacher's own words that produced it
  source        text NOT NULL CHECK (source IN ('extracted','teacher','widened')),
  widened_from  text,                        -- the scope it was promoted from
  used_at       timestamptz,                 -- stamped when injected; drives oldest-UNUSED capping
  -- Contradicted facts are ARCHIVED with a pointer, never deleted: the record
  -- of what was believed when has to survive.
  archived_at   timestamptz,
  archive_reason text,
  superseded_by uuid REFERENCES facts(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'course' AND course_id IS NOT NULL)
      OR (scope = 'class'  AND class_id  IS NOT NULL)
      OR (scope = 'teacher'))
);
-- Class and course facts ride EVERY prompt, so this is a hot read path.
CREATE INDEX idx_facts_live ON facts (user_id, scope, class_id, course_id) WHERE archived_at IS NULL;

-- Observations that move the interaction axes (ADR-0009 §3). Row-shaped and
-- append-only; the vector itself is a singleton and lives in users.settings.
CREATE TABLE interaction_signals (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  axis          text NOT NULL,
  signal        text NOT NULL,               -- what was observed
  delta         numeric NOT NULL,            -- at most one step (ADR-0009 §2)
  course_id     uuid REFERENCES courses(id) ON DELETE SET NULL,
  message_id    bigint REFERENCES messages(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Scope-shell verdicts (ADR-0012 §3). Warn-only is only worth running if these
-- rows get read before enforcement is switched on. EXCERPT ONLY — 60 chars is
-- enough to judge a false block and not enough to turn an ops log into a store
-- of teacher conversation.
CREATE TABLE scope_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  rule          text NOT NULL,               -- weather | markets | code | …
  enforced      boolean NOT NULL,
  refused       boolean NOT NULL,
  excerpt       text NOT NULL CHECK (length(excerpt) <= 60),
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

The **admin access log deliberately stays out of Postgres**: daily-rotated files at `.data/auth/access-log/YYYY-MM-DD.jsonl`, 90-day retention (ADR-0013 §7). Daily files are easy to archive and prune, and an audit trail living outside the database it audits is harder to quietly edit.

### 2c. Row-level security (ADR-0013 §5)

Enabled at table creation, while there are zero tables — this is the cheapest it will ever be. Three parts, and **all three are required or the whole thing silently does nothing**:

```sql
-- 1. The application must NOT own the tables. Postgres exempts table owners
--    from policies, so an app connecting as the owner gets RLS that appears
--    enabled and enforces nothing. This is the most common way to ship RLS
--    that does not work.
CREATE ROLE app_owner  NOLOGIN;                    -- owns the schema, runs migrations
CREATE ROLE app_rw     LOGIN PASSWORD :app_pw;     -- the application
CREATE ROLE app_admin  LOGIN PASSWORD :adm_pw;     -- admin console: bypasses, deliberately
CREATE ROLE app_leader LOGIN PASSWORD :ldr_pw;     -- reads the aggregate view ONLY

-- 2. FORCE, not just ENABLE — ENABLE alone still exempts the owner.
ALTER TABLE courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE courses FORCE  ROW LEVEL SECURITY;

CREATE POLICY courses_owner ON courses
  USING (user_id = current_setting('app.user_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON courses TO app_rw;
```

The same pattern applies to `classes`, `messages`, `course_snapshots`, `materials`, `facts` and `interaction_signals` — every table carrying or reachable from a `user_id`.

```sql
-- 3. Each request names its user INSIDE the transaction.
BEGIN;
  SET LOCAL app.user_id = '5b7c…';   -- LOCAL: dies with the transaction, safe on a pooled connection
  SELECT * FROM courses;             -- her rows only, filter or no filter
COMMIT;
```

`current_setting('app.user_id', true)` returns NULL when unset rather than raising, and `user_id = NULL` matches nothing — so a code path that forgets to set the user **sees no rows** instead of every row. Fail-closed by construction.

**Proof obligation.** This section is a wish until a test connects as teacher A, asks for teacher B's course by id, and gets nothing. Write that test with the first table, not after the last one. It exists: `demo/tests/store-contract-pg.test.mjs`, in three blocks — A asks for B's course by id with no user predicate at all (expect 0), A asks for her own (expect 1, otherwise the test also passes against a database that returns nothing to anybody), and a transaction with no `SET LOCAL` (expect 0, not everything). It goes **around** the store on a raw connection, because every query in `pg-store.mjs` also carries `WHERE user_id = $1` and would return the right answer from the wrong reason.

**The application refuses to start if any of this is missing.** `createPgStore` asserts once, on its first connection: the connected role is not a superuser, does not hold `BYPASSRLS`, does not own (and is not a member of the role that owns) any table, is not `app_admin`, and every table in `public` carries both `relrowsecurity` and `relforcerowsecurity`. A mis-pointed `DATABASE_URL` is a boot failure rather than silent full access — which is the only way this fails loudly, since a disabled policy changes no query result.

#### The auth plane runs as `app_admin` — option (b), recorded here as `003_rls.sql` required

Login cannot run under `users_self`. Resolving a teacher by username happens **before** `app.user_id` can be set — you cannot name the user you are still identifying — so as `app_rw` that lookup returns zero rows and login fails closed. `003_rls.sql` listed two candidate resolutions and said whichever was chosen had to be written into this document before it was coded. It is chosen and it is **(b)**: `users`, `sessions`, `admin_audit`, `user_keys` and `app_state` are reached only through the separate `app_admin` connection (`DATABASE_URL_ADMIN`), and `005_auth_plane.sql` grants those tables to `app_admin` and to nobody else.

The rejected alternative, (a), was a `SECURITY DEFINER` function owned by `app_owner` returning only the columns password verification needs. It is a smaller bypass, and it remains the better shape if the auth plane ever grows beyond one server process; it was not taken now because it puts a second, invisible privilege boundary inside the database, where `pg_policies` cannot list it.

What was **not** chosen, and must never be: a policy like `USING (current_setting('app.user_id', true) IS NULL)`, which would make the whole `users` table readable to any code path that forgot to set the user — the exact inversion of the guarantee above.

`app_rw` holds `SELECT` on `users` and `UPDATE` on **one column**, `settings`. Row-level security is row-level, not column-level: `users_self` lets `app_rw` write any column of its own row, so a table-wide `UPDATE` grant made `UPDATE users SET role = 'admin' WHERE id = <self>` succeed — self-promotion, and live privilege escalation the moment ADR-0013 §8's `role === 'admin'` check lands.

### 2d. The leader view (ADR-0013 §10)

A 园长 or 教研员 answers 「区里面的难点在哪里」 from aggregates, never from a named teacher's plan. Mechanically they are granted **the view and nothing else** — no base table — so a mistake in a leader query cannot reach a course row.

```sql
CREATE VIEW leader_dashboard WITH (security_invoker = false, security_barrier = true) AS
  SELECT c.course_state->>'stage'                    AS stage,
         c.course_state->'theme_resource'->>'name'   AS theme,
         f.kind                                      AS constraint_kind,
         count(*)                                    AS n
    FROM courses c
    LEFT JOIN facts f ON f.course_id = c.id AND f.archived_at IS NULL
   GROUP BY 1, 2, 3
  HAVING count(*) >= 5 AND count(DISTINCT c.id) >= 5;  -- small cells re-identify

GRANT SELECT ON leader_dashboard TO app_leader;
-- and deliberately NOT: GRANT ... ON courses, messages, materials TO app_leader;
```

The suppression matters: in a district with three kindergartens, 「1 个课程卡在第二周」 identifies a person. Two corrections to the original form, both already in `004_views.sql`:

- **`count(DISTINCT c.id) >= 5` as well as `count(*) >= 5`.** `count(*)` counts JOINED rows, so one course carrying five equipment facts produces a group of five and passes the threshold on its own — publishing exactly the single-course row the threshold exists to suppress. Counting courses is what 「5」 always meant. Strictly more suppressive: it can only remove rows.
- **`security_barrier = true`.** Without it PostgreSQL may push a leader-supplied qualifier that mentions only grouping columns below the aggregate into the base scan, where it is evaluated against rows the `HAVING` would have removed. A non-leakproof built-in in that qualifier turns into an error or a timing difference that reveals the shape of suppressed groups. Bounded — `REVOKE ALL ON DATABASE … FROM PUBLIC` removes TEMP, so a leader cannot define a leaky function of their own — but bounded is not closed.

### 2e. Where each kind of memory lives

| Scope | Storage | Written by |
|---|---|---|
| Node | inside `course_state` — `rationale` + `revision_log` on the node | generated on every change |
| Course | `facts` where `scope='course'` | auto-extracted |
| Class | `facts` where `scope='class'` | widened by the teacher, or extracted with an explicit class |
| Teacher | `users.settings` (axis vector) + `interaction_signals` (the observations behind it) | inferred + explicit |

### 2f. The plan tree (ADR-0006/0010)

`course_plan` lives **inside `course_state`**, for exactly the reasons §2b gives for the blueprint: never queried across courses by node, always read and written whole-or-by-delta, schema-checked by `course-state.schema.json`, and versioned free by the checkpoint machinery — `plan_delta`s ride `state_delta` in `course_snapshots`.

Shape: 月计划 (a **phase** of 2–5 weeks, not a calendar month) → 周计划 → 活动, where an activity carries its own `dates[]`. **A day is a field, not a level**, so 「今天要做什么」 is a filter and rescheduling is one field rather than a re-parent. Each node carries two independent status axes — provenance (`confirmed`…`hypothesis`) and `work_status` (`draft`…`settled`) — plus `blueprint_refs` into the blueprint, and `stale_since` / `stale_reason` when an upstream edit may have invalidated it. Staleness never changes provenance.

Evidence referencing: a turn's `evidence_refs[]` point at `messages.id` and `materials.id` rows. The L3 fabrication heuristic (child-claims require evidence) resolves against these tables — that is why they are append-only.

### Sizing and lookup (why this is enough)

A message row is ~1–5 KB (teacher text or reply plus `turn_contract` JSONB; Postgres TOAST-compresses large JSONB automatically). Messages, worst case per teacher: 30 courses × ~200 turns × 5 KB ≈ 30 MB; a 50-teacher pilot tops out around 1.5 GB against 60+ GB of disk.

Snapshots are the bigger line item, and the reason for the checkpoint scheme above. The `course_state` document grows all course long (evidence ledger + `cycle_history`), reaching tens of KB late in a course. Writing the full document every turn would cost ~doc_size × turns ≈ 10 MB/course ≈ 300 MB/teacher — roughly 10× the messages. Writing the full document only every 20th version plus on stage change (deltas between) cuts that to ~1/20 while keeping full audit and replay: reconstruct any version from the nearest checkpoint plus a bounded delta replay.

Chat history is not a storage problem — photos are, which is why they live in COS, not here. Retrieval for display is the `(course_id, id)` index: a page of history is one index-range scan regardless of table size. The LLM prompt uses a much smaller window — the last 10 messages plus the current `course_state` document (the document already holds every fact; recent turns only supply conversational flow) — so per-turn token cost stays flat as history grows. Full-text search over history is deliberately out of v1; add `pg_trgm`/FTS only when a teacher actually asks to search old chats.

### What we deliberately do NOT store

- **Teachers' own model API keys.** Production model: platform-seeded keys in server env, platform pays for tokens, per-teacher spend tracked via `messages.usage`. A teacher-supplied key is stored in the **per-account encrypted vault** (AES-256-GCM under `KEYS_SECRET`; write-only, flags-only reads) — the "never server-side" position was reversed by [ADR-0005](adr/0005-per-account-key-vault-and-rate-limits.md) after the shared-browser cross-account leak proved worse than the encryption-at-rest liability. Only the no-backend static tier still keeps keys in localStorage.
- **Secrets of any kind in `users.settings`** — prefs only; the API layer must reject writes containing key-shaped values (same redaction lexicon as the session-log panel). Enforced at `PATCH /api/me`: the profile object is screened with `containsCredential` (`demo/src/redact.mjs`, the one lexicon the server and the session log share) and **refused with 400**, not masked — she needs to know her key did not save. The serialized profile is also capped at a few KB, because a field with no retention story of its own must not become storage.

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

## 5. Backups, retention and erasure

- Nightly `pg_dump` to the private LighthouseCOS bucket (cron on the VM); 30-day rolling window.
- `materials` rows with `contains_children = true` get `retention_until` enforced by a scheduled cleanup job: the COS object is deleted **first**, then the row is tombstoned (kind preserved, `cos_key` nulled) so evidence references stay resolvable without retaining the image. Deleting the row first would orphan the object.
- Restore drill is part of the go-live checklist — a backup that has never been restored does not count.

### 5b. The three account states (ADR-0013 §11)

`revoked` and `erased` are different operations for different situations, not two points on a scale. Conflating them is why the distinction is a `CHECK` constraint rather than a convention.

**Revoke** — the teacher left the school, or was banned. Login is refused and sessions stop resolving; **the data stays**, because the kindergarten may still need last year's curriculum. Sets `status='revoked'` and stamps `revoked_at`, which starts the retention clock.

**Erase** — everything goes. Used for alpha cleanup and for any deletion request. In one transaction, ordered so nothing can be orphaned:

1. delete the COS objects for the user's `materials` (**objects before rows** — a deleted row is a lost key, and a lost key is a child photo nobody can find to delete);
2. delete `facts`, `interaction_signals`, `materials`, `messages`, `course_snapshots`, `courses`, `classes`, vault key entries;
3. keep `scope_log` rows with `user_id` nulled, and access-log lines with the subject dropped — operational history survives, the person does not.

Two tests, because "it deleted" is not observable without them: **no orphaned object remains in the bucket**, and **no row references the missing user**.

**Revoked data auto-erases after a configurable window, default 12 months.** A scheduled job erases accounts where `revoked_at < now() - retention_window`. The window is configuration, not a constant, so the pilot's compliance answer can set it — 12 months is a defensible placeholder, not a legal opinion. Without the job, `revoked` quietly becomes "keep child observations forever", which is the outcome minimal retention exists to prevent.

## 6. Open questions

1. SMS login vs invite-code for pilot cohort — decide before building `POST /api/auth/login` (cost vs friction; ARCHITECTURE.md prices SMS at ~¥0.05/条). The admin-created-accounts path (§4 auth design) may make invite codes unnecessary.
2. Does stage-5 export need server-side rendering (docx/pdf) or is client-side enough? Affects whether an export worker joins the VM.
3. Violations table growth policy — keep forever (research value) or aggregate after N months?
4. Real-name obligations for the 小程序 user base (see §4 auth design) — verify against WeChat platform rules and the education-service category during 备案/登记; do not guess.
4b. **The retention window's real value.** 12 months (§5b) was chosen to be defensible, not because anyone checked. Someone who knows mainland requirements for child-related records should set it before launch.
4c. **Does the leader view need a per-kindergarten dimension?** §2d aggregates across everything a 教研员 can see. A 园长 plausibly wants their own kindergarten only, which means a kindergarten entity that does not exist yet. Decide when a 园长 actually asks, not before.
4d. **Migration ordering.** The 24 JSON course files on the public instance predate subjects, the plan tree and typed facts. The importer must decide what an imported message's `subject` is (`course`, safely) and that pre-v2 courses simply have no `course_plan` — not an empty one, which would render as a plan that exists and is blank.
5. **Longitudinal teacher profile.** Post-pilot: demographics + preference signals + possibly vectorized memory of intentions/style across courses, feeding prompt context beyond today's static 教师档案. Needs its own schema and a PIPL profiling assessment before any embedding of teacher-derived text; explicitly out of v1.
6. **官方服务 vs BYOK (planned end-state for model access).** The provider zoo in the settings modal is a dev-phase tool. Production collapses to two modes: **官方服务** — the platform provides model access as SaaS: keys live server-side in the proxy env (already the production key-custody design, §2 "what we do NOT store"), the platform pays vendors, per-teacher consumption is metered from `messages.usage` for quota/billing; **自备密钥 BYOK** — a teacher/org pastes their own vendor key, which stays per-request/localStorage exactly as today. Decision needed later: quota model (per-seat allowance vs pay-per-use) and whether BYOK survives past the pilot.
