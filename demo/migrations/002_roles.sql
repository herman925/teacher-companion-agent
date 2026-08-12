-- 002_roles.sql — the four roles, ownership, and privileges
-- Source of truth: docs/DATABASE.md v0.2 §2c · ADR-0013 §5, §7, §10, §11.
--
-- THIS FILE IS PART ONE OF THE THREE-PART RLS SETUP. §2c: "all three are
-- required or the whole thing silently does nothing". Part one is here
-- (the application does not own the tables), part two is 003 (FORCE, not just
-- ENABLE), part three is the application's own `SET LOCAL app.user_id` inside
-- each transaction. Two out of three is RLS that appears to work.
--
-- Apply as a superuser (`postgres`), after 001, with the three passwords passed
-- in as psql variables:
--
--   psql -v ON_ERROR_STOP=1 -d teacher_platform \
--        -f /root/migration-vars.psql -f demo/migrations/002_roles.sql
--
-- where /root/migration-vars.psql (chmod 600, OUTSIDE this repository) holds:
--   \set app_pw 'generated-secret'
--   \set adm_pw 'generated-secret'
--   \set ldr_pw 'generated-secret'
--
-- No secret may appear in this repository, in shell history, or in `ps` output
-- (`-v app_pw=…` on the command line is visible in both — hence the file).
-- See README.md in this directory for generation and storage.

\set ON_ERROR_STOP on

-- Fail before touching anything if a password variable is missing. Without this
-- guard an unset `:'app_pw'` produces a role whose password is not what anyone
-- thinks it is, and the failure only shows up when the app cannot log in.
\if :{?app_pw}
\else
DO $$ BEGIN RAISE EXCEPTION 'psql variable app_pw is not set — see demo/migrations/README.md'; END $$;
\quit
\endif
\if :{?adm_pw}
\else
DO $$ BEGIN RAISE EXCEPTION 'psql variable adm_pw is not set — see demo/migrations/README.md'; END $$;
\quit
\endif
\if :{?ldr_pw}
\else
DO $$ BEGIN RAISE EXCEPTION 'psql variable ldr_pw is not set — see demo/migrations/README.md'; END $$;
\quit
\endif

BEGIN;

SET search_path = public;

-- ================================================================= 1. ROLES
--
-- WHY app_owner is a separate, NOLOGIN role — the part that silently fails:
-- PostgreSQL exempts a table's OWNER from that table's row-level security
-- policies. An application that connects as the owner therefore gets RLS that
-- reports itself as enabled in pg_tables and enforces nothing at all. It is the
-- most common way to ship RLS that does not work, and nothing about it looks
-- wrong until a teacher reads another teacher's course. 003 closes the same
-- hole a second way with FORCE; both are kept, because either one alone can be
-- undone by a single careless `ALTER TABLE`.
--
-- NOLOGIN matters as much as the separation: a role that cannot log in cannot
-- be the role a hurried deploy points DATABASE_URL at.
CREATE ROLE app_owner  NOLOGIN;                       -- owns the schema, runs migrations

-- `:'app_pw'` (quote-as-literal), NOT `:app_pw`. A bare `:app_pw` interpolates
-- the raw text into the statement: a password containing a quote breaks the
-- file, and a password containing SQL runs it. §2c's snippet writes the bare
-- form; this is the safe spelling of the same line.
CREATE ROLE app_rw     LOGIN PASSWORD :'app_pw';      -- the application
CREATE ROLE app_admin  LOGIN PASSWORD :'adm_pw';      -- admin console: bypasses, deliberately
CREATE ROLE app_leader LOGIN PASSWORD :'ldr_pw';      -- reads the aggregate view ONLY

-- None of them gets BYPASSRLS, SUPERUSER or CREATEROLE. app_admin's reach is an
-- explicit per-table policy in 003, so "admin can read everything" is a grant
-- somebody wrote down (and pg_policies can list) rather than a role attribute
-- nobody sees. It also means a table added later is fail-closed for the admin
-- console until a human decides otherwise — which is the correct default for a
-- table that might hold child evidence.

-- ============================================================ 2. OWNERSHIP
-- 001 ran as the superuser, so the tables are the superuser's. Move them, or
-- part one above is decorative. Indexes, constraints and identity sequences
-- follow their table automatically.
ALTER TABLE users               OWNER TO app_owner;
ALTER TABLE classes             OWNER TO app_owner;
ALTER TABLE courses             OWNER TO app_owner;
ALTER TABLE course_snapshots    OWNER TO app_owner;
ALTER TABLE messages            OWNER TO app_owner;
ALTER TABLE violations          OWNER TO app_owner;
ALTER TABLE materials           OWNER TO app_owner;
ALTER TABLE facts               OWNER TO app_owner;
ALTER TABLE interaction_signals OWNER TO app_owner;
ALTER TABLE scope_log           OWNER TO app_owner;

-- ==================================================== 3. DATABASE / SCHEMA
-- :"DBNAME" is psql's built-in current-database variable, quoted as an
-- identifier — so this file cannot be applied to `teacher_platform` while
-- granting on some other database name that was hard-coded here.
REVOKE ALL ON DATABASE :"DBNAME" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"DBNAME" TO app_rw, app_admin, app_leader;

GRANT USAGE  ON SCHEMA public TO app_rw, app_admin, app_leader;
GRANT CREATE ON SCHEMA public TO app_owner;            -- future migrations run as the owner

-- PostgreSQL grants no table privileges to PUBLIC by default; this is belt and
-- braces against an earlier hand-run GRANT on this box.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;

-- Deliberately NO `ALTER DEFAULT PRIVILEGES`. Auto-granting on future tables
-- would mean the next table is readable by the application the instant it is
-- created — before anyone has thought about whether it needs a policy, and a
-- new table has no RLS until 003's pattern is repeated for it. Every future
-- table must be granted by hand. The friction is the feature.

-- ============================================================ 4. app_rw
-- The application. Privileges are the FIRST gate; RLS in 003 is the second.
-- A table it cannot UPDATE cannot be rewritten even by a policy mistake.

-- Own profile: read, and write EXACTLY ONE COLUMN.
--
-- WHY THE COLUMN LIST IS LOAD-BEARING. Row-level security is row-level, not
-- column-level. `users_self` (003) lets app_rw write any column OF ITS OWN ROW,
-- so a bare `GRANT UPDATE ON users` makes
--   UPDATE users SET role = 'admin' WHERE id = <self>
-- succeed. That is self-promotion to admin, and it becomes live privilege
-- escalation the moment ADR-0013 §8's 「session + role, the console checks
-- role === 'admin'」 lands. It was also reach nothing used: pg-store touches
-- `users` only on the admin plane (getUser, listUsers, verifyLogin,
-- changePassword, updateUser all run on the admin connection), so app_rw spent
-- this grant on nothing at all.
--
-- What must stay absent, spelled out so a later widening is a visible diff
-- against a line that forbids it — same style as app_leader below:
--   GRANT UPDATE (role)            ON users TO app_rw;   -- never
--   GRANT UPDATE (status)          ON users TO app_rw;   -- never
--   GRANT UPDATE (password_hash)   ON users TO app_rw;   -- never
--   GRANT UPDATE (revoked_at)      ON users TO app_rw;   -- never: it is the
--                                                        -- retention clock
--
-- INSERT/DELETE on users is admin-only because accounts are admin-provisioned
-- — whitelist only, no self-registration (ADR-0013 §3).
GRANT SELECT                         ON users               TO app_rw;
GRANT UPDATE (settings)              ON users               TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON classes             TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON courses             TO app_rw;

-- APPEND-ONLY, ENFORCED BY THE ABSENCE OF A GRANT (DATABASE.md §1.2).
-- messages, course_snapshots and violations are the audit trail that every
-- child-evidence claim resolves against: `evidence_refs[]` point at
-- messages.id and materials.id rows (§2f), and the L3 fabrication check is only
-- as trustworthy as those rows are immutable. Withholding UPDATE and DELETE
-- makes "never updated or deleted by application code" a property of the
-- database instead of a habit of the code. If a future feature needs to edit a
-- message, that is a design conversation and an ADR, not a GRANT.
GRANT SELECT, INSERT                 ON course_snapshots    TO app_rw;
GRANT SELECT, INSERT                 ON messages            TO app_rw;
GRANT SELECT, INSERT                 ON violations          TO app_rw;

-- materials: NO DELETE FOR app_rw, and that is the resolution of a
-- contradiction this file used to carry.
--
-- The paragraph above says messages / course_snapshots / violations are
-- append-only because `evidence_refs[]` resolve against them and 「the L3
-- fabrication check is only as trustworthy as those rows are immutable」. The
-- next line then handed app_rw DELETE on materials — the OTHER thing a citation
-- can point at — with no foreign key anywhere to notice a citation left aiming
-- at nothing. Both statements cannot be true, and non-negotiable #1 depends on
-- which one is.
--
-- So: a material row may vanish ONLY as part of deleting the document that
-- cites it. Whole-course deletion and account erasure both run on the admin
-- connection (pg-store's deleteCourseRows / eraseUser), inside one transaction
-- that also removes `courses.course_state` — the document where
-- `children_evidence` and its ids live. The citation and its target die
-- together, so nothing is ever left dangling. A per-material delete would
-- strand a citation; it has no implementation, no endpoint and now no grant.
--
-- UPDATE stays, for the retention tombstone §5 describes: delete the COS object
-- first, THEN null `cos_key` and stamp `deleted_at`, so the row that proves the
-- citation existed survives its own photograph. NOT YET IMPLEMENTED — no store
-- method writes it — and recorded here as reach that is deliberately ahead of
-- the code rather than as a claim that it works.
--
-- The COS object must be deleted BEFORE the row either way: a deleted row is a
-- lost key, and a lost key is a child photo nobody can find to delete.
GRANT SELECT, INSERT, UPDATE         ON materials           TO app_rw;

-- facts: no DELETE. Contradicted facts are ARCHIVED with a pointer
-- (archived_at / superseded_by), never removed — the record of what was
-- believed when has to survive.
GRANT SELECT, INSERT, UPDATE         ON facts               TO app_rw;

GRANT SELECT, INSERT                 ON interaction_signals TO app_rw;
GRANT SELECT, INSERT                 ON scope_log           TO app_rw;

-- Identity columns (GENERATED ALWAYS AS IDENTITY) do not need a separate USAGE
-- grant on their sequence the way `serial` does — the sequence is internal to
-- the column, and INSERT on the table is the privilege that is checked. This
-- statement therefore changes nothing about how the five identity columns in
-- 001 behave; it is kept so that a future `serial` column does not fail its
-- first INSERT in production with a permission error nobody can reproduce
-- locally.
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_rw;

-- ========================================================== 5. app_admin
-- ADR-0013 §7: admins read everything and every read is recorded — the access
-- log is a FILE (§7), not a table, and it is the compensating control for the
-- reach granted here. This role must never be the one the teacher-facing
-- application connects as.
GRANT SELECT ON users, classes, courses, course_snapshots, messages,
                violations, materials, facts, interaction_signals, scope_log
  TO app_admin;

-- Account provisioning and the three account states (ADR-0013 §11).
GRANT INSERT, UPDATE, DELETE ON users TO app_admin;

-- Erasure (§5b), in one ordered transaction: COS objects first, then these
-- rows, then scope_log keeps its row with user_id nulled. That last step is why
-- app_admin has UPDATE on scope_log — operational history survives, the person
-- does not.
GRANT DELETE ON classes, courses, course_snapshots, messages, violations,
                materials, facts, interaction_signals
  TO app_admin;
GRANT UPDATE ON scope_log, materials, courses TO app_admin;

-- ONE WRITE FOR A ROLE WHOSE POINT IS READ-PLUS-ERASE, and it is not an
-- oversight.
--
-- The scope shell fires BEFORE a session exists — that is what a shell is for —
-- so the common verdict has no user to attribute it to. 003's `scope_log_owner`
-- refuses a NULL user_id from app_rw deliberately (「a loud failure is the
-- cheaper mistake」), which leaves unattributed verdicts with nowhere to go: the
-- INSERT fails with 42501 and warn-only mode records NOTHING for exactly the
-- traffic it exists to measure. An empty 范围护栏 tab would then read as 「no
-- off-purpose traffic」 rather than 「the writer is broken」, and SCOPE_ENFORCE=1
-- would be decided on that.
--
-- So the unattributed row is written on the admin connection instead
-- (pg-store.logScope says the same thing from the other side). Scoped as
-- narrowly as a grant can be: INSERT on ONE table, and no INSERT anywhere else.
-- If 003 ever gains a policy for unattributed rows, delete this line with it.
GRANT INSERT ON scope_log TO app_admin;

-- DELIBERATELY ABSENT: INSERT on courses, messages, course_snapshots and
-- materials. The one-time JSON importer (demo/scripts/import-json-to-pg.mjs)
-- writes all four, and it runs as `postgres`, NOT as app_admin — widening this
-- role to cover a script that runs once would leave the widening behind
-- forever. The script's own usage text says so.

GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_admin;

-- ========================================================= 6. app_leader
-- ADR-0013 §10: a 园长 or 教研员 reads counts, never a named teacher's plan.
-- Mechanically they get the view and nothing else, so a mistake in a leader
-- query cannot reach a course row. The GRANT on leader_dashboard is in 004,
-- because the view does not exist yet.
--
-- What is deliberately absent, and must stay absent:
--   GRANT ... ON courses, messages, materials, facts TO app_leader;
--
-- Belt and braces, because "we simply never granted it" is a promise and this
-- is a statement: an explicit REVOKE, so a later accidental GRANT is a visible
-- diff against a line that says it must not happen.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM app_leader;

COMMIT;

-- No SQL inside these messages: psql meta-command arguments use their own
-- quoting rules (backslash-escape, not SQL doubling), so an embedded quote
-- prints as garbage. The queries live in README.md instead.
\echo '002_roles.sql applied. Verify BEFORE continuing: README.md step 1 —'
\echo 'every table in schema public must now be owned by app_owner. If any is still'
\echo 'owned by postgres, ownership did not move and the RLS added by 003 will not'
\echo 'apply to the owner connection.'
