-- 004_views.sql — leader_dashboard, and nothing else
-- Source of truth: docs/DATABASE.md v0.2 §2d · ADR-0013 §10.
--
-- Apply as a superuser (`postgres`) after 003.
--
-- A 园长 or 教研员 must be able to answer 「区里面的难点在哪里」 without ever
-- reading a named teacher's plan, her child evidence, or her photographs. The
-- mechanism is not a careful query — it is that app_leader is granted THE VIEW
-- AND NO BASE TABLE, so a mistaken leader query cannot reach a course row. A
-- promise that can be made honestly to a teacher in one sentence is worth more
-- than a promise that depends on nobody writing the wrong SELECT.

\set ON_ERROR_STOP on

BEGIN;

SET search_path = public;

-- `security_invoker = false` is the PostgreSQL default and is written out here
-- because this view DEPENDS on it. The view reads courses and facts with the
-- privileges and the row-level-security policies of its OWNER (app_owner, set
-- below), not of the leader running the query — which is the only reason a role
-- with zero base-table privileges can see an aggregate at all. Flip it to true
-- and the dashboard stops working entirely: app_leader has no rights on
-- courses. The policies that make the owner side work are courses_aggregate and
-- facts_aggregate in 003; delete either and this view returns zero rows without
-- error.
--
-- This owner-side policy resolution is the ONE thing in these four files that
-- cannot be checked by reading them: it depends on how PostgreSQL resolves RLS
-- through a view whose security_invoker is false, and it is written here from
-- the documented behaviour, not from a run against this database. Confirm it on
-- the box before telling anyone the dashboard works — README.md step 6
-- separates "empty because suppressed" from "empty because the owner policy is
-- missing", which otherwise look identical.
-- `security_barrier = true` is the second half, and it guards the SUPPRESSION
-- rather than the privileges. Without it PostgreSQL may push a leader-supplied
-- qualifier that mentions only grouping columns (stage, theme, constraint_kind)
-- BELOW the aggregate into the base scan, where it is evaluated against rows
-- the HAVING clause would have removed. A non-leakproof built-in in that
-- qualifier — `WHERE theme::integer > 0`, a division that can hit zero — then
-- turns into an error or a timing difference that reveals the existence and
-- rough shape of groups with fewer than five distinct courses. That is exactly
-- the small-cell re-identification the threshold exists to prevent: in a
-- district with three kindergartens, 「1 个课程卡在第二周」 identifies a person.
--
-- The blast radius is bounded already — 002's `REVOKE ALL ON DATABASE … FROM
-- PUBLIC` removes TEMP, so app_leader cannot define its own leaky function and
-- is limited to built-ins — but 「bounded」 is not 「closed」. The cost is some
-- lost optimisation on a view that aggregates a few thousand rows; the gain is
-- that no leader-supplied expression is ever evaluated against a suppressed row.
CREATE VIEW leader_dashboard WITH (security_invoker = false, security_barrier = true) AS
  SELECT c.course_state->>'stage'                    AS stage,
         c.course_state->'theme_resource'->>'name'   AS theme,
         f.kind                                      AS constraint_kind,
         count(*)                                    AS n
    FROM courses c
    LEFT JOIN facts f ON f.course_id = c.id AND f.archived_at IS NULL
   GROUP BY 1, 2, 3
  -- Small cells re-identify: in a district with three kindergartens,
  -- 「1 个课程卡在第二周」 identifies a person.
  --
  -- §2d writes this suppression as `HAVING count(*) >= 5` alone. That is not
  -- enough, and the second condition is added here deliberately: count(*)
  -- counts JOINED ROWS, so one course carrying five equipment facts produces a
  -- group of five and passes the threshold on its own — publishing exactly the
  -- single-course row the threshold exists to suppress. count(DISTINCT c.id)
  -- counts courses, which is what 「5」 was always meant to mean.
  --
  -- This is strictly more suppressive than the documented view: it can only
  -- remove rows, never add them. DATABASE.md §2d should be updated to match.
  HAVING count(*) >= 5 AND count(DISTINCT c.id) >= 5;

-- Ownership is load-bearing, not tidiness. Created by the superuser, the view
-- would run AS the superuser — bypassing row-level security altogether,
-- including FORCE, and making 003 irrelevant to everything read through here.
-- Owned by app_owner (NOLOGIN), its reach is exactly the two SELECT-only
-- aggregate policies and can be audited in pg_policies.
ALTER VIEW leader_dashboard OWNER TO app_owner;

REVOKE ALL  ON leader_dashboard FROM PUBLIC;
GRANT SELECT ON leader_dashboard TO app_leader;

-- Granted to app_leader and to nobody else. What must stay absent, spelled out
-- so that adding it is a visible diff against a line that forbids it:
--
--   GRANT SELECT ON courses   TO app_leader;   -- never
--   GRANT SELECT ON messages  TO app_leader;   -- never
--   GRANT SELECT ON materials TO app_leader;   -- never
--   GRANT SELECT ON facts     TO app_leader;   -- never
--
-- Aggregates, never named content. A leader who needs a named plan asks the
-- teacher for it.

COMMIT;

\echo '004_views.sql applied. Verify as app_leader (not as postgres):'
\echo '  SELECT * FROM leader_dashboard;   -- must work'
\echo '  SELECT * FROM courses;            -- must fail: permission denied'
\echo 'See README.md, "Verify that RLS is real", step 5.'
