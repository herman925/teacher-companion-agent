-- 005_auth_plane.sql — accounts, sessions, the vault, and the migration ledger
-- Source of truth: docs/DATABASE.md v0.2 §2 + §4 · ADR-0005 · ADR-0013 §8, §11.
--
-- WHY THIS FILE EXISTS. 001 transcribed §2 and stopped there; its own header
-- says §4's account/session build spec 「belong[s] to a later numbered
-- migration」. Meanwhile demo/src/store/pg-store.mjs queries four tables and
-- eleven columns that no migration created — so the store could not run at all,
-- and the likely field fix was somebody hand-creating the tables on the VM.
-- THAT is the failure this file exists to prevent: a hand-created table is
-- owned by `postgres`, has no ENABLE, no FORCE, no policy and no grant, which
-- is precisely the silently-disabled row-level security 002 and 003 exist to
-- stop. `sessions` holds bearer tokens and `user_keys` holds vault ciphertext;
-- these are not incidental tables.
--
-- Apply as a superuser (`postgres`) after 004.
--
--   psql -v ON_ERROR_STOP=1 -d teacher_platform -f demo/migrations/005_auth_plane.sql
--
-- Same discipline as 001–003, in three parts, for every new table:
--   part 1 — app_owner OWNS it (002's rule: the application never owns a table);
--   part 2 — ENABLE **and** FORCE row level security, plus a policy;
--   part 3 — an explicit GRANT, because 002 deliberately set no
--            ALTER DEFAULT PRIVILEGES: a new table is unreachable until a human
--            decides who may reach it.
--
-- Not idempotent, on purpose. Re-running must fail loudly.

\set ON_ERROR_STOP on

BEGIN;

SET search_path = public;

-- ============================================================ 1. users
-- The account columns §4 specifies and the demo has always written.

ALTER TABLE users
  ADD COLUMN username                text UNIQUE,
  ADD COLUMN must_change_password    boolean NOT NULL DEFAULT false,
  ADD COLUMN display_name_changed_at timestamptz,
  -- ON DELETE SET NULL, not a plain FK: erasing the admin who provisioned an
  -- account must not be blocked by the account they provisioned (ADR-0013 §11
  -- — erasure is irreversible and must not be refusable by bookkeeping).
  ADD COLUMN created_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- setDisplayName reports 「昵称已被占用」 by catching 23505. Without this index
-- there is no 23505 to catch and the SELECT-then-UPDATE race silently produces
-- two teachers with the same 昵称 — which the 用户中心 uses as an identity.
CREATE UNIQUE INDEX idx_users_display_name ON users (display_name);

-- 'disabled' is DATABASE.md §4's spelling and the console's existing button;
-- §2 and ADR-0013 §11 own the other three. THE TWO DOCUMENTS CONTRADICT EACH
-- OTHER (001's header says so), the JSON tier implements the union, and this
-- store must record what it is given rather than map 'disabled' onto 'revoked'
-- — that mapping would start the retention clock and turn 「temporarily
-- disabled」 into 「erased in 12 months」.
--
-- The constraint name is PostgreSQL's default for a table-level CHECK on
-- `status`; if \d users shows a different one on this box, correct it here
-- before running rather than dropping a constraint by guess.
ALTER TABLE users DROP CONSTRAINT users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check
  CHECK (status IN ('active','revoked','erased','disabled'));

-- ============================================================ 2. courses
ALTER TABLE courses
  -- A human rename wins forever: auto-titling checks this and never overwrites
  -- a person's choice.
  ADD COLUMN title_locked boolean NOT NULL DEFAULT false,
  -- Mirror of the unsent 工作台 (per-node 批注 + living question-card answers).
  -- Scratch, not history — no version bump, no snapshot row — but AGENTS.md
  -- makes it exportable state, so it lives in the database and not in a widget.
  ADD COLUMN workbench    jsonb;

-- ============================================================ 3. messages
-- The JSON tier has persisted these four with every turn since before §2 was
-- written. Carrying them is an obligation, not a nicety: state the admin export
-- cannot see is a defect (AGENTS.md).
ALTER TABLE messages
  ADD COLUMN provider_label text,   -- 「GLM · glm-5.2」 as shown to the teacher
  ADD COLUMN stage_name     text,   -- the stage this turn ran in, as a name
  ADD COLUMN cache          jsonb,  -- normalized prompt-cache report
  ADD COLUMN guards         jsonb;  -- timeout-guard events of this turn

-- ============================================================ 4. sessions
-- Opaque bearer tokens. The token NEVER leaves the server: the device list in
-- 用户中心 renders `sid`, and a token in that list is a token in the DOM.
CREATE TABLE sessions (
  token        text PRIMARY KEY,
  sid          text NOT NULL UNIQUE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  user_agent   text
);
CREATE INDEX idx_sessions_user ON sessions (user_id);

-- ========================================================= 5. admin_audit
CREATE TABLE admin_audit (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- NO foreign key on either uuid, deliberately. `admin_id` must OUTLIVE the
  -- person: accountability for what an admin did has to survive that admin's
  -- own erasure (ADR-0013 §11), and an FK would either block the delete or null
  -- the evidence. `target_user` is nulled explicitly by eraseUser, which is the
  -- same rule read from the other side.
  admin_id    uuid,
  action      text NOT NULL,
  target_user uuid,
  detail      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ========================================================== 6. user_keys
-- Ciphertext only (ADR-0005). serve.mjs encrypts before it reaches here, and no
-- export path joins this table — the way to keep the vault out of an export is
-- never to join it.
CREATE TABLE user_keys (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider   text NOT NULL,
  ciphertext text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);

-- ========================================================== 7. app_state
-- Singleton blobs that belong to the INSTANCE, not to a teacher (today: the
-- rate gate's window state). No user_id, so no owner policy is possible — which
-- is why it is admin-plane only below.
CREATE TABLE app_state (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ==================================================== 8. OWNERSHIP (part 1)
-- 002's whole point: the application does not own the tables, because
-- PostgreSQL exempts an owner from that table's policies.
ALTER TABLE sessions    OWNER TO app_owner;
ALTER TABLE admin_audit OWNER TO app_owner;
ALTER TABLE user_keys   OWNER TO app_owner;
ALTER TABLE app_state   OWNER TO app_owner;

-- ======================================================= 9. GRANTS (part 3)
--
-- ALL FOUR ARE ADMIN-PLANE ONLY, and that is a decision this file records
-- rather than assumes. 003_rls.sql left a KNOWN GAP open — login resolves a
-- teacher by username BEFORE `app.user_id` can be set, because you cannot name
-- the user you are still identifying, so under `users_self` the lookup returns
-- zero rows and login fails closed. 003 listed two candidate resolutions and
-- said whichever is chosen 「gets written into DATABASE.md before it is coded」.
--
-- THE CHOICE IS (b): the authentication path uses its own connection as
-- app_admin. pg-store.mjs already took it; it is now written down in
-- DATABASE.md §2c and here, which is what 003 asked for.
--
-- Consequence, stated plainly: app_rw can read and write NONE of these four.
-- A teacher-facing code path that needs a session row is a code path that has
-- to go through the auth plane, and that friction is the feature — it keeps the
-- table holding bearer tokens off the connection that serves course pages.
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions    TO app_admin;
GRANT SELECT, INSERT, UPDATE         ON admin_audit TO app_admin;   -- never DELETE: an audit trail
GRANT SELECT, INSERT, UPDATE, DELETE ON user_keys   TO app_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON app_state   TO app_admin;

GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_admin;

-- app_leader gets nothing, and says so: 002's REVOKE covered the tables that
-- existed then, so a new table needs the line repeated or the promise decays.
REVOKE ALL ON sessions, admin_audit, user_keys, app_state FROM app_leader;

-- ============================================ 10. ROW LEVEL SECURITY (part 2)
--
-- ENABLE **and** FORCE on every one. ENABLE alone still exempts the owner, and
-- the owner is app_owner, which owns everything — so ENABLE without FORCE means
-- every policy below is skipped for any connection that happens to be the
-- owner, silently, forever. pg_tables.rowsecurity shows only ENABLE and will
-- read `t` while proving nothing; pg_class.relforcerowsecurity is the column
-- that tells the truth (README step 2).
--
-- Each table then gets an app_admin policy and NOTHING ELSE. A role with no
-- applicable policy on an RLS-enabled table reads zero rows, so a grant added
-- here by mistake later still reaches nothing until somebody also writes a
-- policy — two locks, as everywhere else in this directory.

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE  ROW LEVEL SECURITY;
CREATE POLICY sessions_admin ON sessions
  FOR ALL TO app_admin USING (true) WITH CHECK (true);

ALTER TABLE admin_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_audit FORCE  ROW LEVEL SECURITY;
CREATE POLICY admin_audit_admin ON admin_audit
  FOR ALL TO app_admin USING (true) WITH CHECK (true);

ALTER TABLE user_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_keys FORCE  ROW LEVEL SECURITY;
CREATE POLICY user_keys_admin ON user_keys
  FOR ALL TO app_admin USING (true) WITH CHECK (true);

ALTER TABLE app_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_state FORCE  ROW LEVEL SECURITY;
CREATE POLICY app_state_admin ON app_state
  FOR ALL TO app_admin USING (true) WITH CHECK (true);

-- ==================================================== 11. MIGRATION LEDGER
--
-- 001's header and README.md both say the same thing: 「The moment a fifth
-- migration exists, add a ledger table; do not keep applying files from
-- memory.」 This is the fifth migration.
--
-- Deliberately dumb: a filename, when it was applied, and who applied it.
-- No checksum, because a checksum invites 「fix the checksum」 when a comment is
-- corrected, and no ordering column, because the filename already sorts.
CREATE TABLE schema_migrations (
  filename    text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  applied_by  text NOT NULL DEFAULT current_user
);
ALTER TABLE schema_migrations OWNER TO app_owner;
-- Readable by the admin console so 「which migrations has this box had」 is a
-- question the console can answer. Writable by nobody but the superuser
-- applying a migration — no grant is the grant.
GRANT SELECT ON schema_migrations TO app_admin;
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migrations FORCE  ROW LEVEL SECURITY;
CREATE POLICY schema_migrations_admin ON schema_migrations
  FOR ALL TO app_admin USING (true) WITH CHECK (true);

-- Backfilled, honestly labelled: 001–004 were applied before this table
-- existed, so their timestamps are unknown and are recorded as this moment with
-- the reason attached rather than invented.
INSERT INTO schema_migrations (filename, applied_by) VALUES
  ('001_schema.sql',     'backfilled by 005 — actual time unknown'),
  ('002_roles.sql',      'backfilled by 005 — actual time unknown'),
  ('003_rls.sql',        'backfilled by 005 — actual time unknown'),
  ('004_views.sql',      'backfilled by 005 — actual time unknown'),
  ('005_auth_plane.sql', current_user);

COMMIT;

-- No SQL inside these messages: psql meta-command arguments use their own
-- quoting rules. The queries live in README.md.
\echo '005_auth_plane.sql applied. Verify BEFORE trusting it — README.md step 7:'
\echo 'all FIVE new tables must be owned by app_owner, and pg_class.relforcerowsecurity'
\echo 'must be true on every one of them. A table that reached this database any'
\echo 'other way (hand-created during an outage) has none of that and looks identical'
\echo 'in \dt.'
