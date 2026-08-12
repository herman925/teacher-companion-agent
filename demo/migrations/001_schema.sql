-- 001_schema.sql — tables, indexes and constraints
-- 小小探索家 / Little Explorers — PostgreSQL 16, database `teacher_platform`.
--
-- Source of truth: docs/DATABASE.md v0.2 §2. This file is a transcription of
-- that section, not a redesign. Where a comment here says more than §2 does, it
-- explains a Postgres mechanic that §2 assumes; it never adds a column.
--
-- Deliberately NOT here (they belong to a later numbered migration, and are
-- flagged rather than guessed at):
--   * DATABASE.md §4's account/session build spec (`sessions`, `admin_audit`,
--     `users.wechat_openid`, …). §4's `ALTER TABLE users` also CONTRADICTS §2 —
--     it re-declares `role` without 'leader' and `status` as active|disabled
--     instead of active|revoked|erased. §2 plus ADR-0013 §11 is authoritative
--     here, so §4's version is not applied. Reconciling the two documents is a
--     doc change someone must make; silently picking one in DDL would hide it.
--   * A migration ledger table. These four files bootstrap a database that has
--     zero tables (ADR-0013, verified 2026-07-29). The moment a fifth migration
--     exists, add a ledger — do not keep applying files by memory.
--
-- This file is a psql script: it uses meta-commands (\set, \if) and psql
-- variables. Run it with `psql -f`, not through a generic SQL client.
-- It is intentionally NOT idempotent (no IF NOT EXISTS): re-running it must
-- fail loudly rather than half-apply against a database that already has data.
--
-- Apply as a superuser (`postgres`). Ownership moves to app_owner in 002.

\set ON_ERROR_STOP on

BEGIN;

SET search_path = public;

-- gen_random_uuid() is built into PostgreSQL 13+ (it moved out of pgcrypto).
-- On 16 no extension is required. If this ever runs on <13, add pgcrypto here.

-- ---------------------------------------------------------------- users
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

-- ---------------------------------------------------------------- classes
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

-- ---------------------------------------------------------------- courses
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
-- WHY no ON DELETE on courses.user_id (and on the FKs below that point at
-- courses): erasure is an ORDERED operation (DATABASE.md §5b) — COS objects
-- first, then child rows, then parents. A cascade would let `DELETE FROM users`
-- succeed while quietly skipping the object-storage half, which is how an
-- orphaned child photo survives a deletion request. Only `classes`, `facts` and
-- `interaction_signals` cascade, exactly as §2 writes them: none of them
-- reference an object in the bucket.
--
-- NOTE (§2 states the column, not the mechanism): nothing sets `updated_at`
-- automatically — §2 documents no trigger, and inventing one here would be a
-- schema decision this file has no mandate to make. The turn transaction (§3)
-- must write it in the same UPDATE that bumps state_version, or
-- idx_courses_owner sorts every course by its creation time forever.
CREATE INDEX idx_courses_owner ON courses (user_id, updated_at DESC);

-- ---------------------------------------------------------------- course_snapshots
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

-- ---------------------------------------------------------------- messages
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

-- §2 defers this FK explicitly ("FK added after messages") because
-- course_snapshots is declared first. Adding the column without the constraint
-- would leave evidence pointers unenforced, and the whole point of §1.2
-- (append-only where auditability matters) is that an evidence_ref resolves.
ALTER TABLE course_snapshots
  ADD CONSTRAINT course_snapshots_message_id_fkey
  FOREIGN KEY (message_id) REFERENCES messages (id);

-- ---------------------------------------------------------------- violations
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
-- §2 documents no index on violations. None is invented here: it is written far
-- more often than it is read, and the read is an occasional whole-table
-- telemetry scan.

-- ---------------------------------------------------------------- materials
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

-- ---------------------------------------------------------------- facts
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
  -- rules, without guessing at the text. THIS CHECK IS A SAFETY CONTROL, not a
  -- tidiness rule: widening it re-opens the bypass that non-negotiable #1 closes.
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

-- ---------------------------------------------------------------- interaction_signals
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

-- ---------------------------------------------------------------- scope_log
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

-- The admin access log deliberately stays OUT of Postgres: daily-rotated files
-- at .data/auth/access-log/YYYY-MM-DD.jsonl, 90-day retention (ADR-0013 §7).
-- An audit trail living outside the database it audits is harder to quietly
-- edit. Do not add a table for it here.

COMMIT;

\echo '001_schema.sql applied. Tables exist and are owned by the role that ran this file.'
\echo 'They are NOT yet protected: no roles, no RLS. Apply 002, 003 and 004 before'
\echo 'any application connects to this database.'
