# DATABASE.md — Data shape and API surface

| | |
|---|---|
| **Status** | Design v0.1 — 2026-07-14. PostgreSQL is provisioned on the pilot VM (ADR-0002); the persistence layer described here is **not yet implemented** — today `demo/serve.mjs` is stateless and course state lives in browser localStorage. |
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
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

-- One row per theme-inquiry course a teacher runs
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

-- Immutable audit trail: one row per applied state delta (ARCHITECTURE.md §4)
CREATE TABLE course_snapshots (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  course_id     uuid NOT NULL REFERENCES courses(id),
  state_version integer NOT NULL,            -- version AFTER applying the delta
  course_state  jsonb NOT NULL,              -- full document at that version
  state_delta   jsonb NOT NULL,              -- the validated delta that produced it
  message_id    bigint,                      -- the turn that proposed it (FK added after messages)
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, state_version)
);

-- One row per chat message — never an unboundedly growing document
CREATE TABLE messages (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  course_id     uuid NOT NULL REFERENCES courses(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  role          text NOT NULL CHECK (role IN ('teacher','agent','system')),
  content       text NOT NULL,               -- teacher text or validated reply_markdown
  turn_contract jsonb,                       -- full parsed turn for agent rows (state_delta, closure_loop, evidence_refs, asks)
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

## 3. Transaction shape of one validated turn

Single transaction, after L2–L4 succeed:

1. `INSERT` teacher message → `messages`
2. `INSERT` agent message (validated turn contract) → `messages`
3. Engine applies `state_delta` → `UPDATE courses SET course_state, state_version = state_version + 1`
4. `INSERT` full new document + delta → `course_snapshots`
5. `INSERT` any violations recorded on the way → `violations`

Concurrency guard: the `UPDATE` carries `WHERE state_version = $expected` (optimistic lock). A stale write aborts the whole transaction — no half-applied turns.

## 4. API surface

### Today (implemented in `demo/serve.mjs`)

| Method + path | Purpose | Auth |
|---|---|---|
| `GET /*` | Static demo UI | none |
| `POST /api/chat` | One turn through the pipeline (adapter → harness L2–L4 → engine). State travels with the request; SSE same-origin, buffered JSON cross-origin. | none (test-only) |

### Needed once persistence lands (v1 target)

| Method + path | Purpose |
|---|---|
| `POST /api/auth/login` | SMS code or invite-code + password → session cookie |
| `POST /api/auth/logout` | End session |
| `GET /api/courses` | List the teacher's courses |
| `POST /api/courses` | Create a course (starts stage 0 intake) |
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

1. SMS login vs invite-code for pilot cohort — decide before building `POST /api/auth/login` (cost vs friction; ARCHITECTURE.md prices SMS at ~¥0.05/条).
2. Does stage-5 export need server-side rendering (docx/pdf) or is client-side enough? Affects whether an export worker joins the VM.
3. Violations table growth policy — keep forever (research value) or aggregate after N months?
