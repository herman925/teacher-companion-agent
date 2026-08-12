-- 003_rls.sql — row-level security: ENABLE, FORCE, and the policies
-- Source of truth: docs/DATABASE.md v0.2 §2c · ADR-0013 §5.
--
-- Apply as a superuser (`postgres`) after 002. Policies may also be created by
-- the table owner; the superuser is used here only because 001 and 002 were.
--
-- ============================================================================
-- READ THIS BEFORE SIMPLIFYING ANYTHING IN THIS FILE
-- ============================================================================
-- Row-level security has three parts (§2c). All three are required, and the
-- failure mode of getting any one of them wrong is not an error message — it is
-- a database that reports RLS as enabled and hands teacher B's course to
-- teacher A. That is why each part below carries a comment saying what breaks
-- without it.
--
--   Part 1 (002): the application does not OWN the tables.
--   Part 2 (this file): every table is ENABLE **and** FORCE.
--   Part 3 (the application): `SET LOCAL app.user_id` inside each transaction.
--
-- ---------------------------------------------------------------------------
-- THE PREDICATE, written once here and repeated verbatim in every policy:
--
--     nullif(current_setting('app.user_id', true), '')::uuid
--
-- `current_setting(name, true)` — the second argument is `missing_ok`. With it,
-- an unset setting returns NULL instead of raising. `user_id = NULL` matches no
-- row, so a code path that FORGETS to name its user sees nothing rather than
-- everything. Fail-closed by construction; drop the `true` and the same code
-- path throws instead, which some caller will "fix" with a try/catch.
--
-- `nullif(…, '')` handles the other spelling of the same mistake: a request
-- that sets `app.user_id` to an empty string (an unauthenticated session, a
-- template that interpolated nothing). Without nullif that is a cast error mid
-- transaction; with it, it is zero rows — the same fail-closed answer as unset.
--
-- The predicate is INLINED rather than wrapped in a helper function so that
-- `SELECT DISTINCT qual FROM pg_policies` shows one recognisable expression and
-- any drift between tables shows up as a second variant. Keep it identical.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on

BEGIN;

SET search_path = public;

-- ============================================================================
-- Every table below gets BOTH statements. ENABLE alone still exempts the table
-- owner, and the owner is app_owner, which owns everything — so ENABLE without
-- FORCE means every policy in this file is skipped for any connection that
-- happens to be the owner, silently, forever. pg_tables.rowsecurity shows only
-- ENABLE; it will read `t` and look correct. FORCE is visible only in
-- pg_class.relforcerowsecurity, which is why the README verifies that column
-- and not the convenient one.
--
-- Superusers and any role holding BYPASSRLS ignore both. That is why no role in
-- 002 has BYPASSRLS, and why the README's proof runs as app_rw and never as
-- postgres — a check run as the superuser proves nothing and looks alarming.
-- ============================================================================

-- ---------------------------------------------------------------- users
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE  ROW LEVEL SECURITY;

CREATE POLICY users_self ON users
  FOR ALL TO app_rw
  USING      (id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.user_id', true), '')::uuid);

CREATE POLICY users_admin ON users
  FOR ALL TO app_admin
  USING (true) WITH CHECK (true);

-- KNOWN GAP, recorded rather than papered over (DATABASE.md §4 auth build spec
-- is not yet written and this decision belongs to it):
-- login cannot run under users_self. Resolving a teacher by phone or display
-- name happens BEFORE app.user_id can be set — you cannot name the user you are
-- still identifying — so as app_rw that lookup returns zero rows and login
-- fails closed. Two candidate resolutions, neither chosen here:
--   (a) a SECURITY DEFINER function owned by app_owner that takes an identifier
--       and returns only the columns password verification needs; or
--   (b) the authentication path uses its own connection as app_admin.
-- Do NOT resolve it by adding a policy like
--   USING (current_setting('app.user_id', true) IS NULL)
-- which would make the entire users table readable to any code path that
-- forgot to set the user — the exact inversion of the guarantee above.
-- Whichever is chosen gets written into DATABASE.md before it is coded.
--
-- Foreign keys are unaffected by any of this: referential-integrity checks
-- bypass row security, so INSERTing a course still validates against users(id)
-- even though the inserting session cannot SELECT other users' rows.

-- ---------------------------------------------------------------- classes
ALTER TABLE classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE classes FORCE  ROW LEVEL SECURITY;

CREATE POLICY classes_owner ON classes
  FOR ALL TO app_rw
  USING      (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

CREATE POLICY classes_admin ON classes
  FOR ALL TO app_admin
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------- courses
ALTER TABLE courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE courses FORCE  ROW LEVEL SECURITY;

CREATE POLICY courses_owner ON courses
  FOR ALL TO app_rw
  USING      (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

CREATE POLICY courses_admin ON courses
  FOR ALL TO app_admin
  USING (true) WITH CHECK (true);

-- The leader view (004) is an ordinary view, so it reads its base tables with
-- the privileges AND the policies of its owner, app_owner — and app_owner is
-- subject to its own policies because of FORCE above. Without this SELECT-only
-- policy the 园长 dashboard is not an error: it is a table of zero rows, every
-- time, and it looks like nobody is using the product.
--
-- app_owner is NOLOGIN (002), so the only thing that can reach these rows
-- through this policy is a view app_owner owns. It grants read, never write,
-- and only to a role that cannot connect.
CREATE POLICY courses_aggregate ON courses
  FOR SELECT TO app_owner
  USING (true);

-- ---------------------------------------------------------- course_snapshots
ALTER TABLE course_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_snapshots FORCE  ROW LEVEL SECURITY;

-- course_snapshots carries no user_id — only course_id — so ownership is
-- reached through courses. The subquery is itself subject to courses_owner for
-- app_rw, which double-filters harmlessly; there is no policy recursion because
-- courses' policies never mention course_snapshots.
CREATE POLICY course_snapshots_owner ON course_snapshots
  FOR ALL TO app_rw
  USING (EXISTS (SELECT 1 FROM courses c
                  WHERE c.id = course_snapshots.course_id
                    AND c.user_id = nullif(current_setting('app.user_id', true), '')::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM courses c
                  WHERE c.id = course_snapshots.course_id
                    AND c.user_id = nullif(current_setting('app.user_id', true), '')::uuid));

CREATE POLICY course_snapshots_admin ON course_snapshots
  FOR ALL TO app_admin
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------- messages
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE  ROW LEVEL SECURITY;

-- Agent and system rows carry the owning teacher's user_id too (§2 makes the
-- column NOT NULL for every role), so user_id alone is a complete read filter.
-- The WITH CHECK additionally requires the course to be hers: foreign keys
-- bypass RLS, so without it a buggy path could file a message under her own id
-- into someone else's course thread.
CREATE POLICY messages_owner ON messages
  FOR ALL TO app_rw
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid
              AND EXISTS (SELECT 1 FROM courses c
                           WHERE c.id = messages.course_id
                             AND c.user_id = nullif(current_setting('app.user_id', true), '')::uuid));

CREATE POLICY messages_admin ON messages
  FOR ALL TO app_admin
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------- violations
ALTER TABLE violations ENABLE ROW LEVEL SECURITY;
ALTER TABLE violations FORCE  ROW LEVEL SECURITY;

-- violations.course_id is NULLABLE — a harness verdict can fire outside any
-- course. Such a row belongs to nobody, so it is invisible to app_rw's SELECT
-- (EXISTS over NULL is false) and readable only through violations_admin.
-- The WITH CHECK must still permit inserting it, or telemetry writes start
-- failing the moment a violation happens without a course.
CREATE POLICY violations_owner ON violations
  FOR ALL TO app_rw
  USING (EXISTS (SELECT 1 FROM courses c
                  WHERE c.id = violations.course_id
                    AND c.user_id = nullif(current_setting('app.user_id', true), '')::uuid))
  WITH CHECK (course_id IS NULL
              OR EXISTS (SELECT 1 FROM courses c
                          WHERE c.id = violations.course_id
                            AND c.user_id = nullif(current_setting('app.user_id', true), '')::uuid));

CREATE POLICY violations_admin ON violations
  FOR ALL TO app_admin
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------- materials
ALTER TABLE materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE materials FORCE  ROW LEVEL SECURITY;

-- These rows point at photographs of children in a private bucket. The USING
-- clause is what makes the "check ownership, then mint a short-lived presigned
-- URL" flow (ADR-0013 §6) safe even if the ownership check in the endpoint is
-- ever refactored away: an unowned material row cannot be selected at all, so
-- there is no cos_key to sign.
CREATE POLICY materials_owner ON materials
  FOR ALL TO app_rw
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid
              AND EXISTS (SELECT 1 FROM courses c
                           WHERE c.id = materials.course_id
                             AND c.user_id = nullif(current_setting('app.user_id', true), '')::uuid));

CREATE POLICY materials_admin ON materials
  FOR ALL TO app_admin
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------- facts
ALTER TABLE facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE facts FORCE  ROW LEVEL SECURITY;

-- Facts ride every prompt (§2e), which makes this table a prompt-injection
-- surface as much as a privacy one: a fact filed against another teacher's
-- course or class would be read back into her model context. Hence the scope
-- consistency in WITH CHECK — the referenced course and class must also be
-- hers, not merely exist.
CREATE POLICY facts_owner ON facts
  FOR ALL TO app_rw
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid
              AND (course_id IS NULL
                   OR EXISTS (SELECT 1 FROM courses c
                               WHERE c.id = facts.course_id
                                 AND c.user_id = nullif(current_setting('app.user_id', true), '')::uuid))
              AND (class_id IS NULL
                   OR EXISTS (SELECT 1 FROM classes k
                               WHERE k.id = facts.class_id
                                 AND k.user_id = nullif(current_setting('app.user_id', true), '')::uuid)));

CREATE POLICY facts_admin ON facts
  FOR ALL TO app_admin
  USING (true) WITH CHECK (true);

-- Same reason as courses_aggregate: leader_dashboard (004) joins facts, and
-- without this the join contributes nothing and the dashboard is empty.
CREATE POLICY facts_aggregate ON facts
  FOR SELECT TO app_owner
  USING (true);

-- ------------------------------------------------------- interaction_signals
ALTER TABLE interaction_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE interaction_signals FORCE  ROW LEVEL SECURITY;

CREATE POLICY interaction_signals_owner ON interaction_signals
  FOR ALL TO app_rw
  USING      (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

CREATE POLICY interaction_signals_admin ON interaction_signals
  FOR ALL TO app_admin
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------- scope_log
ALTER TABLE scope_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE scope_log FORCE  ROW LEVEL SECURITY;

-- scope_log.user_id is nullable because erasure NULLs it (ADR-0013 §11:
-- operational history survives, the person does not). app_rw is still required
-- to write its own id: an INSERT with a NULL user_id fails here rather than
-- quietly producing an unattributable row, and the nulling is app_admin's job
-- through scope_log_admin. A loud failure is the cheaper mistake.
CREATE POLICY scope_log_owner ON scope_log
  FOR ALL TO app_rw
  USING      (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

CREATE POLICY scope_log_admin ON scope_log
  FOR ALL TO app_admin
  USING (true) WITH CHECK (true);

-- ============================================================================
-- Part 3 lives in the application and cannot be written here. Every request:
--
--   BEGIN;
--     SET LOCAL app.user_id = '5b7c…';   -- LOCAL: dies with the transaction
--     SELECT * FROM courses;             -- her rows only, filter or no filter
--   COMMIT;
--
-- LOCAL, not SET: a plain SET outlives the transaction and, on a pooled
-- connection, hands the next teacher the previous teacher's identity. There is
-- no policy that can protect against that, which is why it is written here as
-- well as in DATABASE.md §2c.
--
-- app_leader appears in NO policy in this file, on purpose. A role with no
-- applicable policy on an RLS-enabled table reads zero rows even if someone
-- later grants it SELECT by mistake — so 004's "the view and nothing else" has
-- a second lock behind it.
-- ============================================================================

COMMIT;

-- No SQL inside these messages: psql meta-command arguments use their own
-- quoting rules (backslash-escape, not SQL doubling). The queries live in
-- README.md, section "Verify that RLS is real".
\echo '003_rls.sql applied. Do not trust it yet.'
\echo 'Run README.md steps 1 to 5 — as app_rw, never as postgres, because a superuser'
\echo 'ignores row-level security and every check will pass while showing every row.'
\echo 'Step 2 is the one that catches the silent failure: pg_class.relforcerowsecurity'
\echo 'must be true on all ten tables. pg_tables.rowsecurity cannot tell you that.'
