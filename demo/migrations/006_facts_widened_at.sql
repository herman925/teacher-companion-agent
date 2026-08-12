-- 006_facts_widened_at.sql — WHEN a fact was widened, not only that it was
-- Source of truth: docs/DATABASE.md v0.2 §2e · ADR-0011 §1 (the widening ladder).
--
-- WHY THIS FILE EXISTS, in one paragraph, because a column is easy to add and
-- hard to justify.
--
-- 001 records that a fact was promoted: `source = 'widened'` says a human did
-- it, and `widened_from` says which rung it started on. It records no WHEN.
-- demo/src/memory-scopes.mjs — the pure module that decides what may sit at
-- class or teacher scope — treats the presence of `widened_at` as the proof
-- that a widening was a deliberate act （line 238: a fact may only claim
-- `source: 'teacher'` if this call is her tap OR the row carries the stamp）.
-- Without the stamp, a class fact she widened by hand is rewritten back down to
-- `'auto'` and clamped to `course` scope ON EVERY RELOAD, so the constraint she
-- promoted to 「这个班就是这样」 quietly stops riding the class band. Her
-- deliberate act, undone by a round trip through storage.
--
-- The store cannot invent the timestamp instead. Filling it from `created_at`
-- would put a number in the record that is not true — 「the artifact is the
-- memory」 does not survive a store that writes plausible values into audit
-- columns. So the column is added, once, additively.
--
-- ADDITIVE AND IDEMPOTENT, unlike 001–005. A column that may already exist on
-- one box and not another is exactly the case IF NOT EXISTS is for, and there
-- is no data to half-apply: every existing row gets NULL, which reads as 「never
-- widened」 — true of every row written before this file, because no code path
-- had ever written a widened fact.
--
-- Apply as a superuser (`postgres`) after 005:
--
--   psql -v ON_ERROR_STOP=1 -d teacher_platform -f demo/migrations/006_facts_widened_at.sql
--
-- NO GRANT AND NO POLICY CHANGE ARE NEEDED, and that is worth stating rather
-- than leaving a reader to wonder: 002 grants SELECT/INSERT/UPDATE on `facts`
-- at TABLE level （not column level）, so the new column is covered by the
-- existing grant, and `facts_owner` / `facts_admin` / `facts_aggregate` in 003
-- are row predicates that no column can change. If a future migration ever
-- narrows those grants to a column list, this column must join the list.

\set ON_ERROR_STOP on

BEGIN;

SET search_path = public;

ALTER TABLE facts
  ADD COLUMN IF NOT EXISTS widened_at timestamptz;

COMMENT ON COLUMN facts.widened_at IS
  'When the teacher promoted this fact one rung (ADR-0011). NULL means never widened. Its PRESENCE is what memory-scopes.mjs reads as proof of a deliberate act, so it must be written by widenFact and by nothing else.';

-- The ledger 005 created. ON CONFLICT because this file is idempotent and a
-- second run must not fail on its own bookkeeping.
INSERT INTO schema_migrations (filename, applied_by)
VALUES ('006_facts_widened_at.sql', current_user)
ON CONFLICT (filename) DO NOTHING;

COMMIT;

\echo '006_facts_widened_at.sql applied. facts.widened_at exists.'
\echo 'Verify: SELECT column_name FROM information_schema.columns'
\echo "  WHERE table_name = 'facts' AND column_name = 'widened_at';"
\echo 'Until this file is applied, every facts query in pg-store fails with 42703 —'
\echo 'loudly, and on the memory read only, which is the safe direction for it to fail in.'
